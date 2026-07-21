#!/usr/bin/env node
/**
 * Purpose: Classify one exact inactive Gate R2 validator's unrendered DATABASE_URL reference.
 * Safety: Uses one fixed read-only query, emits no variable value, bounds all input, and fails closed.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GATE_R2_VALIDATOR_REFERENCE_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R2_VALIDATOR_REFERENCE_TOKEN_ENV = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN';
export const GATE_R2_VALIDATOR_REFERENCE_RESPONSE_LIMIT_BYTES = 16 * 1024;
export const GATE_R2_VALIDATOR_REFERENCE_TIMEOUT_MS = 10_000;
export const GATE_R2_VALIDATOR_REFERENCE_TOKEN_MAX_CHARACTERS = 512;

export const GATE_R2_VALIDATOR_PROFILES = Object.freeze({
  'migration-validator': Object.freeze({
    serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
    serviceInstanceId: '7a645cbc-dadf-4072-84c1-6f0843fa30d9',
    serviceName: 'phase2e-migration-validator-20260718'
  }),
  'compatibility-validator': Object.freeze({
    serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
    serviceInstanceId: '3c385dd2-c786-4149-9319-2a168a920aa9',
    serviceName: 'phase2e-compatibility-validator-20260718'
  })
});

export const GATE_R2_REFERENCE_CATEGORIES = Object.freeze({
  MISSING: 'MISSING',
  ORIGINAL_POSTGRES: 'ORIGINAL_POSTGRES',
  FAILED_POSTGRES_R2: 'FAILED_POSTGRES_R2',
  POSTGRES_R3: 'POSTGRES_R3',
  INVALID: 'INVALID'
});

const REFERENCE_CATEGORIES_BY_VALUE = new Map([
  ['${{Postgres.DATABASE_URL}}', GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES],
  ['${{phase2e-postgres-r2-20260718.DATABASE_URL}}', GATE_R2_REFERENCE_CATEGORIES.FAILED_POSTGRES_R2],
  ['${{phase2e-postgres-r3-20260720.DATABASE_URL}}', GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3]
]);

export const GATE_R2_VALIDATOR_REFERENCE_QUERY = `query GateR2ValidatorReference(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
) {
  projectToken {
    projectId
    environmentId
  }
  service(id: $serviceId) {
    id
    name
    projectId
  }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id
    serviceId
    serviceName
    environmentId
    deletedAt
    latestDeployment { id }
    activeDeployments { id }
  }
  variables(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    unrendered: true
  )
}`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/iu;
const REFERENCE_VALUE_MAX_CHARACTERS = 256;

const ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_ARGUMENT_INVALID',
  CLOCK_INVALID: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_CLOCK_INVALID',
  REQUEST_FAILED: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_REQUEST_FAILED',
  RESPONSE_INVALID: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID',
  SCOPE_MISMATCH: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH',
  TARGET_FORBIDDEN: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TARGET_FORBIDDEN',
  TIMEOUT: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TIMEOUT',
  TOKEN_INVALID: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TOKEN_INVALID',
  TOKEN_MISSING: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TOKEN_MISSING',
  VALIDATOR_ACTIVE: 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_VALIDATOR_ACTIVE'
});
const SAFE_ERROR_CODES = new Set(Object.values(ERROR_CODES));

function fail(code) {
  throw new Error(code);
}

function isSafeError(error) {
  return error instanceof Error && SAFE_ERROR_CODES.has(error.message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isIsoTimestampOrNull(value) {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    return false;
  }
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(value).toISOString() === canonical;
}

function resolveProfile(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(GATE_R2_VALIDATOR_PROFILES, profile)) {
    fail(ERROR_CODES.TARGET_FORBIDDEN);
  }
  return GATE_R2_VALIDATOR_PROFILES[profile];
}

function resolveToken(env) {
  let projectAccessValue;
  try {
    projectAccessValue = env?.[GATE_R2_VALIDATOR_REFERENCE_TOKEN_ENV];
  } catch {
    fail(ERROR_CODES.TOKEN_INVALID);
  }
  if (
    typeof projectAccessValue !== 'string'
    || projectAccessValue.trim().length === 0
  ) {
    fail(ERROR_CODES.TOKEN_MISSING);
  }
  if (
    projectAccessValue.length > GATE_R2_VALIDATOR_REFERENCE_TOKEN_MAX_CHARACTERS
    || projectAccessValue !== projectAccessValue.trim()
    || /[^\x21-\x7e]/u.test(projectAccessValue)
  ) {
    fail(ERROR_CODES.TOKEN_INVALID);
  }
  return projectAccessValue;
}

function resolveObservedAt(clock) {
  let observedAt;
  try {
    observedAt = clock();
  } catch {
    fail(ERROR_CODES.CLOCK_INVALID);
  }
  if (
    typeof observedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observedAt)
    || Number.isNaN(Date.parse(observedAt))
    || new Date(observedAt).toISOString() !== observedAt
  ) {
    fail(ERROR_CODES.CLOCK_INVALID);
  }
  return observedAt;
}

function cancelReaderBestEffort(reader) {
  try {
    void Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // Reader cleanup must not expose diagnostics or replace a fixed result.
  }
}

async function readBoundedResponseBody(response, signal) {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null
    && (!/^(0|[1-9][0-9]*)$/u.test(contentLength)
      || Number(contentLength) > GATE_R2_VALIDATOR_REFERENCE_RESPONSE_LIMIT_BYTES)
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let text = '';
  let rejectForAbort;
  const abortPromise = new Promise((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const onAbort = () => {
    cancelReaderBestEffort(reader);
    rejectForAbort(new Error(ERROR_CODES.TIMEOUT));
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal.aborted) {
      onAbort();
    }
    while (true) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (!isPlainObject(part) || typeof part.done !== 'boolean') {
        fail(ERROR_CODES.RESPONSE_INVALID);
      }
      if (part.done) {
        break;
      }
      if (!(part.value instanceof Uint8Array)) {
        fail(ERROR_CODES.RESPONSE_INVALID);
      }
      byteLength += part.value.byteLength;
      if (byteLength > GATE_R2_VALIDATOR_REFERENCE_RESPONSE_LIMIT_BYTES) {
        cancelReaderBestEffort(reader);
        fail(ERROR_CODES.RESPONSE_INVALID);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (isSafeError(error)) {
      throw error;
    }
    if (signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    fail(ERROR_CODES.RESPONSE_INVALID);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      cancelReaderBestEffort(reader);
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader cleanup cannot alter the sanitized result.
    }
  }
}

export function classifyGateR2ValidatorVariables(variables) {
  if (!isPlainObject(variables)) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  const keys = Object.keys(variables);
  if (keys.length === 0) {
    return Object.freeze({
      referenceCategory: GATE_R2_REFERENCE_CATEGORIES.MISSING,
      variableCount: 0
    });
  }
  if (!hasExactKeys(variables, ['DATABASE_URL'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  const value = variables.DATABASE_URL;
  const referenceCategory = typeof value === 'string'
    && value.length > 0
    && value.length <= REFERENCE_VALUE_MAX_CHARACTERS
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? REFERENCE_CATEGORIES_BY_VALUE.get(value) ?? GATE_R2_REFERENCE_CATEGORIES.INVALID
    : GATE_R2_REFERENCE_CATEGORIES.INVALID;
  return Object.freeze({ referenceCategory, variableCount: 1 });
}

function assertScope(scope) {
  if (
    !hasExactKeys(scope, ['projectId', 'environmentId'])
    || typeof scope.projectId !== 'string'
    || typeof scope.environmentId !== 'string'
    || !UUID_PATTERN.test(scope.projectId)
    || !UUID_PATTERN.test(scope.environmentId)
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  if (
    scope.projectId !== GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID
    || scope.environmentId !== GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID
  ) {
    fail(ERROR_CODES.SCOPE_MISMATCH);
  }
}

function projectResponse(parsed, target) {
  if (!hasExactKeys(parsed, ['data'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  const data = parsed.data;
  if (!hasExactKeys(data, ['projectToken', 'service', 'serviceInstance', 'variables'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  assertScope(data.projectToken);

  if (
    !hasExactKeys(data.service, ['id', 'name', 'projectId'])
    || data.service.id !== target.serviceId
    || data.service.name !== target.serviceName
    || data.service.projectId !== GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID
  ) {
    fail(ERROR_CODES.SCOPE_MISMATCH);
  }

  const instance = data.serviceInstance;
  if (
    !hasExactKeys(instance, [
      'id', 'serviceId', 'serviceName', 'environmentId', 'deletedAt',
      'latestDeployment', 'activeDeployments'
    ])
    || instance.id !== target.serviceInstanceId
    || instance.serviceId !== target.serviceId
    || instance.serviceName !== target.serviceName
    || instance.environmentId !== GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID
    || !isIsoTimestampOrNull(instance.deletedAt)
  ) {
    fail(ERROR_CODES.SCOPE_MISMATCH);
  }
  if (instance.deletedAt !== null) {
    fail(ERROR_CODES.TARGET_FORBIDDEN);
  }

  if (!Array.isArray(instance.activeDeployments) || instance.activeDeployments.length > 10) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  const deploymentIds = new Set();
  for (const deployment of instance.activeDeployments) {
    if (
      !hasExactKeys(deployment, ['id'])
      || typeof deployment.id !== 'string'
      || !UUID_PATTERN.test(deployment.id)
      || deploymentIds.has(deployment.id)
    ) {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }
    deploymentIds.add(deployment.id);
  }
  if (
    instance.latestDeployment !== null
    && (
      !hasExactKeys(instance.latestDeployment, ['id'])
      || typeof instance.latestDeployment.id !== 'string'
      || !UUID_PATTERN.test(instance.latestDeployment.id)
    )
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  if (instance.latestDeployment !== null || instance.activeDeployments.length !== 0) {
    fail(ERROR_CODES.VALIDATOR_ACTIVE);
  }

  return classifyGateR2ValidatorVariables(data.variables);
}

export async function projectGateR2ValidatorReference({
  profile,
  env = process.env,
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  AbortControllerImpl = AbortController,
  clock = () => new Date().toISOString()
} = {}) {
  const target = resolveProfile(profile);
  const projectAccessValue = resolveToken(env);
  if (typeof fetchImpl !== 'function') {
    fail(ERROR_CODES.REQUEST_FAILED);
  }

  let controller;
  let timeoutHandle;
  try {
    controller = new AbortControllerImpl();
    timeoutHandle = setTimeoutImpl(
      () => controller.abort(),
      GATE_R2_VALIDATOR_REFERENCE_TIMEOUT_MS
    );
  } catch {
    fail(ERROR_CODES.REQUEST_FAILED);
  }
  if (timeoutHandle && typeof timeoutHandle === 'object' && typeof timeoutHandle.unref === 'function') {
    timeoutHandle.unref();
  }

  try {
    let response;
    try {
      response = await fetchImpl(GATE_R2_VALIDATOR_REFERENCE_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
          Pragma: 'no-cache',
          'Project-Access-Token': projectAccessValue
        },
        body: JSON.stringify({
          query: GATE_R2_VALIDATOR_REFERENCE_QUERY,
          variables: {
            projectId: GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID,
            environmentId: GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID,
            serviceId: target.serviceId
          }
        }),
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store'
      });
    } catch {
      if (controller.signal.aborted) {
        fail(ERROR_CODES.TIMEOUT);
      }
      fail(ERROR_CODES.REQUEST_FAILED);
    }
    if (
      !response
      || response.status !== 200
      || !JSON_CONTENT_TYPE_PATTERN.test(response.headers?.get?.('content-type') ?? '')
    ) {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }

    const raw = await readBoundedResponseBody(response, controller.signal);
    if (controller.signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }
    const projection = projectResponse(parsed, target);
    const observedAt = resolveObservedAt(clock);
    return Object.freeze({
      projectId: GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID,
      environmentId: GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID,
      validatorProfile: profile,
      serviceId: target.serviceId,
      serviceName: target.serviceName,
      serviceInstanceId: target.serviceInstanceId,
      observedAt,
      activeDeploymentCount: 0,
      variableCount: projection.variableCount,
      referenceCategory: projection.referenceCategory
    });
  } catch (error) {
    if (isSafeError(error)) {
      throw error;
    }
    fail(ERROR_CODES.RESPONSE_INVALID);
  } finally {
    try {
      clearTimeoutImpl(timeoutHandle);
    } catch {
      // Cleanup diagnostics must not replace a fixed result.
    }
  }
}

export function parseGateR2ValidatorReferenceArgs(argv) {
  if (
    !Array.isArray(argv)
    || argv.length !== 2
    || argv[0] !== '--profile'
    || typeof argv[1] !== 'string'
  ) {
    fail(ERROR_CODES.ARGUMENT_INVALID);
  }
  resolveProfile(argv[1]);
  return Object.freeze({ profile: argv[1] });
}

export async function runGateR2ValidatorReferenceProjectorCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  try {
    const args = parseGateR2ValidatorReferenceArgs(argv);
    const result = await projectGateR2ValidatorReference({ ...args, ...dependencies });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const safeCode = isSafeError(error)
      ? error.message
      : 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_FAILED';
    stderr.write(`${safeCode}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await runGateR2ValidatorReferenceProjectorCli();
}
