#!/usr/bin/env node
/**
 * Purpose: Run the bounded, authenticated, non-data-mutating Redis readiness check approved for Gate R1.
 * Inputs/Outputs: Accepts one new replacement service ID and emits only fixed safe status metadata.
 * Safety: Uses exact project/environment targets, suppresses child output, and never receives credential values.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  GATE_R_ENVIRONMENT_ID,
  GATE_R_PROJECT_ID,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';

export { GATE_R_ENVIRONMENT_ID, GATE_R_PROJECT_ID };
export const GATE_R_REDIS_SERVICE_NAME = 'phase2e-redis-r2-20260718';

const QUARANTINED_SERVICE_IDS = new Set([
  'b7789306-8aef-4113-add5-02883a6cc087',
  '434fa5b4-b52c-4caf-aaba-e87c173bf10d'
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_FAILURES = Object.freeze({
  70: 'GATE_R_REDIS_READINESS_REMOTE_TARGET_MISMATCH',
  71: 'GATE_R_REDIS_READINESS_CREDENTIAL_CONFIGURATION_INVALID',
  72: 'GATE_R_REDIS_READINESS_CLIENT_UNAVAILABLE',
  73: 'GATE_R_REDIS_READINESS_TIMEOUT',
  74: 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED'
});
const FIXED_FAILURE_MESSAGES = new Set([
  ...Object.values(FIXED_FAILURES),
  'GATE_R_REDIS_READINESS_CLI_UNAVAILABLE'
]);

function assertTargets(projectId, environmentId, serviceId) {
  if (projectId !== GATE_R_PROJECT_ID || environmentId !== GATE_R_ENVIRONMENT_ID) {
    throw new Error('GATE_R_TARGET_MISMATCH');
  }
  if (!UUID_PATTERN.test(serviceId)) {
    throw new Error('GATE_R_REDIS_READINESS_SERVICE_INVALID');
  }
  if (QUARANTINED_SERVICE_IDS.has(serviceId)) {
    throw new Error('GATE_R_REDIS_READINESS_SERVICE_FORBIDDEN');
  }
}

export function resolveRedisRailwayExecutable(options) {
  try {
    return resolveRailwayExecutable(options);
  } catch {
    throw new Error('GATE_R_REDIS_READINESS_CLI_UNAVAILABLE');
  }
}

function clearBuffer(value) {
  if (Buffer.isBuffer(value)) {
    value.fill(0);
  }
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
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  clearBuffer(readOwnDataValue(value, 'stdout'));
  clearBuffer(readOwnDataValue(value, 'stderr'));
  const output = readOwnDataValue(value, 'output');
  if (Array.isArray(output)) {
    try {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(output))) {
        if (Object.hasOwn(descriptor, 'value')) {
          clearBuffer(descriptor.value);
        }
      }
    } catch {
      // Diagnostics are best-effort wiped and are never rendered.
    }
  }
  const nestedError = readOwnDataValue(value, 'error');
  if (nestedError && nestedError !== value) {
    clearChildDiagnostics(nestedError, seen);
  }
  const nestedCause = readOwnDataValue(value, 'cause');
  if (nestedCause && nestedCause !== value) {
    clearChildDiagnostics(nestedCause, seen);
  }
}

function fixedSpawnFailure(error) {
  const code = error && typeof error === 'object' ? readOwnDataValue(error, 'code') : undefined;
  if (code === 'ETIMEDOUT') {
    return 'GATE_R_REDIS_READINESS_TIMEOUT';
  }
  if (['EACCES', 'EINVAL', 'ENOENT'].includes(code)) {
    return 'GATE_R_REDIS_READINESS_CLI_UNAVAILABLE';
  }
  return 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED';
}

export function buildRedisReadinessInvocation({
  projectId = GATE_R_PROJECT_ID,
  environmentId = GATE_R_ENVIRONMENT_ID,
  serviceId,
  railwayExecutable
}) {
  assertTargets(projectId, environmentId, serviceId);
  const executable = railwayExecutable ?? resolveRedisRailwayExecutable();
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('GATE_R_REDIS_READINESS_CLI_UNAVAILABLE');
  }

  const remoteCommand = [
    `test "${'${RAILWAY_PROJECT_ID:-}'}" = "${projectId}" || exit 70`,
    `test "${'${RAILWAY_ENVIRONMENT_ID:-}'}" = "${environmentId}" || exit 70`,
    `test "${'${RAILWAY_SERVICE_ID:-}'}" = "${serviceId}" || exit 70`,
    `test "${'${RAILWAY_SERVICE_NAME:-}'}" = "${GATE_R_REDIS_SERVICE_NAME}" || exit 70`,
    'test -n "${REDIS_PASSWORD:-}" || exit 71',
    'command -v timeout >/dev/null 2>&1 || exit 72',
    'command -v redis-cli >/dev/null 2>&1 || exit 72',
    'response="$(REDISCLI_AUTH="$REDIS_PASSWORD" timeout 15s redis-cli --raw -h 127.0.0.1 -p 6379 --no-auth-warning PING 2>/dev/null)"',
    'result=$?',
    'test "$result" -eq 124 && exit 73',
    'test "$result" -eq 0 || exit 74',
    'test "$response" = PONG || exit 74',
    'unset response',
    'exit 0'
  ].join('; ');

  return Object.freeze({
    args: Object.freeze([
      'ssh',
      '-p',
      projectId,
      '-e',
      environmentId,
      '-s',
      serviceId,
      'sh',
      '-lc',
      remoteCommand
    ]),
    file: executable,
    options: Object.freeze({
      shell: false,
      stdio: Object.freeze(['ignore', 'ignore', 'ignore']),
      timeout: 30_000,
      windowsHide: true
    })
  });
}

export function runRedisReadiness({
  projectId = GATE_R_PROJECT_ID,
  environmentId = GATE_R_ENVIRONMENT_ID,
  serviceId,
  railwayExecutable,
  spawn = spawnSync
}) {
  const invocation = buildRedisReadinessInvocation({
    projectId,
    environmentId,
    serviceId,
    railwayExecutable
  });
  let child;

  try {
    child = spawn(invocation.file, invocation.args, invocation.options);
    if (child?.error) {
      throw new Error(fixedSpawnFailure(child.error));
    }
    if (child?.status !== 0) {
      throw new Error(FIXED_FAILURES[child?.status] ?? 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED');
    }
  } catch (error) {
    const message = error instanceof Error && FIXED_FAILURE_MESSAGES.has(error.message)
      ? error.message
      : fixedSpawnFailure(error);
    clearChildDiagnostics(error);
    throw new Error(message);
  } finally {
    clearChildDiagnostics(child);
    child = null;
  }

  return Object.freeze({
    code: 'GATE_R_REDIS_AUTHENTICATED_READINESS_PASSED',
    environmentId,
    projectId,
    serviceId,
    status: 'PASS'
  });
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--service-id' || typeof argv[1] !== 'string') {
    throw new Error('GATE_R_REDIS_READINESS_ARGUMENT_INVALID');
  }
  return { serviceId: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runRedisReadiness(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
