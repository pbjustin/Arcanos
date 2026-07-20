#!/usr/bin/env node
/**
 * Purpose: Run the bounded, authenticated, non-SQL PostgreSQL readiness check approved for Gate R1.
 * Inputs/Outputs: Accepts one new replacement service ID and emits only fixed safe status metadata.
 * Safety: Uses exact project/environment targets, suppresses child output, and never receives credential values.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as windowsPath } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GATE_R_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R_POSTGRES_SERVICE_ID = '7346b3f6-bf3d-46e1-9d66-79f10847ef89';
export const GATE_R_POSTGRES_SERVICE_NAME = 'phase2e-postgres-r3-20260720';
export const GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES = Object.freeze([
  'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN',
  'RAILWAY_TOKEN',
  'RAILWAY_API_TOKEN',
  'RAILWAY_PROJECT_TOKEN'
]);
export const GATE_R_ALLOWED_RAILWAY_CHILD_VARIABLES = Object.freeze([
  'APPDATA',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME'
]);

const FORBIDDEN_RAILWAY_TOKEN_NAMES = new Set(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES);
const ALLOWED_RAILWAY_CHILD_NAMES = new Set(GATE_R_ALLOWED_RAILWAY_CHILD_VARIABLES);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_FAILURES = Object.freeze({
  70: 'GATE_R_POSTGRES_READINESS_REMOTE_TARGET_MISMATCH',
  71: 'GATE_R_POSTGRES_READINESS_CREDENTIAL_CONFIGURATION_INVALID',
  72: 'GATE_R_POSTGRES_READINESS_CLIENT_UNAVAILABLE',
  73: 'GATE_R_POSTGRES_READINESS_TIMEOUT',
  74: 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED'
});
const FIXED_FAILURE_MESSAGES = new Set([
  ...Object.values(FIXED_FAILURES),
  'GATE_R_POSTGRES_READINESS_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE'
]);

export function buildSanitizedRailwayChildEnvironment(
  environment = process.env,
  failureCode = 'GATE_R_POSTGRES_READINESS_AMBIENT_TOKEN_FORBIDDEN'
) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error(failureCode);
  }

  const childEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    if (FORBIDDEN_RAILWAY_TOKEN_NAMES.has(name.toUpperCase())) {
      if (typeof value === 'string' && value.trim().length > 0) {
        throw new Error(failureCode);
      }
      continue;
    }
    if (ALLOWED_RAILWAY_CHILD_NAMES.has(name.toUpperCase()) && typeof value === 'string') {
      childEnvironment[name] = value;
    }
  }
  return childEnvironment;
}

function assertTargets(projectId, environmentId, serviceId) {
  if (projectId !== GATE_R_PROJECT_ID || environmentId !== GATE_R_ENVIRONMENT_ID) {
    throw new Error('GATE_R_TARGET_MISMATCH');
  }
  if (!UUID_PATTERN.test(serviceId)) {
    throw new Error('GATE_R_POSTGRES_READINESS_SERVICE_INVALID');
  }
  if (serviceId !== GATE_R_POSTGRES_SERVICE_ID) {
    throw new Error('GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN');
  }
}

export function resolveRailwayExecutable({
  platform = process.platform,
  pathValue = process.env.PATH,
  exists = existsSync
} = {}) {
  if (platform !== 'win32') {
    return 'railway';
  }
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    throw new Error('GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE');
  }

  for (const entry of pathValue.split(';').filter(Boolean)) {
    const directExecutable = windowsPath.join(entry, 'railway.exe');
    if (exists(directExecutable)) {
      return directExecutable;
    }

    const commandShim = windowsPath.join(entry, 'railway.cmd');
    const powershellShim = windowsPath.join(entry, 'railway.ps1');
    if (exists(commandShim) || exists(powershellShim)) {
      const packageExecutable = windowsPath.join(
        entry,
        'node_modules',
        '@railway',
        'cli',
        'bin',
        'railway.exe'
      );
      if (exists(packageExecutable)) {
        return packageExecutable;
      }
    }
  }

  throw new Error('GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE');
}

function clearBuffer(value) {
  if (Buffer.isBuffer(value)) {
    value.fill(0);
  }
}

function clearChildDiagnostics(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  clearBuffer(value.stdout);
  clearBuffer(value.stderr);
  if (Array.isArray(value.output)) {
    value.output.forEach(clearBuffer);
  }
  if (value.error && value.error !== value) {
    clearChildDiagnostics(value.error, seen);
  }
  if (value.cause && value.cause !== value) {
    clearChildDiagnostics(value.cause, seen);
  }
}

function fixedSpawnFailure(error) {
  if (error?.code === 'ETIMEDOUT') {
    return 'GATE_R_POSTGRES_READINESS_TIMEOUT';
  }
  if (['EACCES', 'EINVAL', 'ENOENT'].includes(error?.code)) {
    return 'GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE';
  }
  return 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED';
}

export function buildPostgresReadinessInvocation({
  projectId = GATE_R_PROJECT_ID,
  environmentId = GATE_R_ENVIRONMENT_ID,
  serviceId,
  railwayExecutable,
  environment = process.env
}) {
  assertTargets(projectId, environmentId, serviceId);
  const childEnvironment = buildSanitizedRailwayChildEnvironment(environment);
  const executable = railwayExecutable ?? resolveRailwayExecutable();
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE');
  }

  const remoteCommand = [
    `test "${'${RAILWAY_PROJECT_ID:-}'}" = "${projectId}" || exit 70`,
    `test "${'${RAILWAY_ENVIRONMENT_ID:-}'}" = "${environmentId}" || exit 70`,
    `test "${'${RAILWAY_SERVICE_ID:-}'}" = "${serviceId}" || exit 70`,
    `test "${'${RAILWAY_SERVICE_NAME:-}'}" = "${GATE_R_POSTGRES_SERVICE_NAME}" || exit 70`,
    'test -n "${POSTGRES_USER:-}" || exit 71',
    'test -n "${POSTGRES_PASSWORD:-}" || exit 71',
    'test -n "${POSTGRES_DB:-}" || exit 71',
    'command -v timeout >/dev/null 2>&1 || exit 72',
    'command -v psql >/dev/null 2>&1 || exit 72',
    'PGCONNECT_TIMEOUT=10 PGPASSWORD="$POSTGRES_PASSWORD" timeout 15s psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="\\conninfo" >/dev/null 2>&1',
    'result=$?',
    'test "$result" -eq 0 && exit 0',
    'test "$result" -eq 124 && exit 73',
    'exit 74'
  ].join('; ');

  // Railway CLI 4.30.2 joins trailing arguments and supplies the outer `sh -c`.
  // Keep the complete remote command as one argument so its target checks stay intact.
  return Object.freeze({
    args: Object.freeze([
      'ssh',
      '-p',
      projectId,
      '-e',
      environmentId,
      '-s',
      serviceId,
      remoteCommand
    ]),
    file: executable,
    options: Object.freeze({
      env: Object.freeze(childEnvironment),
      shell: false,
      stdio: Object.freeze(['ignore', 'ignore', 'ignore']),
      timeout: 30_000,
      windowsHide: true
    })
  });
}

export function runPostgresReadiness({
  projectId = GATE_R_PROJECT_ID,
  environmentId = GATE_R_ENVIRONMENT_ID,
  serviceId,
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync
}) {
  const invocation = buildPostgresReadinessInvocation({
    projectId,
    environmentId,
    serviceId,
    railwayExecutable,
    environment
  });
  let child;

  try {
    child = spawn(invocation.file, invocation.args, invocation.options);
    if (child?.error) {
      throw new Error(fixedSpawnFailure(child.error));
    }
    if (child?.status !== 0) {
      throw new Error(FIXED_FAILURES[child?.status] ?? 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED');
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
    code: 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_PASSED',
    environmentId,
    projectId,
    serviceId,
    status: 'PASS'
  });
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--service-id' || typeof argv[1] !== 'string') {
    throw new Error('GATE_R_POSTGRES_READINESS_ARGUMENT_INVALID');
  }
  return { serviceId: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runPostgresReadiness(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const allowedMainFailures = new Set([
      ...FIXED_FAILURE_MESSAGES,
      'GATE_R_POSTGRES_READINESS_ARGUMENT_INVALID',
      'GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN',
      'GATE_R_POSTGRES_READINESS_SERVICE_INVALID',
      'GATE_R_TARGET_MISMATCH'
    ]);
    const message = error instanceof Error && allowedMainFailures.has(error.message)
      ? error.message
      : 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
