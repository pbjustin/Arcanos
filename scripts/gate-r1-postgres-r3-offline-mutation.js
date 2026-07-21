#!/usr/bin/env node
/**
 * Purpose: Perform one closed, offline-only PostgreSQL R3 preparation mutation.
 * Safety: The target, mount, variable names, and non-secret values are fixed. The
 * password is generated in memory, sent only through stdin, and wiped best-effort.
 */

import { randomFillSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';
import {
  GATE_R1_R3_ENVIRONMENT_ID,
  GATE_R1_R3_ENVIRONMENT_NAME,
  GATE_R1_R3_POSTGRES_SERVICE_ID,
  GATE_R1_R3_PROJECT_ID,
  GATE_R1_R3_PROJECT_NAME
} from './gate-r1-postgres-r3-config-patch.js';

export const GATE_R1_R3_POSTGRES_VOLUME_MOUNT = '/var/lib/postgresql/data';
export const GATE_R1_R3_POSTGRES_VARIABLES = Object.freeze([
  'POSTGRES_USER=postgres',
  'POSTGRES_DB=railway',
  'PGDATA=/var/lib/postgresql/data/pgdata',
  'PGHOST=${{RAILWAY_PRIVATE_DOMAIN}}',
  'PGPORT=5432',
  'PGUSER=${{POSTGRES_USER}}',
  'PGPASSWORD=${{POSTGRES_PASSWORD}}',
  'PGDATABASE=${{POSTGRES_DB}}',
  'DATABASE_URL=postgresql://${{PGUSER}}:${{PGPASSWORD}}@${{PGHOST}}:${{PGPORT}}/${{PGDATABASE}}',
  'SSL_CERT_DAYS=3650',
  'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60'
]);

const BASE64URL_ALPHABET = Buffer.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  'ascii'
);
const OPERATIONS = Object.freeze({
  volume: Object.freeze({
    args: Object.freeze([
      'volume',
      '--service', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--environment', GATE_R1_R3_ENVIRONMENT_ID,
      'add',
      '--mount-path', GATE_R1_R3_POSTGRES_VOLUME_MOUNT,
      '--json'
    ]),
    acceptedCode: 'GATE_R1_R3_VOLUME_ACCEPTED_PENDING_PROJECTION',
    failureCode: 'GATE_R1_R3_VOLUME_MUTATION_AMBIGUOUS'
  }),
  credential: Object.freeze({
    args: Object.freeze([
      'variable', 'set',
      '--service', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--environment', GATE_R1_R3_ENVIRONMENT_ID,
      '--stdin',
      '--skip-deploys',
      '--json',
      'POSTGRES_PASSWORD'
    ]),
    acceptedCode: 'GATE_R1_R3_PASSWORD_ACCEPTED_PENDING_PROJECTION',
    failureCode: 'GATE_R1_R3_PASSWORD_MUTATION_AMBIGUOUS'
  }),
  variables: Object.freeze({
    args: Object.freeze([
      'variable', 'set',
      '--service', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--environment', GATE_R1_R3_ENVIRONMENT_ID,
      '--skip-deploys',
      '--json',
      ...GATE_R1_R3_POSTGRES_VARIABLES
    ]),
    acceptedCode: 'GATE_R1_R3_VARIABLES_ACCEPTED_PENDING_PROJECTION',
    failureCode: 'GATE_R1_R3_VARIABLES_MUTATION_AMBIGUOUS'
  })
});

const SAFE_FAILURES = new Set([
  'GATE_R1_R3_OFFLINE_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R1_R3_OFFLINE_ARGUMENT_INVALID',
  'GATE_R1_R3_OFFLINE_CLI_UNAVAILABLE',
  'GATE_R1_R3_OFFLINE_CREDENTIAL_GENERATION_FAILED',
  'GATE_R1_R3_OFFLINE_TARGET_MISMATCH',
  'GATE_R1_R3_OFFLINE_TIMEOUT',
  ...Object.values(OPERATIONS).map(({ failureCode }) => failureCode)
]);

function fail(code) {
  throw new Error(code);
}

function clearBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function clearChildDiagnostics(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  clearBuffer(value.stdout);
  clearBuffer(value.stderr);
  if (Array.isArray(value.output)) value.output.forEach(clearBuffer);
  if (value.error && value.error !== value) clearChildDiagnostics(value.error, seen);
  if (value.cause && value.cause !== value) clearChildDiagnostics(value.cause, seen);
}

function decodeBounded(value, maximumBytes, failureCode) {
  if (!Buffer.isBuffer(value) || value.length > maximumBytes) fail(failureCode);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    fail(failureCode);
  }
}

function parseStatus(child) {
  if (child?.error?.code === 'ETIMEDOUT') fail('GATE_R1_R3_OFFLINE_TIMEOUT');
  if (child?.error || child?.status !== 0) fail('GATE_R1_R3_OFFLINE_TARGET_MISMATCH');
  const stderr = decodeBounded(child.stderr, 256, 'GATE_R1_R3_OFFLINE_TARGET_MISMATCH');
  const stdout = decodeBounded(child.stdout, 512, 'GATE_R1_R3_OFFLINE_TARGET_MISMATCH');
  if (stderr.length !== 0) fail('GATE_R1_R3_OFFLINE_TARGET_MISMATCH');
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const expected = [
    `Project: ${GATE_R1_R3_PROJECT_NAME}`,
    `Environment: ${GATE_R1_R3_ENVIRONMENT_NAME}`,
    'Service: None'
  ];
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    fail('GATE_R1_R3_OFFLINE_TARGET_MISMATCH');
  }
}

export function encodeGateR1Base64Url(input) {
  if (!Buffer.isBuffer(input) || input.length !== 32) {
    fail('GATE_R1_R3_OFFLINE_CREDENTIAL_GENERATION_FAILED');
  }
  const output = Buffer.alloc(Math.ceil(input.length * 8 / 6));
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;

  for (const byte of input) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output[outputIndex] = BASE64URL_ALPHABET[(accumulator >> bits) & 0x3f];
      outputIndex += 1;
      accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    output[outputIndex] = BASE64URL_ALPHABET[(accumulator << (6 - bits)) & 0x3f];
  }
  return output;
}

export function buildGateR1PostgresR3OfflineInvocation(operation) {
  if (typeof operation !== 'string' || !Object.hasOwn(OPERATIONS, operation)) {
    fail('GATE_R1_R3_OFFLINE_ARGUMENT_INVALID');
  }
  const definition = OPERATIONS[operation];
  return Object.freeze({
    acceptedCode: definition.acceptedCode,
    args: definition.args,
    failureCode: definition.failureCode,
    operation
  });
}

function assertMutationResult(child, failureCode) {
  if (child?.error?.code === 'ETIMEDOUT') fail('GATE_R1_R3_OFFLINE_TIMEOUT');
  if (child?.error || child?.status !== 0) fail(failureCode);
}

export function runGateR1PostgresR3OfflineMutation({
  operation,
  railwayExecutable,
  environment = process.env,
  randomFill = randomFillSync,
  spawn = spawnSync
}) {
  const definition = buildGateR1PostgresR3OfflineInvocation(operation);
  let childEnvironment;
  try {
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R1_R3_OFFLINE_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R1_R3_OFFLINE_AMBIENT_TOKEN_FORBIDDEN');
  }

  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R1_R3_OFFLINE_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R1_R3_OFFLINE_CLI_UNAVAILABLE');
  }

  let statusChild;
  let mutationChild;
  let entropy;
  let credentialInput;
  try {
    statusChild = spawn(executable, ['status'], {
      env: childEnvironment,
      maxBuffer: 512,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    parseStatus(statusChild);

    const mutationOptions = {
      env: childEnvironment,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true
    };
    if (operation === 'credential') {
      entropy = Buffer.alloc(32);
      try {
        randomFill(entropy);
        credentialInput = encodeGateR1Base64Url(entropy);
      } catch {
        fail('GATE_R1_R3_OFFLINE_CREDENTIAL_GENERATION_FAILED');
      }
      mutationOptions.input = credentialInput;
      mutationOptions.stdio = ['pipe', 'ignore', 'ignore'];
    }

    mutationChild = spawn(executable, definition.args, mutationOptions);
    assertMutationResult(mutationChild, definition.failureCode);
  } catch (error) {
    const code = error instanceof Error && SAFE_FAILURES.has(error.message)
      ? error.message
      : error?.code === 'ETIMEDOUT'
        ? 'GATE_R1_R3_OFFLINE_TIMEOUT'
        : definition.failureCode;
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(statusChild);
    clearChildDiagnostics(mutationChild);
    clearBuffer(entropy);
    clearBuffer(credentialInput);
    statusChild = null;
    mutationChild = null;
    entropy = null;
    credentialInput = null;
  }

  return Object.freeze({
    code: definition.acceptedCode,
    environmentId: GATE_R1_R3_ENVIRONMENT_ID,
    operation,
    projectId: GATE_R1_R3_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
    status: 'PENDING_PROJECTION'
  });
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--operation') {
    fail('GATE_R1_R3_OFFLINE_ARGUMENT_INVALID');
  }
  buildGateR1PostgresR3OfflineInvocation(argv[1]);
  return { operation: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runGateR1PostgresR3OfflineMutation(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && SAFE_FAILURES.has(error.message)
      ? error.message
      : 'GATE_R1_R3_OFFLINE_MUTATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
