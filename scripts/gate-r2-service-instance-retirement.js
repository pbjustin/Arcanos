#!/usr/bin/env node
/**
 * Purpose: Retire one exact obsolete Gate R service instance from the isolated environment.
 * Safety: Accepts only fixed profiles, sends one bounded service-only patch through stdin,
 * suppresses child diagnostics, never mutates volumes, and requires projection after mutation.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';
import { assertGateR2FixedLink } from './gate-r2-fixed-link.js';

export const GATE_R2_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R2_PROJECT_NAME = 'Arcanos';
export const GATE_R2_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R2_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
const GATE_R2_PROJECTOR_TOKEN_ENV = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN';

export const GATE_R2_RETIREMENT_TARGETS = Object.freeze({
  'failed-postgres-r2': Object.freeze({
    message: 'gate-r2: retire failed postgres r2 service instance',
    serviceId: 'a2a57da4-a928-427f-be30-d4a68b59a117',
    serviceInstanceId: 'e8c42bea-d887-485b-8aaf-ba0f45d439e8',
    serviceName: 'phase2e-postgres-r2-20260718'
  }),
  'original-postgres': Object.freeze({
    message: 'gate-r2: retire original preview postgres service instance',
    serviceId: 'b7789306-8aef-4113-add5-02883a6cc087',
    serviceInstanceId: '6dac21a3-ad8a-4b98-ad50-637054c13729',
    serviceName: 'Postgres'
  }),
  'original-redis': Object.freeze({
    message: 'gate-r2: retire original preview redis service instance',
    serviceId: '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
    serviceInstanceId: '8340f02f-dbcb-4c0e-bdde-b3f7c4bf5856',
    serviceName: 'Redis'
  })
});

const SAFE_FAILURES = new Set([
  'GATE_R2_RETIREMENT_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R2_RETIREMENT_ARGUMENT_INVALID',
  'GATE_R2_RETIREMENT_CLI_UNAVAILABLE',
  'GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS',
  'GATE_R2_RETIREMENT_TARGET_MISMATCH',
  'GATE_R2_RETIREMENT_TIMEOUT'
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

export function buildGateR2RetirementPatch(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(GATE_R2_RETIREMENT_TARGETS, profile)) {
    fail('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
  }
  const target = GATE_R2_RETIREMENT_TARGETS[profile];
  return Object.freeze({
    message: target.message,
    patchJson: JSON.stringify({ services: { [target.serviceId]: { isDeleted: true } } }),
    profile,
    serviceId: target.serviceId,
    serviceInstanceId: target.serviceInstanceId,
    serviceName: target.serviceName
  });
}

export function runGateR2ServiceInstanceRetirement({
  profile,
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync,
  fixedLink = assertGateR2FixedLink
}) {
  const definition = buildGateR2RetirementPatch(profile);
  let childEnvironment;
  try {
    if (Object.hasOwn(environment, GATE_R2_PROJECTOR_TOKEN_ENV)) {
      fail('GATE_R2_RETIREMENT_AMBIENT_TOKEN_FORBIDDEN');
    }
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R2_RETIREMENT_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R2_RETIREMENT_AMBIENT_TOKEN_FORBIDDEN');
  }
  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R2_RETIREMENT_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R2_RETIREMENT_CLI_UNAVAILABLE');
  }

  let mutationChild;
  let mutationInvoked = false;
  const mutationInput = Buffer.from(definition.patchJson, 'utf8');
  try {
    mutationChild = fixedLink({
      railwayExecutable: executable,
      childEnvironment,
      failureCode: 'GATE_R2_RETIREMENT_TARGET_MISMATCH',
      timeoutCode: 'GATE_R2_RETIREMENT_TIMEOUT',
      spawn,
      operation: scratchDirectory => {
        mutationInvoked = true;
        return spawn(executable, [
          'environment', 'edit',
          '-e', GATE_R2_ENVIRONMENT_ID,
          '-m', definition.message,
          '--json'
        ], {
          cwd: scratchDirectory,
          env: childEnvironment,
          input: mutationInput,
          shell: false,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 30_000,
          windowsHide: true
        });
      }
    });
    if (mutationChild?.error || mutationChild?.status !== 0) {
      fail('GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS');
    }
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const errorCode = error && typeof error === 'object' ? readOwnDataValue(error, 'code') : undefined;
    let code = mutationInvoked
      ? 'GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS'
      : 'GATE_R2_RETIREMENT_TARGET_MISMATCH';
    if (!mutationInvoked && typeof message === 'string' && SAFE_FAILURES.has(message)) {
      code = message;
    } else if (!mutationInvoked && errorCode === 'ETIMEDOUT') {
      code = 'GATE_R2_RETIREMENT_TIMEOUT';
    }
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(mutationChild);
    mutationInput.fill(0);
    mutationChild = null;
  }

  return Object.freeze({
    code: 'GATE_R2_RETIREMENT_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R2_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R2_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: definition.serviceId,
    serviceInstanceId: definition.serviceInstanceId,
    status: 'PENDING_PROJECTION'
  });
}

export function parseGateR2RetirementArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--profile') {
    fail('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
  }
  buildGateR2RetirementPatch(argv[1]);
  return { profile: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runGateR2ServiceInstanceRetirement(
      parseGateR2RetirementArgs(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
