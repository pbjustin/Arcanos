#!/usr/bin/env node
/**
 * Purpose: Apply one fixed PostgreSQL R3 Railway environment patch after an exact-link check.
 * Safety: Accepts only the R3B1 service-configuration profile, sends a bounded
 * constant patch through stdin,
 * suppresses child diagnostics, and emits only fixed non-sensitive status metadata.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';

export const GATE_R1_R3_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R1_R3_PROJECT_NAME = 'Arcanos';
export const GATE_R1_R3_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R1_R3_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
export const GATE_R1_R3_POSTGRES_SERVICE_ID = '7346b3f6-bf3d-46e1-9d66-79f10847ef89';

const PROFILES = Object.freeze({
  'service-configuration': Object.freeze({
    message: 'gate-r3: configure private postgres replacement',
    patch: Object.freeze({
      services: Object.freeze({
        [GATE_R1_R3_POSTGRES_SERVICE_ID]: Object.freeze({
          deploy: Object.freeze({
            restartPolicyType: 'ON_FAILURE',
            restartPolicyMaxRetries: 3
          })
        })
      })
    })
  })
});

const SAFE_FAILURES = new Set([
  'GATE_R1_R3_CONFIG_ARGUMENT_INVALID',
  'GATE_R1_R3_CONFIG_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R1_R3_CONFIG_CLI_UNAVAILABLE',
  'GATE_R1_R3_CONFIG_PATCH_FAILED',
  'GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID',
  'GATE_R1_R3_CONFIG_TARGET_MISMATCH',
  'GATE_R1_R3_CONFIG_TIMEOUT'
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

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseStatus(child) {
  if (child?.error || child?.status !== 0) fail('GATE_R1_R3_CONFIG_TARGET_MISMATCH');
  const stderr = decodeBounded(child.stderr, 256, 'GATE_R1_R3_CONFIG_TARGET_MISMATCH');
  const stdout = decodeBounded(child.stdout, 512, 'GATE_R1_R3_CONFIG_TARGET_MISMATCH');
  if (stderr.length !== 0) fail('GATE_R1_R3_CONFIG_TARGET_MISMATCH');
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const expected = [
    `Project: ${GATE_R1_R3_PROJECT_NAME}`,
    `Environment: ${GATE_R1_R3_ENVIRONMENT_NAME}`,
    'Service: None'
  ];
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    fail('GATE_R1_R3_CONFIG_TARGET_MISMATCH');
  }
}

function parsePatchResult(child, message) {
  if (child?.error || child?.status !== 0) fail('GATE_R1_R3_CONFIG_PATCH_FAILED');
  const stderr = decodeBounded(child.stderr, 256, 'GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
  const stdout = decodeBounded(child.stdout, 4096, 'GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
  if (stderr.length !== 0) fail('GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail('GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
  let result;
  try {
    result = JSON.parse(lines.at(-1));
  } catch {
    fail('GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
  }
  if (!exactKeys(result, ['committed', 'environmentId', 'environmentName', 'message', 'staged'])
      || result.committed !== true || result.staged !== true
      || result.environmentId !== GATE_R1_R3_ENVIRONMENT_ID
      || result.environmentName !== GATE_R1_R3_ENVIRONMENT_NAME
      || result.message !== message) {
    fail('GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
  }
}

export function buildGateR1PostgresR3Patch(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
    fail('GATE_R1_R3_CONFIG_ARGUMENT_INVALID');
  }
  const definition = PROFILES[profile];
  return Object.freeze({
    message: definition.message,
    patchJson: JSON.stringify(definition.patch),
    profile
  });
}

export function runGateR1PostgresR3ConfigPatch({
  profile,
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync
}) {
  const definition = buildGateR1PostgresR3Patch(profile);
  let childEnvironment;
  try {
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R1_R3_CONFIG_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R1_R3_CONFIG_AMBIENT_TOKEN_FORBIDDEN');
  }
  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R1_R3_CONFIG_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R1_R3_CONFIG_CLI_UNAVAILABLE');
  }

  let statusChild;
  let patchChild;
  const patchInput = Buffer.from(definition.patchJson, 'utf8');
  try {
    statusChild = spawn(executable, ['status'], {
      env: childEnvironment,
      maxBuffer: 512,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    if (statusChild?.error?.code === 'ETIMEDOUT') fail('GATE_R1_R3_CONFIG_TIMEOUT');
    parseStatus(statusChild);
    patchChild = spawn(executable, [
      'environment', 'edit',
      '-e', GATE_R1_R3_ENVIRONMENT_ID,
      '-m', definition.message,
      '--json'
    ], {
      env: childEnvironment,
      input: patchInput,
      maxBuffer: 4096,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    if (patchChild?.error?.code === 'ETIMEDOUT') fail('GATE_R1_R3_CONFIG_TIMEOUT');
    parsePatchResult(patchChild, definition.message);
  } catch (error) {
    const code = error instanceof Error && SAFE_FAILURES.has(error.message)
      ? error.message
      : error?.code === 'ETIMEDOUT'
        ? 'GATE_R1_R3_CONFIG_TIMEOUT'
        : 'GATE_R1_R3_CONFIG_PATCH_FAILED';
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(statusChild);
    clearChildDiagnostics(patchChild);
    patchInput.fill(0);
    statusChild = null;
    patchChild = null;
  }

  return Object.freeze({
    code: 'GATE_R1_R3_CONFIG_PATCH_COMMITTED',
    environmentId: GATE_R1_R3_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R1_R3_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
    status: 'PENDING_PROJECTION'
  });
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--profile') {
    fail('GATE_R1_R3_CONFIG_ARGUMENT_INVALID');
  }
  buildGateR1PostgresR3Patch(argv[1]);
  return { profile: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runGateR1PostgresR3ConfigPatch(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && SAFE_FAILURES.has(error.message)
      ? error.message
      : 'GATE_R1_R3_CONFIG_PATCH_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
