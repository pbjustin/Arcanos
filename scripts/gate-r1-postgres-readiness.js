#!/usr/bin/env node
/**
 * Purpose: Run the bounded, authenticated, non-SQL PostgreSQL readiness check approved for Gate R1.
 * Inputs/Outputs: Accepts one new replacement service ID and emits only fixed safe status metadata.
 * Safety: Uses exact project/environment targets, suppresses child output, and never receives credential values.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GATE_R_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R_POSTGRES_SERVICE_NAME = 'phase2e-postgres-r2-20260718';

const QUARANTINED_SERVICE_IDS = new Set([
  'b7789306-8aef-4113-add5-02883a6cc087',
  '434fa5b4-b52c-4caf-aaba-e87c173bf10d'
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertTargets(projectId, environmentId, serviceId) {
  if (projectId !== GATE_R_PROJECT_ID || environmentId !== GATE_R_ENVIRONMENT_ID) {
    throw new Error('GATE_R_TARGET_MISMATCH');
  }
  if (!UUID_PATTERN.test(serviceId)) {
    throw new Error('GATE_R_POSTGRES_READINESS_SERVICE_INVALID');
  }
  if (QUARANTINED_SERVICE_IDS.has(serviceId)) {
    throw new Error('GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN');
  }
}

export function buildPostgresReadinessInvocation({
  projectId = GATE_R_PROJECT_ID,
  environmentId = GATE_R_ENVIRONMENT_ID,
  serviceId
}) {
  assertTargets(projectId, environmentId, serviceId);

  const remoteCommand = [
    'set -eu',
    `test "$RAILWAY_PROJECT_ID" = "${projectId}"`,
    `test "$RAILWAY_ENVIRONMENT_ID" = "${environmentId}"`,
    `test "$RAILWAY_SERVICE_ID" = "${serviceId}"`,
    `test "$RAILWAY_SERVICE_NAME" = "${GATE_R_POSTGRES_SERVICE_NAME}"`,
    'test -n "$POSTGRES_USER"',
    'test -n "$POSTGRES_PASSWORD"',
    'test -n "$POSTGRES_DB"',
    'PGCONNECT_TIMEOUT=10 PGPASSWORD="$POSTGRES_PASSWORD" timeout 15s psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="\\conninfo" >/dev/null 2>&1'
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
    file: 'railway',
    options: Object.freeze({ shell: false, stdio: 'ignore', timeout: 30_000, windowsHide: true })
  });
}

export function runPostgresReadiness({
  projectId = GATE_R_PROJECT_ID,
  environmentId = GATE_R_ENVIRONMENT_ID,
  serviceId,
  execFile = execFileSync
}) {
  const invocation = buildPostgresReadinessInvocation({ projectId, environmentId, serviceId });

  try {
    execFile(invocation.file, invocation.args, invocation.options);
  } catch {
    throw new Error('GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED');
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
    const message = error instanceof Error ? error.message : 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
