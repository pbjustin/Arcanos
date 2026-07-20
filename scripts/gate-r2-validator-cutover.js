#!/usr/bin/env node
/**
 * Purpose: Cut one exact inactive Gate R2 validator over to the PostgreSQL R3 reference.
 * Safety: Accepts only fixed profiles, writes one literal reference through stdin with
 * deployment suppression, suppresses child diagnostics, and requires postprojection.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';
import { assertGateR2FixedLink } from './gate-r2-fixed-link.js';

export const GATE_R2_CUTOVER_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R2_CUTOVER_PROJECT_NAME = 'Arcanos';
export const GATE_R2_CUTOVER_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R2_CUTOVER_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
const GATE_R2_PROJECTOR_TOKEN_ENV = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN';
export const GATE_R2_CUTOVER_DATABASE_REFERENCE =
  '${{phase2e-postgres-r3-20260720.DATABASE_URL}}';

export const GATE_R2_VALIDATOR_TARGETS = Object.freeze({
  'compatibility-validator': Object.freeze({
    serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
    serviceName: 'phase2e-compatibility-validator-20260718'
  }),
  'migration-validator': Object.freeze({
    serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
    serviceName: 'phase2e-migration-validator-20260718'
  })
});

const SAFE_FAILURES = new Set([
  'GATE_R2_VALIDATOR_CUTOVER_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R2_VALIDATOR_CUTOVER_ARGUMENT_INVALID',
  'GATE_R2_VALIDATOR_CUTOVER_CLI_UNAVAILABLE',
  'GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS',
  'GATE_R2_VALIDATOR_CUTOVER_TARGET_MISMATCH',
  'GATE_R2_VALIDATOR_CUTOVER_TIMEOUT'
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

export function buildGateR2ValidatorCutover(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(GATE_R2_VALIDATOR_TARGETS, profile)) {
    fail('GATE_R2_VALIDATOR_CUTOVER_ARGUMENT_INVALID');
  }
  const target = GATE_R2_VALIDATOR_TARGETS[profile];
  return Object.freeze({
    args: Object.freeze([
      'variable', 'set',
      '--service', target.serviceId,
      '--environment', GATE_R2_CUTOVER_ENVIRONMENT_ID,
      '--stdin',
      '--skip-deploys',
      '--json',
      'DATABASE_URL'
    ]),
    profile,
    serviceId: target.serviceId,
    serviceName: target.serviceName
  });
}

export function runGateR2ValidatorCutover({
  profile,
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync,
  fixedLink = assertGateR2FixedLink
}) {
  const definition = buildGateR2ValidatorCutover(profile);
  let childEnvironment;
  try {
    if (Object.hasOwn(environment, GATE_R2_PROJECTOR_TOKEN_ENV)) {
      fail('GATE_R2_VALIDATOR_CUTOVER_AMBIENT_TOKEN_FORBIDDEN');
    }
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R2_VALIDATOR_CUTOVER_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R2_VALIDATOR_CUTOVER_AMBIENT_TOKEN_FORBIDDEN');
  }
  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R2_VALIDATOR_CUTOVER_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R2_VALIDATOR_CUTOVER_CLI_UNAVAILABLE');
  }

  let mutationChild;
  let mutationInvoked = false;
  const referenceInput = Buffer.from(GATE_R2_CUTOVER_DATABASE_REFERENCE, 'utf8');
  try {
    mutationChild = fixedLink({
      railwayExecutable: executable,
      childEnvironment,
      failureCode: 'GATE_R2_VALIDATOR_CUTOVER_TARGET_MISMATCH',
      timeoutCode: 'GATE_R2_VALIDATOR_CUTOVER_TIMEOUT',
      spawn,
      operation: scratchDirectory => {
        mutationInvoked = true;
        return spawn(executable, definition.args, {
          cwd: scratchDirectory,
          env: childEnvironment,
          input: referenceInput,
          shell: false,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 30_000,
          windowsHide: true
        });
      }
    });
    if (mutationChild?.error || mutationChild?.status !== 0) {
      fail('GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS');
    }
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const errorCode = error && typeof error === 'object' ? readOwnDataValue(error, 'code') : undefined;
    let code = mutationInvoked
      ? 'GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS'
      : 'GATE_R2_VALIDATOR_CUTOVER_TARGET_MISMATCH';
    if (!mutationInvoked && typeof message === 'string' && SAFE_FAILURES.has(message)) {
      code = message;
    } else if (!mutationInvoked && errorCode === 'ETIMEDOUT') {
      code = 'GATE_R2_VALIDATOR_CUTOVER_TIMEOUT';
    }
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(mutationChild);
    referenceInput.fill(0);
    mutationChild = null;
  }

  return Object.freeze({
    code: 'GATE_R2_VALIDATOR_CUTOVER_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R2_CUTOVER_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R2_CUTOVER_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: definition.serviceId,
    status: 'PENDING_PROJECTION'
  });
}

export function parseGateR2ValidatorCutoverArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--profile') {
    fail('GATE_R2_VALIDATOR_CUTOVER_ARGUMENT_INVALID');
  }
  buildGateR2ValidatorCutover(argv[1]);
  return Object.freeze({ profile: argv[1] });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runGateR2ValidatorCutover(
      parseGateR2ValidatorCutoverArgs(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
