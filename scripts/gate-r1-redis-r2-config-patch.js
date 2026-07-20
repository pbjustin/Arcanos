#!/usr/bin/env node
/**
 * Purpose: Apply the one fixed Redis R2 Railway configuration patch after an exact-link check.
 * Safety: Accepts only the offline service-configuration profile, sends a bounded
 * constant patch through stdin, suppresses child diagnostics, and emits only fixed metadata.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';

export const GATE_R1_REDIS_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R1_REDIS_PROJECT_NAME = 'Arcanos';
export const GATE_R1_REDIS_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R1_REDIS_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
export const GATE_R1_REDIS_SERVICE_ID = '1ac0bd56-50b3-49eb-954c-ea83515ec915';
export const GATE_R1_REDIS_SERVICE_NAME = 'phase2e-redis-r2-20260718';
export const GATE_R1_REDIS_START_COMMAND = '/bin/sh -c \'test "$RAILWAY_VOLUME_MOUNT_PATH" = /data && test -n "$REDIS_PASSWORD" && { [ ! -e /data/lost+found ] || rmdir /data/lost+found; } && exec docker-entrypoint.sh redis-server --requirepass "$REDIS_PASSWORD" --save 60 1 --dir /data\'';

const PROFILES = Object.freeze({
  'service-configuration': Object.freeze({
    message: 'gate-r: configure private redis replacement',
    patch: Object.freeze({
      services: Object.freeze({
        [GATE_R1_REDIS_SERVICE_ID]: Object.freeze({
          deploy: Object.freeze({
            startCommand: GATE_R1_REDIS_START_COMMAND,
            restartPolicyType: 'ON_FAILURE',
            restartPolicyMaxRetries: 3
          })
        })
      })
    })
  })
});

const SAFE_FAILURES = new Set([
  'GATE_R1_REDIS_CONFIG_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R1_REDIS_CONFIG_ARGUMENT_INVALID',
  'GATE_R1_REDIS_CONFIG_CLI_UNAVAILABLE',
  'GATE_R1_REDIS_CONFIG_PATCH_AMBIGUOUS',
  'GATE_R1_REDIS_CONFIG_TARGET_MISMATCH',
  'GATE_R1_REDIS_CONFIG_TIMEOUT'
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

function parseStatus(child) {
  if (child?.error || child?.status !== 0) fail('GATE_R1_REDIS_CONFIG_TARGET_MISMATCH');
  const stderr = decodeBounded(child.stderr, 256, 'GATE_R1_REDIS_CONFIG_TARGET_MISMATCH');
  const stdout = decodeBounded(child.stdout, 512, 'GATE_R1_REDIS_CONFIG_TARGET_MISMATCH');
  if (stderr.length !== 0) fail('GATE_R1_REDIS_CONFIG_TARGET_MISMATCH');
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const expected = [
    `Project: ${GATE_R1_REDIS_PROJECT_NAME}`,
    `Environment: ${GATE_R1_REDIS_ENVIRONMENT_NAME}`,
    'Service: None'
  ];
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    fail('GATE_R1_REDIS_CONFIG_TARGET_MISMATCH');
  }
}

export function buildGateR1RedisR2Patch(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
    fail('GATE_R1_REDIS_CONFIG_ARGUMENT_INVALID');
  }
  const definition = PROFILES[profile];
  return Object.freeze({
    message: definition.message,
    patchJson: JSON.stringify(definition.patch),
    profile
  });
}

export function runGateR1RedisR2ConfigPatch({
  profile,
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync
}) {
  const definition = buildGateR1RedisR2Patch(profile);
  let childEnvironment;
  try {
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R1_REDIS_CONFIG_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R1_REDIS_CONFIG_AMBIENT_TOKEN_FORBIDDEN');
  }
  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R1_REDIS_CONFIG_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R1_REDIS_CONFIG_CLI_UNAVAILABLE');
  }

  let statusChild;
  let patchChild;
  let patchInvoked = false;
  const patchInput = Buffer.from(definition.patchJson, 'utf8');
  try {
    statusChild = spawn(executable, ['status'], {
      env: childEnvironment,
      maxBuffer: 512,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    if (statusChild?.error?.code === 'ETIMEDOUT') fail('GATE_R1_REDIS_CONFIG_TIMEOUT');
    parseStatus(statusChild);
    patchInvoked = true;
    patchChild = spawn(executable, [
      'environment', 'edit',
      '-e', GATE_R1_REDIS_ENVIRONMENT_ID,
      '-m', definition.message,
      '--json'
    ], {
      env: childEnvironment,
      input: patchInput,
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true
    });
    if (patchChild?.error || patchChild?.status !== 0) {
      fail('GATE_R1_REDIS_CONFIG_PATCH_AMBIGUOUS');
    }
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : patchInvoked
        ? 'GATE_R1_REDIS_CONFIG_PATCH_AMBIGUOUS'
        : 'GATE_R1_REDIS_CONFIG_TARGET_MISMATCH';
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
    code: 'GATE_R1_REDIS_CONFIG_PATCH_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R1_REDIS_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: GATE_R1_REDIS_SERVICE_ID,
    status: 'PENDING_PROJECTION'
  });
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--profile') {
    fail('GATE_R1_REDIS_CONFIG_ARGUMENT_INVALID');
  }
  buildGateR1RedisR2Patch(argv[1]);
  return { profile: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runGateR1RedisR2ConfigPatch(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R1_REDIS_CONFIG_PATCH_AMBIGUOUS';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
