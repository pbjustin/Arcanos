#!/usr/bin/env node
/**
 * Purpose: Dispose one exact obsolete Gate R2 volume instance after a separate
 * retirement-state projection has proven it RETAINED_DETACHED.
 * Safety: Accepts only fixed profiles, submits one volume-only environment
 * patch through nonempty stdin, suppresses child diagnostics, and never uses
 * Railway's logical `volume delete` or detach operations.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSanitizedRailwayChildEnvironment,
  resolveRailwayExecutable
} from './gate-r1-postgres-readiness.js';
import { assertGateR2FixedLink } from './gate-r2-fixed-link.js';

export const GATE_R2_VOLUME_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R2_VOLUME_PROJECT_NAME = 'Arcanos';
export const GATE_R2_VOLUME_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R2_VOLUME_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
const GATE_R2_PROJECTOR_TOKEN_ENV = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN';

export const GATE_R2_VOLUME_DISPOSITION_TARGETS = Object.freeze({
  'failed-postgres-r2': Object.freeze({
    message: 'gate-r2: dispose detached failed postgres r2 volume instance',
    volumeId: '2998734d-7530-4f26-b715-cea4780bd437',
    volumeInstanceId: '46113532-5609-46da-b7b4-46b8f06930cc'
  }),
  'original-postgres': Object.freeze({
    message: 'gate-r2: dispose detached original preview postgres volume instance',
    volumeId: '35c26093-1e3f-4d34-b699-89c65d2fb92d',
    volumeInstanceId: 'b8f04086-2e97-4167-a0fd-bcb259541e9f'
  }),
  'original-redis': Object.freeze({
    message: 'gate-r2: dispose detached original preview redis volume instance',
    volumeId: 'd3690500-fcc5-4c06-afa6-cf30e91f608d',
    volumeInstanceId: 'f222873c-255e-45a2-9a17-840bdba108f6'
  })
});

const SAFE_FAILURES = new Set([
  'GATE_R2_VOLUME_DISPOSITION_AMBIENT_TOKEN_FORBIDDEN',
  'GATE_R2_VOLUME_DISPOSITION_ARGUMENT_INVALID',
  'GATE_R2_VOLUME_DISPOSITION_CLI_UNAVAILABLE',
  'GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS',
  'GATE_R2_VOLUME_DISPOSITION_TARGET_MISMATCH',
  'GATE_R2_VOLUME_DISPOSITION_TIMEOUT'
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

export function buildGateR2VolumeDispositionPatch(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(GATE_R2_VOLUME_DISPOSITION_TARGETS, profile)) {
    fail('GATE_R2_VOLUME_DISPOSITION_ARGUMENT_INVALID');
  }
  const target = GATE_R2_VOLUME_DISPOSITION_TARGETS[profile];
  return Object.freeze({
    message: target.message,
    patchJson: JSON.stringify({ volumes: { [target.volumeId]: { isDeleted: true } } }),
    profile,
    volumeId: target.volumeId,
    volumeInstanceId: target.volumeInstanceId
  });
}

export function runGateR2VolumeDisposition({
  profile,
  railwayExecutable,
  environment = process.env,
  spawn = spawnSync,
  fixedLink = assertGateR2FixedLink
}) {
  const definition = buildGateR2VolumeDispositionPatch(profile);
  let childEnvironment;
  try {
    if (Object.hasOwn(environment, GATE_R2_PROJECTOR_TOKEN_ENV)) {
      fail('GATE_R2_VOLUME_DISPOSITION_AMBIENT_TOKEN_FORBIDDEN');
    }
    childEnvironment = buildSanitizedRailwayChildEnvironment(
      environment,
      'GATE_R2_VOLUME_DISPOSITION_AMBIENT_TOKEN_FORBIDDEN'
    );
  } catch {
    fail('GATE_R2_VOLUME_DISPOSITION_AMBIENT_TOKEN_FORBIDDEN');
  }
  let executable;
  try {
    executable = railwayExecutable ?? resolveRailwayExecutable();
  } catch {
    fail('GATE_R2_VOLUME_DISPOSITION_CLI_UNAVAILABLE');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    fail('GATE_R2_VOLUME_DISPOSITION_CLI_UNAVAILABLE');
  }

  let mutationChild;
  let mutationInvoked = false;
  const mutationInput = Buffer.from(definition.patchJson, 'utf8');
  try {
    mutationChild = fixedLink({
      railwayExecutable: executable,
      childEnvironment,
      failureCode: 'GATE_R2_VOLUME_DISPOSITION_TARGET_MISMATCH',
      timeoutCode: 'GATE_R2_VOLUME_DISPOSITION_TIMEOUT',
      spawn,
      operation: scratchDirectory => {
        mutationInvoked = true;
        return spawn(executable, [
          'environment', 'edit',
          '-e', GATE_R2_VOLUME_ENVIRONMENT_ID,
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
      fail('GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS');
    }
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const errorCode = error && typeof error === 'object' ? readOwnDataValue(error, 'code') : undefined;
    let code = mutationInvoked
      ? 'GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS'
      : 'GATE_R2_VOLUME_DISPOSITION_TARGET_MISMATCH';
    if (!mutationInvoked && typeof message === 'string' && SAFE_FAILURES.has(message)) {
      code = message;
    } else if (!mutationInvoked && errorCode === 'ETIMEDOUT') {
      code = 'GATE_R2_VOLUME_DISPOSITION_TIMEOUT';
    }
    clearChildDiagnostics(error);
    throw new Error(code);
  } finally {
    clearChildDiagnostics(mutationChild);
    mutationInput.fill(0);
    mutationChild = null;
  }

  return Object.freeze({
    code: 'GATE_R2_VOLUME_DISPOSITION_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R2_VOLUME_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R2_VOLUME_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    status: 'PENDING_PROJECTION',
    volumeId: definition.volumeId,
    volumeInstanceId: definition.volumeInstanceId
  });
}

export function parseGateR2VolumeDispositionArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--profile') {
    fail('GATE_R2_VOLUME_DISPOSITION_ARGUMENT_INVALID');
  }
  buildGateR2VolumeDispositionPatch(argv[1]);
  return { profile: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = runGateR2VolumeDisposition(
      parseGateR2VolumeDispositionArgs(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && typeof error === 'object' ? readOwnDataValue(error, 'message') : undefined;
    const code = typeof message === 'string' && SAFE_FAILURES.has(message)
      ? message
      : 'GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
