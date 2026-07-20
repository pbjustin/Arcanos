#!/usr/bin/env node
/**
 * Purpose: Assign the one approved Redis R2 image as a one-shot Gate R1 mutation.
 * Safety: The target and image are fixed, child diagnostics are suppressed, and
 * every post-invocation failure is ambiguous and never authorizes a retry.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';
import {
  GATE_R1_REDIS_ENVIRONMENT_ID,
  GATE_R1_REDIS_ENVIRONMENT_NAME,
  GATE_R1_REDIS_PROJECT_ID,
  GATE_R1_REDIS_PROJECT_NAME,
  GATE_R1_REDIS_SERVICE_ID
} from './gate-r1-redis-r2-config-patch.js';

export const GATE_R1_REDIS_IMAGE = 'redis:8.2.1';

const SOURCE_ACTIVATION_MESSAGE = 'gate-r: activate private redis replacement';
const SAFE_FAILURES = new Set([
  'GATE_R1_REDIS_SOURCE_ACTIVATION_AMBIGUOUS',
  'GATE_R1_REDIS_SOURCE_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R1_REDIS_SOURCE_ARGUMENT_INVALID',
  'GATE_R1_REDIS_SOURCE_CLI_UNAVAILABLE',
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

function decodeBounded(value, maximumBytes, failureCode) {
  if (!Buffer.isBuffer(value) || value.length > maximumBytes) fail(failureCode);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    fail(failureCode);
  }
}

export function assertGateR1RedisR2ExactLink({
  railwayExecutable,
  childEnvironment,
  timeoutMs = 30_000,
  spawn = spawnSync
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail('GATE_R1_REDIS_SOURCE_TARGET_TIMEOUT');
  }
  let child;
  try {
    child = spawn(railwayExecutable, ['status'], {
      env: childEnvironment,
      maxBuffer: 512,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true
    });
    if (child?.error?.code === 'ETIMEDOUT') fail('GATE_R1_REDIS_SOURCE_TARGET_TIMEOUT');
    if (child?.error || child?.status !== 0) fail('GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    const stderr = decodeBounded(child.stderr, 256, 'GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    const stdout = decodeBounded(child.stdout, 512, 'GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    if (stderr.length !== 0) fail('GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    const expected = [
      `Project: ${GATE_R1_REDIS_PROJECT_NAME}`,
      `Environment: ${GATE_R1_REDIS_ENVIRONMENT_NAME}`,
      'Service: None'
    ];
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    if (lines.length !== expected.length
        || lines.some((line, index) => line !== expected[index])) {
      fail('GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    }
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = message === 'GATE_R1_REDIS_SOURCE_TARGET_TIMEOUT'
      ? message
      : 'GATE_R1_REDIS_SOURCE_TARGET_MISMATCH';
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(child);
    child = null;
  }
}

export function buildGateR1RedisR2SourceActivation() {
  return Object.freeze({
    args: Object.freeze([
      'environment', 'edit',
      '-e', GATE_R1_REDIS_ENVIRONMENT_ID,
      '-m', SOURCE_ACTIVATION_MESSAGE,
      '--json'
    ]),
    message: SOURCE_ACTIVATION_MESSAGE,
    patchJson: JSON.stringify({
      services: {
        [GATE_R1_REDIS_SERVICE_ID]: {
          source: { image: GATE_R1_REDIS_IMAGE }
        }
      }
    })
  });
}

export function runGateR1RedisR2SourceActivation({
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync
} = {}) {
  let childEnvironment;
  try {
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R1_REDIS_SOURCE_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R1_REDIS_SOURCE_AMBIENT_TOKEN_FORBIDDEN');
  }

  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R1_REDIS_SOURCE_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R1_REDIS_SOURCE_CLI_UNAVAILABLE');
  }

  assertGateR1RedisR2ExactLink({
    railwayExecutable: executable,
    childEnvironment,
    spawn
  });

  const definition = buildGateR1RedisR2SourceActivation();
  const patchInput = Buffer.from(definition.patchJson, 'utf8');
  let sourceChild;
  try {
    sourceChild = spawn(executable, definition.args, {
      env: childEnvironment,
      input: patchInput,
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true
    });
    if (sourceChild?.error || sourceChild?.status !== 0) {
      fail('GATE_R1_REDIS_SOURCE_ACTIVATION_AMBIGUOUS');
    }
  } catch (error) {
    clearChildDiagnostics(error);
    throw new Error('GATE_R1_REDIS_SOURCE_ACTIVATION_AMBIGUOUS');
  } finally {
    clearChildDiagnostics(sourceChild);
    patchInput.fill(0);
    sourceChild = null;
  }

  return Object.freeze({
    code: 'GATE_R1_REDIS_SOURCE_ACTIVATION_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
    projectId: GATE_R1_REDIS_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: GATE_R1_REDIS_SERVICE_ID,
    status: 'PENDING_PROJECTION'
  });
}

export function parseGateR1RedisR2SourceActivationArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2
      || argv[0] !== '--operation' || argv[1] !== 'activate') {
    fail('GATE_R1_REDIS_SOURCE_ARGUMENT_INVALID');
  }
  return Object.freeze({ operation: 'activate' });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    parseGateR1RedisR2SourceActivationArgs(process.argv.slice(2));
    const result = runGateR1RedisR2SourceActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R1_REDIS_SOURCE_ACTIVATION_AMBIGUOUS';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
