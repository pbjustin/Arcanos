#!/usr/bin/env node
/**
 * Purpose: Project the exact Redis R2 Railway deployment status without mutation.
 * Safety: The link and service are fixed, output is schema-locked and bounded, and
 * raw child diagnostics are wiped before returning a safe state category.
 */

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';
import {
  GATE_R1_REDIS_ENVIRONMENT_ID,
  GATE_R1_REDIS_PROJECT_ID,
  GATE_R1_REDIS_SERVICE_ID,
  GATE_R1_REDIS_SERVICE_NAME
} from './gate-r1-redis-r2-config-patch.js';
import { assertGateR1RedisR2ExactLink } from './gate-r1-redis-r2-source-activation.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PENDING_STATUSES = new Set([
  'BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING'
]);
const TERMINAL_FAILURE_STATUSES = new Set([
  'CRASHED', 'FAILED', 'NEEDS_APPROVAL', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING'
]);
export const GATE_R1_REDIS_DEPLOYMENT_MAX_OBSERVATIONS = 120;
export const GATE_R1_REDIS_DEPLOYMENT_POLL_INTERVAL_MS = 5_000;
export const GATE_R1_REDIS_DEPLOYMENT_DEADLINE_MS = 600_000;
const SAFE_FAILURES = new Set([
  'GATE_R1_REDIS_DEPLOYMENT_STATUS_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID',
  'GATE_R1_REDIS_DEPLOYMENT_STATUS_CLI_UNAVAILABLE',
  'GATE_R1_REDIS_DEPLOYMENT_ID_MISMATCH',
  'GATE_R1_REDIS_DEPLOYMENT_NOT_SUCCESSFUL',
  'GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT',
  'GATE_R1_REDIS_DEPLOYMENT_STOPPED',
  'GATE_R1_REDIS_DEPLOYMENT_STATUS_QUERY_FAILED',
  'GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID',
  'GATE_R1_REDIS_DEPLOYMENT_TERMINAL_FAILURE',
  'GATE_R1_REDIS_DEPLOYMENT_STATUS_TIMEOUT',
  'GATE_R1_REDIS_SOURCE_TARGET_MISMATCH',
  'GATE_R1_REDIS_SOURCE_TARGET_TIMEOUT'
]);

function fail(code) {
  throw new Error(code);
}

function clearBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function readOwnDataValue(value, property) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function clearChildDiagnostics(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  clearBuffer(readOwnDataValue(value, 'stdout'));
  clearBuffer(readOwnDataValue(value, 'stderr'));
  const output = readOwnDataValue(value, 'output');
  if (Array.isArray(output)) {
    try {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(output))) {
        if (Object.hasOwn(descriptor, 'value')) clearBuffer(descriptor.value);
      }
    } catch {
      // Diagnostics are best-effort wiped and are never rendered.
    }
  }
  const nestedError = readOwnDataValue(value, 'error');
  if (nestedError && nestedError !== value) clearChildDiagnostics(nestedError, seen);
  const nestedCause = readOwnDataValue(value, 'cause');
  if (nestedCause && nestedCause !== value) clearChildDiagnostics(nestedCause, seen);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function decodeBounded(value, maximumBytes) {
  if (!Buffer.isBuffer(value) || value.length > maximumBytes) {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
  }
}

function sleepSynchronously(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function resolveReadTimeout(deadlineAt, now) {
  if (deadlineAt === undefined) return 30_000;
  const current = now();
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(current) || current >= deadlineAt) {
    fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
  }
  return Math.max(1, Math.min(30_000, Math.floor(deadlineAt - current)));
}

export function projectGateR1RedisR2DeploymentStatus(raw, { expectedDeploymentId } = {}) {
  if (!exactKeys(raw, ['id', 'name', 'deploymentId', 'status', 'stopped'])
      || raw.id !== GATE_R1_REDIS_SERVICE_ID
      || raw.name !== GATE_R1_REDIS_SERVICE_NAME
      || typeof raw.stopped !== 'boolean') {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
  }

  let stateCategory;
  if (raw.deploymentId === null && raw.status === null) {
    stateCategory = raw.stopped ? 'STOPPED' : 'NO_DEPLOYMENT';
  } else {
    if (typeof raw.deploymentId !== 'string' || !UUID_PATTERN.test(raw.deploymentId)
        || typeof raw.status !== 'string') {
      fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    }
    const knownStatus = raw.status === 'SUCCESS'
      || PENDING_STATUSES.has(raw.status)
      || TERMINAL_FAILURE_STATUSES.has(raw.status);
    if (!knownStatus) fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    if (raw.stopped) {
      stateCategory = 'STOPPED';
    } else if (raw.status === 'SUCCESS') {
      stateCategory = 'SUCCESS';
    } else if (PENDING_STATUSES.has(raw.status)) {
      stateCategory = 'PENDING';
    } else {
      stateCategory = 'TERMINAL_FAILURE';
    }
  }
  if (expectedDeploymentId !== undefined
      && (typeof expectedDeploymentId !== 'string'
        || !UUID_PATTERN.test(expectedDeploymentId)
        || raw.deploymentId !== expectedDeploymentId)) {
    fail('GATE_R1_REDIS_DEPLOYMENT_ID_MISMATCH');
  }

  return Object.freeze({
    code: 'GATE_R1_REDIS_DEPLOYMENT_STATUS_PROJECTED',
    deploymentId: raw.deploymentId,
    deploymentStatus: raw.status,
    environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
    projectId: GATE_R1_REDIS_PROJECT_ID,
    serviceId: GATE_R1_REDIS_SERVICE_ID,
    serviceName: GATE_R1_REDIS_SERVICE_NAME,
    stateCategory,
    status: 'PASS',
    stopped: raw.stopped
  });
}

export function runGateR1RedisR2DeploymentStatus({
  railwayExecutable,
  expectedDeploymentId,
  deadlineAt,
  environment = process.env,
  now = () => performance.now(),
  spawn = spawnSync
} = {}) {
  if (typeof now !== 'function') fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
  let childEnvironment;
  try {
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R1_REDIS_DEPLOYMENT_STATUS_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_AMBIENT_TOKEN_FORBIDDEN');
  }

  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_CLI_UNAVAILABLE');
  }

  assertGateR1RedisR2ExactLink({
    railwayExecutable: executable,
    childEnvironment,
    timeoutMs: resolveReadTimeout(deadlineAt, now),
    spawn
  });

  let child;
  try {
    child = spawn(executable, [
      'service', 'status',
      '-s', GATE_R1_REDIS_SERVICE_ID,
      '-e', GATE_R1_REDIS_ENVIRONMENT_ID,
      '--json'
    ], {
      env: childEnvironment,
      maxBuffer: 1024,
      shell: false,
      timeout: resolveReadTimeout(deadlineAt, now),
      windowsHide: true
    });
    if (child?.error?.code === 'ETIMEDOUT') fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_TIMEOUT');
    if (child?.error || child?.status !== 0) fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_QUERY_FAILED');
    const stderr = decodeBounded(child.stderr, 256);
    const stdout = decodeBounded(child.stdout, 1024);
    if (stderr.length !== 0) fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    let raw;
    try {
      raw = JSON.parse(stdout);
    } catch {
      fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    }
    return projectGateR1RedisR2DeploymentStatus(raw, { expectedDeploymentId });
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R1_REDIS_DEPLOYMENT_STATUS_QUERY_FAILED';
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(child);
    child = null;
  }
}

export function waitForGateR1RedisR2Deployment({
  readStatus = (expectedDeploymentId, timing) => runGateR1RedisR2DeploymentStatus({
    expectedDeploymentId,
    ...timing
  }),
  now = () => performance.now(),
  sleep = sleepSynchronously
} = {}) {
  if (typeof readStatus !== 'function' || typeof now !== 'function'
      || typeof sleep !== 'function') {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
  }

  const startedAt = now();
  if (!Number.isFinite(startedAt)) fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
  const deadlineAt = startedAt + GATE_R1_REDIS_DEPLOYMENT_DEADLINE_MS;
  let expectedDeploymentId;
  for (let observation = 1;
    observation <= GATE_R1_REDIS_DEPLOYMENT_MAX_OBSERVATIONS;
    observation += 1) {
    if (now() >= deadlineAt) fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
    let result;
    try {
      result = readStatus(expectedDeploymentId, { deadlineAt, now });
    } catch (error) {
      if (now() >= deadlineAt) fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
      throw error;
    }
    const observedAt = now();
    if (!Number.isFinite(observedAt) || observedAt >= deadlineAt) {
      fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
    }
    if (!exactKeys(result, [
      'code', 'deploymentId', 'deploymentStatus', 'environmentId', 'projectId',
      'serviceId', 'serviceName', 'stateCategory', 'status', 'stopped'
    ])
        || result.code !== 'GATE_R1_REDIS_DEPLOYMENT_STATUS_PROJECTED'
        || result.environmentId !== GATE_R1_REDIS_ENVIRONMENT_ID
        || result.projectId !== GATE_R1_REDIS_PROJECT_ID
        || result.serviceId !== GATE_R1_REDIS_SERVICE_ID
        || result.serviceName !== GATE_R1_REDIS_SERVICE_NAME
        || result.status !== 'PASS') {
      fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    }

    if (result.stopped) fail('GATE_R1_REDIS_DEPLOYMENT_STOPPED');
    if (expectedDeploymentId !== undefined && result.deploymentId === null) {
      fail('GATE_R1_REDIS_DEPLOYMENT_ID_MISMATCH');
    }
    if (result.deploymentId !== null) {
      if (expectedDeploymentId === undefined) {
        expectedDeploymentId = result.deploymentId;
      } else if (result.deploymentId !== expectedDeploymentId) {
        fail('GATE_R1_REDIS_DEPLOYMENT_ID_MISMATCH');
      }
    }

    if (result.stateCategory === 'SUCCESS') {
      if (expectedDeploymentId === undefined || result.stopped) {
        fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
      }
      return Object.freeze({
        code: 'GATE_R1_REDIS_DEPLOYMENT_SUCCEEDED',
        deploymentId: expectedDeploymentId,
        environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
        observations: observation,
        projectId: GATE_R1_REDIS_PROJECT_ID,
        serviceId: GATE_R1_REDIS_SERVICE_ID,
        status: 'PASS'
      });
    }
    if (result.stateCategory === 'TERMINAL_FAILURE') {
      fail('GATE_R1_REDIS_DEPLOYMENT_TERMINAL_FAILURE');
    }
    if (!['NO_DEPLOYMENT', 'PENDING'].includes(result.stateCategory)) {
      fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    }
    if (observation === GATE_R1_REDIS_DEPLOYMENT_MAX_OBSERVATIONS) {
      fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
    }
    if (observedAt + GATE_R1_REDIS_DEPLOYMENT_POLL_INTERVAL_MS >= deadlineAt) {
      fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
    }
    sleep(GATE_R1_REDIS_DEPLOYMENT_POLL_INTERVAL_MS);
  }
  fail('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
}

export function requireGateR1RedisR2DeploymentSuccess({
  deploymentId,
  readStatus = expectedDeploymentId => runGateR1RedisR2DeploymentStatus({
    expectedDeploymentId
  })
} = {}) {
  if (typeof deploymentId !== 'string' || !UUID_PATTERN.test(deploymentId)
      || typeof readStatus !== 'function') {
    fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
  }
  const result = readStatus(deploymentId);
  if (result.stateCategory !== 'SUCCESS' || result.stopped
      || result.deploymentId !== deploymentId) {
    fail('GATE_R1_REDIS_DEPLOYMENT_NOT_SUCCESSFUL');
  }
  return result;
}

export function parseGateR1RedisR2DeploymentStatusArgs(argv) {
  if (Array.isArray(argv) && argv.length === 2
      && argv[0] === '--service-id' && argv[1] === GATE_R1_REDIS_SERVICE_ID) {
    return Object.freeze({
      deploymentId: undefined,
      operation: 'read',
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });
  }
  if (Array.isArray(argv) && argv.length === 4
      && argv[0] === '--operation' && argv[1] === 'wait'
      && argv[2] === '--service-id' && argv[3] === GATE_R1_REDIS_SERVICE_ID) {
    return Object.freeze({
      deploymentId: undefined,
      operation: 'wait',
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });
  }
  if (Array.isArray(argv) && argv.length === 6
      && argv[0] === '--operation' && argv[1] === 'verify-success'
      && argv[2] === '--service-id' && argv[3] === GATE_R1_REDIS_SERVICE_ID
      && argv[4] === '--deployment-id' && UUID_PATTERN.test(argv[5])) {
    return Object.freeze({
      deploymentId: argv[5],
      operation: 'verify-success',
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });
  }
  fail('GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const args = parseGateR1RedisR2DeploymentStatusArgs(process.argv.slice(2));
    let result;
    if (args.operation === 'wait') {
      result = waitForGateR1RedisR2Deployment();
    } else if (args.operation === 'verify-success') {
      result = requireGateR1RedisR2DeploymentSuccess({ deploymentId: args.deploymentId });
    } else {
      result = runGateR1RedisR2DeploymentStatus();
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R1_REDIS_DEPLOYMENT_STATUS_QUERY_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
