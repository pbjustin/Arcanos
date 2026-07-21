#!/usr/bin/env node
/**
 * Purpose: Project the current TCP-proxy count for one exact Gate R1 quarantined or replacement service.
 * Inputs/outputs: Reads one dedicated project-token environment variable and emits only allowlisted target identity plus a count.
 * Safety: Uses mode-specific fixed read-only queries, rejects schema drift, bounds the response, and never logs token or proxy values.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Canonical endpoint from Railway's Public API/API Cookbook documentation, reviewed 2026-07-19.
export const GATE_R1_RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const GATE_R1_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R1_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R1_POSTGRES_SERVICE_ID = 'b7789306-8aef-4113-add5-02883a6cc087';
export const GATE_R1_REDIS_SERVICE_ID = '434fa5b4-b52c-4caf-aaba-e87c173bf10d';
export const GATE_R1_MIGRATION_VALIDATOR_SERVICE_ID = 'd8d5181a-2f72-48d7-8413-6f05d113876c';
export const GATE_R1_COMPATIBILITY_VALIDATOR_SERVICE_ID = 'febdf999-1c96-48df-8e28-c905b8b27082';
export const GATE_R1_WEB_SERVICE_ID = 'c4ade025-3f13-4fca-9309-5d0dd81396fe';
export const GATE_R1_WORKER_SERVICE_ID = '1765befb-b805-4051-9af9-28634e986886';
export const GATE_R1_POSTGRES_R2_SERVICE_ID = 'a2a57da4-a928-427f-be30-d4a68b59a117';
export const GATE_R1_POSTGRES_R2_SERVICE_INSTANCE_ID = 'e8c42bea-d887-485b-8aaf-ba0f45d439e8';
export const GATE_R1_REDIS_R2_SERVICE_ID = '1ac0bd56-50b3-49eb-954c-ea83515ec915';
export const GATE_R1_REDIS_R2_SERVICE_INSTANCE_ID = '0f34bcbb-bfd0-4df5-954a-bb97371bd460';
export const GATE_R1_POSTGRES_R3_SERVICE_ID = '7346b3f6-bf3d-46e1-9d66-79f10847ef89';
export const GATE_R1_POSTGRES_R3_SERVICE_INSTANCE_ID = '86dde430-50ac-4d5c-95c3-cb27064eff51';
export const GATE_R1_REPLACEMENT_PROFILES = Object.freeze({
  postgres: 'phase2e-postgres-r2-20260718',
  redis: 'phase2e-redis-r2-20260718',
  'postgres-r3': 'phase2e-postgres-r3-20260720'
});
export const GATE_R1_RAILWAY_PROJECT_TOKEN_ENV = 'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN';
export const GATE_R1_TCP_PROXY_RESPONSE_LIMIT_BYTES = 16 * 1024;
export const GATE_R1_TCP_PROXY_TIMEOUT_MS = 10_000;
export const GATE_R1_PROJECT_TOKEN_MAX_CHARACTERS = 512;

export const GATE_R1_TCP_PROXY_QUERY = `query GateR1TcpProxyCount($environmentId: String!, $serviceId: String!) {
  projectToken {
    projectId
    environmentId
  }
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
    id
  }
}`;

export const GATE_R1_REPLACEMENT_TCP_PROXY_QUERY = `query GateR1ReplacementTcpProxyCount($environmentId: String!, $serviceId: String!) {
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
  }
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
    id
    serviceId
    environmentId
    deletedAt
  }
}`;

const APPROVED_SERVICE_IDS = new Set([
  GATE_R1_POSTGRES_SERVICE_ID,
  GATE_R1_REDIS_SERVICE_ID
]);
const PREEXISTING_SERVICE_IDS = new Set([
  ...APPROVED_SERVICE_IDS,
  GATE_R1_MIGRATION_VALIDATOR_SERVICE_ID,
  GATE_R1_COMPATIBILITY_VALIDATOR_SERVICE_ID,
  GATE_R1_WEB_SERVICE_ID,
  GATE_R1_WORKER_SERVICE_ID
]);
const POSTGRES_R3_FORBIDDEN_IDS = new Set([
  ...PREEXISTING_SERVICE_IDS,
  GATE_R1_POSTGRES_R2_SERVICE_ID,
  GATE_R1_POSTGRES_R2_SERVICE_INSTANCE_ID,
  GATE_R1_REDIS_R2_SERVICE_ID,
  GATE_R1_REDIS_R2_SERVICE_INSTANCE_ID
]);
const FIXED_REPLACEMENT_TARGETS = Object.freeze({
  postgres: Object.freeze({
    serviceId: GATE_R1_POSTGRES_R2_SERVICE_ID,
    serviceInstanceId: GATE_R1_POSTGRES_R2_SERVICE_INSTANCE_ID
  }),
  redis: Object.freeze({
    serviceId: GATE_R1_REDIS_R2_SERVICE_ID,
    serviceInstanceId: GATE_R1_REDIS_R2_SERVICE_INSTANCE_ID
  }),
  'postgres-r3': Object.freeze({
    serviceId: GATE_R1_POSTGRES_R3_SERVICE_ID,
    serviceInstanceId: GATE_R1_POSTGRES_R3_SERVICE_INSTANCE_ID
  })
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/i;

const ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: 'GATE_R1_TCP_PROXY_PROJECTOR_ARGUMENT_INVALID',
  CLOCK_INVALID: 'GATE_R1_TCP_PROXY_PROJECTOR_CLOCK_INVALID',
  REQUEST_FAILED: 'GATE_R1_TCP_PROXY_PROJECTOR_REQUEST_FAILED',
  RESPONSE_INVALID: 'GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID',
  SCOPE_MISMATCH: 'GATE_R1_TCP_PROXY_PROJECTOR_SCOPE_MISMATCH',
  TARGET_FORBIDDEN: 'GATE_R1_TCP_PROXY_PROJECTOR_TARGET_FORBIDDEN',
  TIMEOUT: 'GATE_R1_TCP_PROXY_PROJECTOR_TIMEOUT',
  TOKEN_INVALID: 'GATE_R1_TCP_PROXY_PROJECTOR_TOKEN_INVALID',
  TOKEN_MISSING: 'GATE_R1_TCP_PROXY_PROJECTOR_TOKEN_MISSING'
});
const SAFE_ERROR_CODES = new Set(Object.values(ERROR_CODES));

function fail(code) {
  throw new Error(code);
}

function isSafeProjectorError(error) {
  return error instanceof Error && SAFE_ERROR_CODES.has(error.message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function assertApprovedServiceId(serviceId) {
  if (typeof serviceId !== 'string' || !APPROVED_SERVICE_IDS.has(serviceId)) {
    fail(ERROR_CODES.TARGET_FORBIDDEN);
  }
}

function assertReplacementTarget(replacementProfile, serviceId, serviceInstanceId) {
  if (!Object.hasOwn(GATE_R1_REPLACEMENT_PROFILES, replacementProfile)) {
    fail(ERROR_CODES.TARGET_FORBIDDEN);
  }
  const serviceName = GATE_R1_REPLACEMENT_PROFILES[replacementProfile];
  const fixedTarget = FIXED_REPLACEMENT_TARGETS[replacementProfile];
  if (fixedTarget !== undefined
      && (serviceId !== fixedTarget.serviceId || serviceInstanceId !== fixedTarget.serviceInstanceId)) {
    fail(ERROR_CODES.TARGET_FORBIDDEN);
  }
  const forbiddenIds = replacementProfile === 'postgres-r3'
    ? POSTGRES_R3_FORBIDDEN_IDS
    : PREEXISTING_SERVICE_IDS;
  if (
    typeof serviceName !== 'string'
    || typeof serviceId !== 'string'
    || !UUID_PATTERN.test(serviceId)
    || forbiddenIds.has(serviceId)
    || serviceId === GATE_R1_PROJECT_ID
    || serviceId === GATE_R1_ENVIRONMENT_ID
    || typeof serviceInstanceId !== 'string'
    || !UUID_PATTERN.test(serviceInstanceId)
    || forbiddenIds.has(serviceInstanceId)
    || serviceInstanceId === GATE_R1_PROJECT_ID
    || serviceInstanceId === GATE_R1_ENVIRONMENT_ID
    || serviceInstanceId === serviceId
  ) {
    fail(ERROR_CODES.TARGET_FORBIDDEN);
  }
  return serviceName;
}

function isIsoTimestampOrNull(value) {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    return false;
  }
  const canonicalValue = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(value).toISOString() === canonicalValue;
}

function resolveToken(env) {
  let projectAccessValue;
  try {
    projectAccessValue = env?.[GATE_R1_RAILWAY_PROJECT_TOKEN_ENV];
  } catch {
    fail(ERROR_CODES.TOKEN_INVALID);
  }
  if (
    typeof projectAccessValue !== 'string'
    || projectAccessValue.length === 0
    || projectAccessValue.trim().length === 0
  ) {
    fail(ERROR_CODES.TOKEN_MISSING);
  }
  if (
    projectAccessValue.length > GATE_R1_PROJECT_TOKEN_MAX_CHARACTERS
    || projectAccessValue !== projectAccessValue.trim()
    || /[^\x21-\x7e]/.test(projectAccessValue)
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
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
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
    // Synchronous cancellation diagnostics are intentionally suppressed.
  }
}

async function readBoundedResponseBody(response, maxBytes, signal) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maxBytes) {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }
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
      if (byteLength > maxBytes) {
        cancelReaderBestEffort(reader);
        fail(ERROR_CODES.RESPONSE_INVALID);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (isSafeProjectorError(error)) {
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
      // Reader cleanup cannot alter the sanitized projector result.
    }
  }

  return text;
}

function projectResponse(parsed) {
  if (!hasExactKeys(parsed, ['data'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const data = parsed.data;
  if (!hasExactKeys(data, ['projectToken', 'tcpProxies'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const tokenScope = data.projectToken;
  if (!hasExactKeys(tokenScope, ['environmentId', 'projectId'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  if (
    typeof tokenScope.projectId !== 'string'
    || typeof tokenScope.environmentId !== 'string'
    || !UUID_PATTERN.test(tokenScope.projectId)
    || !UUID_PATTERN.test(tokenScope.environmentId)
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  if (
    tokenScope.projectId !== GATE_R1_PROJECT_ID
    || tokenScope.environmentId !== GATE_R1_ENVIRONMENT_ID
  ) {
    fail(ERROR_CODES.SCOPE_MISMATCH);
  }

  const proxies = data.tcpProxies;
  if (!Array.isArray(proxies)) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const proxyIds = new Set();
  for (const proxy of proxies) {
    if (!hasExactKeys(proxy, ['id']) || typeof proxy.id !== 'string' || !UUID_PATTERN.test(proxy.id)) {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }
    if (proxyIds.has(proxy.id)) {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }
    proxyIds.add(proxy.id);
  }

  return proxies.length;
}

function projectReplacementResponse(parsed, {
  serviceId,
  serviceInstanceId,
  serviceName
}) {
  if (!hasExactKeys(parsed, ['data'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const data = parsed.data;
  if (!hasExactKeys(data, ['projectToken', 'service', 'serviceInstance', 'tcpProxies'])) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const tokenScope = data.projectToken;
  if (
    !hasExactKeys(tokenScope, ['environmentId', 'projectId'])
    || typeof tokenScope.projectId !== 'string'
    || typeof tokenScope.environmentId !== 'string'
    || !UUID_PATTERN.test(tokenScope.projectId)
    || !UUID_PATTERN.test(tokenScope.environmentId)
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }
  if (
    tokenScope.projectId !== GATE_R1_PROJECT_ID
    || tokenScope.environmentId !== GATE_R1_ENVIRONMENT_ID
  ) {
    fail(ERROR_CODES.SCOPE_MISMATCH);
  }

  const service = data.service;
  if (
    !hasExactKeys(service, ['id', 'name', 'projectId'])
    || service.id !== serviceId
    || service.name !== serviceName
    || service.projectId !== GATE_R1_PROJECT_ID
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const serviceInstance = data.serviceInstance;
  if (
    !hasExactKeys(
      serviceInstance,
      ['deletedAt', 'environmentId', 'id', 'serviceId', 'serviceName']
    )
    || serviceInstance.id !== serviceInstanceId
    || serviceInstance.serviceId !== serviceId
    || serviceInstance.serviceName !== serviceName
    || serviceInstance.environmentId !== GATE_R1_ENVIRONMENT_ID
    || serviceInstance.deletedAt !== null
  ) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const proxies = data.tcpProxies;
  if (!Array.isArray(proxies)) {
    fail(ERROR_CODES.RESPONSE_INVALID);
  }

  const proxyIds = new Set();
  let tcpProxyCount = 0;
  for (const proxy of proxies) {
    if (
      !hasExactKeys(proxy, ['deletedAt', 'environmentId', 'id', 'serviceId'])
      || typeof proxy.id !== 'string'
      || !UUID_PATTERN.test(proxy.id)
      || proxy.serviceId !== serviceId
      || proxy.environmentId !== GATE_R1_ENVIRONMENT_ID
      || !isIsoTimestampOrNull(proxy.deletedAt)
      || proxyIds.has(proxy.id)
    ) {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }
    proxyIds.add(proxy.id);
    if (proxy.deletedAt === null) {
      tcpProxyCount += 1;
    }
  }

  return tcpProxyCount;
}

async function requestGateR1TcpProxyProjection({
  serviceId,
  query,
  project,
  buildResult,
  env = process.env,
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  AbortControllerImpl = AbortController,
  clock = () => new Date().toISOString()
}) {
  const projectAccessValue = resolveToken(env);
  if (typeof fetchImpl !== 'function') {
    fail(ERROR_CODES.REQUEST_FAILED);
  }

  let controller;
  let timeoutHandle;
  try {
    controller = new AbortControllerImpl();
    timeoutHandle = setTimeoutImpl(() => controller.abort(), GATE_R1_TCP_PROXY_TIMEOUT_MS);
  } catch {
    fail(ERROR_CODES.REQUEST_FAILED);
  }
  if (timeoutHandle && typeof timeoutHandle === 'object' && typeof timeoutHandle.unref === 'function') {
    timeoutHandle.unref();
  }

  try {
    let response;
    try {
      response = await fetchImpl(GATE_R1_RAILWAY_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
          Pragma: 'no-cache',
          'Project-Access-Token': projectAccessValue
        },
        body: JSON.stringify({
          query,
          variables: {
            environmentId: GATE_R1_ENVIRONMENT_ID,
            serviceId
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

    const raw = await readBoundedResponseBody(
      response,
      GATE_R1_TCP_PROXY_RESPONSE_LIMIT_BYTES,
      controller.signal
    );
    if (controller.signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(ERROR_CODES.RESPONSE_INVALID);
    }

    const tcpProxyCount = project(parsed);
    if (controller.signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    const observedAt = resolveObservedAt(clock);
    if (controller.signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    return Object.freeze(buildResult({ observedAt, tcpProxyCount }));
  } catch (error) {
    if (isSafeProjectorError(error)) {
      throw error;
    }
    fail(ERROR_CODES.RESPONSE_INVALID);
  } finally {
    try {
      clearTimeoutImpl(timeoutHandle);
    } catch {
      // A cleanup diagnostic must never replace the fixed projector result or expose process detail.
    }
  }
}

export async function projectGateR1TcpProxyCount(options = {}) {
  const { serviceId, ...dependencies } = options;
  assertApprovedServiceId(serviceId);
  return requestGateR1TcpProxyProjection({
    ...dependencies,
    serviceId,
    query: GATE_R1_TCP_PROXY_QUERY,
    project: projectResponse,
    buildResult: ({ observedAt, tcpProxyCount }) => ({
      projectId: GATE_R1_PROJECT_ID,
      environmentId: GATE_R1_ENVIRONMENT_ID,
      serviceId,
      observedAt,
      tcpProxyCount
    })
  });
}

export async function projectGateR1ReplacementTcpProxyCount(options = {}) {
  const {
    replacementProfile,
    serviceId,
    serviceInstanceId,
    ...dependencies
  } = options;
  const serviceName = assertReplacementTarget(
    replacementProfile,
    serviceId,
    serviceInstanceId
  );
  return requestGateR1TcpProxyProjection({
    ...dependencies,
    serviceId,
    query: GATE_R1_REPLACEMENT_TCP_PROXY_QUERY,
    project: (parsed) => projectReplacementResponse(parsed, {
      serviceId,
      serviceInstanceId,
      serviceName
    }),
    buildResult: ({ observedAt, tcpProxyCount }) => ({
      projectId: GATE_R1_PROJECT_ID,
      environmentId: GATE_R1_ENVIRONMENT_ID,
      replacementProfile,
      serviceId,
      serviceName,
      serviceInstanceId,
      observedAt,
      tcpProxyCount
    })
  });
}

export function parseGateR1TcpProxyArgs(argv) {
  if (
    Array.isArray(argv)
    && argv.length === 2
    && argv[0] === '--service-id'
    && typeof argv[1] === 'string'
  ) {
    assertApprovedServiceId(argv[1]);
    return Object.freeze({ serviceId: argv[1] });
  }

  if (
    Array.isArray(argv)
    && argv.length === 6
    && argv[0] === '--replacement-profile'
    && typeof argv[1] === 'string'
    && argv[2] === '--service-id'
    && typeof argv[3] === 'string'
    && argv[4] === '--service-instance-id'
    && typeof argv[5] === 'string'
  ) {
    assertReplacementTarget(argv[1], argv[3], argv[5]);
    return Object.freeze({
      mode: 'replacement',
      replacementProfile: argv[1],
      serviceId: argv[3],
      serviceInstanceId: argv[5]
    });
  }

  fail(ERROR_CODES.ARGUMENT_INVALID);
}

export async function runGateR1TcpProxyProjectorCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  try {
    const args = parseGateR1TcpProxyArgs(argv);
    const result = args.mode === 'replacement'
      ? await projectGateR1ReplacementTcpProxyCount({ ...args, ...dependencies })
      : await projectGateR1TcpProxyCount({ ...args, ...dependencies });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const safeCode = isSafeProjectorError(error)
      ? error.message
      : 'GATE_R1_TCP_PROXY_PROJECTOR_FAILED';
    stderr.write(`${safeCode}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runGateR1TcpProxyProjectorCli();
}
