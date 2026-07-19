#!/usr/bin/env node
/**
 * Purpose: Project the current TCP-proxy count for one exact Gate R1 service.
 * Inputs/outputs: Reads one dedicated project-token environment variable and emits only fixed target IDs plus a count.
 * Safety: Uses one fixed read-only query, rejects schema drift, bounds the response, and never logs token or proxy values.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Canonical endpoint from Railway's Public API/API Cookbook documentation, reviewed 2026-07-19.
export const GATE_R1_RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const GATE_R1_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R1_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R1_POSTGRES_SERVICE_ID = 'b7789306-8aef-4113-add5-02883a6cc087';
export const GATE_R1_REDIS_SERVICE_ID = '434fa5b4-b52c-4caf-aaba-e87c173bf10d';
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

const APPROVED_SERVICE_IDS = new Set([
  GATE_R1_POSTGRES_SERVICE_ID,
  GATE_R1_REDIS_SERVICE_ID
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export async function projectGateR1TcpProxyCount({
  serviceId,
  env = process.env,
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  AbortControllerImpl = AbortController,
  clock = () => new Date().toISOString()
}) {
  assertApprovedServiceId(serviceId);
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
          query: GATE_R1_TCP_PROXY_QUERY,
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

    const tcpProxyCount = projectResponse(parsed);
    if (controller.signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    const observedAt = resolveObservedAt(clock);
    if (controller.signal.aborted) {
      fail(ERROR_CODES.TIMEOUT);
    }
    return Object.freeze({
      projectId: GATE_R1_PROJECT_ID,
      environmentId: GATE_R1_ENVIRONMENT_ID,
      serviceId,
      observedAt,
      tcpProxyCount
    });
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

export function parseGateR1TcpProxyArgs(argv) {
  if (
    !Array.isArray(argv)
    || argv.length !== 2
    || argv[0] !== '--service-id'
    || typeof argv[1] !== 'string'
  ) {
    fail(ERROR_CODES.ARGUMENT_INVALID);
  }
  assertApprovedServiceId(argv[1]);
  return Object.freeze({ serviceId: argv[1] });
}

export async function runGateR1TcpProxyProjectorCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  try {
    const result = await projectGateR1TcpProxyCount({
      ...parseGateR1TcpProxyArgs(argv),
      ...dependencies
    });
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
