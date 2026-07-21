#!/usr/bin/env node
/**
 * Purpose: Assign the one approved PostgreSQL R3 image as a one-shot Gate R1 mutation.
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
  GATE_R1_R3_ENVIRONMENT_ID,
  GATE_R1_R3_ENVIRONMENT_NAME,
  GATE_R1_R3_POSTGRES_SERVICE_ID,
  GATE_R1_R3_PROJECT_ID,
  GATE_R1_R3_PROJECT_NAME
} from './gate-r1-postgres-r3-config-patch.js';

export const GATE_R1_R3_POSTGRES_IMAGE = 'ghcr.io/railwayapp-templates/postgres-ssl:18.4';

const SOURCE_ACTIVATION_MESSAGE = 'gate-r3: activate private postgres replacement';
const SAFE_FAILURES = new Set([
  'GATE_R1_R3_SOURCE_ACTIVATION_AMBIGUOUS',
  'GATE_R1_R3_SOURCE_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R1_R3_SOURCE_ARGUMENT_INVALID',
  'GATE_R1_R3_SOURCE_CLI_UNAVAILABLE',
  'GATE_R1_R3_SOURCE_TARGET_MISMATCH',
  'GATE_R1_R3_SOURCE_TARGET_TIMEOUT'
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

export function assertGateR1PostgresR3ExactLink({
  railwayExecutable,
  childEnvironment,
  timeoutMs = 30_000,
  spawn = spawnSync
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail('GATE_R1_R3_SOURCE_TARGET_TIMEOUT');
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
    if (child?.error?.code === 'ETIMEDOUT') {
      fail('GATE_R1_R3_SOURCE_TARGET_TIMEOUT');
    }
    if (child?.error || child?.status !== 0) {
      fail('GATE_R1_R3_SOURCE_TARGET_MISMATCH');
    }
    const stderr = decodeBounded(
      child.stderr,
      256,
      'GATE_R1_R3_SOURCE_TARGET_MISMATCH'
    );
    const stdout = decodeBounded(
      child.stdout,
      512,
      'GATE_R1_R3_SOURCE_TARGET_MISMATCH'
    );
    if (stderr.length !== 0) fail('GATE_R1_R3_SOURCE_TARGET_MISMATCH');
    const expected = [
      `Project: ${GATE_R1_R3_PROJECT_NAME}`,
      `Environment: ${GATE_R1_R3_ENVIRONMENT_NAME}`,
      'Service: None'
    ];
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    if (lines.length !== expected.length
        || lines.some((line, index) => line !== expected[index])) {
      fail('GATE_R1_R3_SOURCE_TARGET_MISMATCH');
    }
  } catch (error) {
    const code = error instanceof Error && error.message === 'GATE_R1_R3_SOURCE_TARGET_TIMEOUT'
      ? error.message
      : 'GATE_R1_R3_SOURCE_TARGET_MISMATCH';
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(child);
    child = null;
  }
}

export function buildGateR1PostgresR3SourceActivation() {
  return Object.freeze({
    args: Object.freeze([
      'environment', 'edit',
      '-e', GATE_R1_R3_ENVIRONMENT_ID,
      '-m', SOURCE_ACTIVATION_MESSAGE,
      '--json'
    ]),
    message: SOURCE_ACTIVATION_MESSAGE,
    patchJson: JSON.stringify({
      services: {
        [GATE_R1_R3_POSTGRES_SERVICE_ID]: {
          source: { image: GATE_R1_R3_POSTGRES_IMAGE }
        }
      }
    })
  });
}

export function runGateR1PostgresR3SourceActivation({
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync
} = {}) {
  let childEnvironment;
  try {
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R1_R3_SOURCE_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R1_R3_SOURCE_AMBIENT_TOKEN_FORBIDDEN');
  }

  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R1_R3_SOURCE_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R1_R3_SOURCE_CLI_UNAVAILABLE');
  }

  assertGateR1PostgresR3ExactLink({
    railwayExecutable: executable,
    childEnvironment,
    spawn
  });

  const definition = buildGateR1PostgresR3SourceActivation();
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
      fail('GATE_R1_R3_SOURCE_ACTIVATION_AMBIGUOUS');
    }
  } catch (error) {
    clearChildDiagnostics(error);
    throw new Error('GATE_R1_R3_SOURCE_ACTIVATION_AMBIGUOUS');
  } finally {
    clearChildDiagnostics(sourceChild);
    patchInput.fill(0);
    sourceChild = null;
  }

  return Object.freeze({
    code: 'GATE_R1_R3_SOURCE_ACTIVATION_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R1_R3_ENVIRONMENT_ID,
    projectId: GATE_R1_R3_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
    status: 'PENDING_PROJECTION'
  });
}

export function parseGateR1PostgresR3SourceActivationArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2
      || argv[0] !== '--operation' || argv[1] !== 'activate') {
    fail('GATE_R1_R3_SOURCE_ARGUMENT_INVALID');
  }
  return Object.freeze({ operation: 'activate' });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    parseGateR1PostgresR3SourceActivationArgs(process.argv.slice(2));
    const result = runGateR1PostgresR3SourceActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && SAFE_FAILURES.has(error.message)
      ? error.message
      : 'GATE_R1_R3_SOURCE_ACTIVATION_AMBIGUOUS';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
