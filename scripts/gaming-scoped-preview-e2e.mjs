import {
  GAMING_SCOPED_PREVIEW_SCOPE,
  NativePrPreviewE2eError,
  buildGamingScopedPreviewRequestPlan,
  parseNativePrPreviewE2eArguments,
  runNativePrPreviewE2e,
} from './native-pr-preview-e2e.mjs';
import { buildGamingMcpPreviewRequestPlan, runGamingMcpPreviewE2e } from './gaming-mcp-preview-e2e.mjs';
import {
  assertTrustedGamingPreviewConfiguration,
  resolveTrustedGamingPreviewConfiguration,
} from './gaming-scoped-preview-policy.mjs';

const MAX_REQUESTS = 84;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_AGGREGATE_RESPONSE_BYTES = 512 * 1024;
const MAX_TOTAL_TIMEOUT_MS = 60_000;
export const GAMING_SCOPED_PREVIEW_REQUIRED_MCP_CASE_IDS = Object.freeze([
  'web-ready', 'worker-ready', 'initialize', 'initialized', 'catalog', 'query', 'hybrid',
  'unknown-tool', 'authority-input', 'candidate-bound', 'arcanos_gaming_ingest_sources',
  'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates', 'missing-confirmation',
  'authorization', 'cookie', 'malformed', 'oversized', 'worker-denial',
  'web-metadata-denial', 'worker-metadata-denial',
]);

function fail(code) { throw new NativePrPreviewE2eError(code); }

function requestAborted() {
  return new NativePrPreviewE2eError('GAMING_SCOPED_PREVIEW_REQUEST_ABORTED');
}

function cancelWithoutWaiting(stream, reason) {
  try {
    Promise.resolve(stream?.cancel(reason)).catch(() => {});
  } catch {
    // Caller-owned sources can ignore or reject cancellation; their effects remain unverified.
  }
}

async function settleTransport(fetchImpl, url, init, signal) {
  if (signal.aborted) throw requestAborted();
  let responseClaimed = false;
  let discarded = false;
  const discardLateResponse = response => {
    if (!discarded) {
      discarded = true;
      cancelWithoutWaiting(response?.body, requestAborted());
    }
  };
  const transport = Promise.resolve().then(() => {
    if (signal.aborted) throw requestAborted();
    return fetchImpl(url, { ...init, signal });
  });
  // Observe late success and rejection without awaiting noncooperative work.
  transport.then(response => {
    if (signal.aborted && !responseClaimed) discardLateResponse(response);
  }, () => {}).catch(() => {});
  let onAbort;
  try {
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(requestAborted());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const response = await Promise.race([transport, aborted]);
    if (signal.aborted) {
      discardLateResponse(response);
      throw requestAborted();
    }
    responseClaimed = true;
    return response;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function boundedResponseStream(body, signal, countBytes) {
  const reader = body.getReader();
  let settled = false;
  let onAbort;
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  return new ReadableStream({
    start(controller) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = requestAborted();
        // Error downstream immediately; neither the read nor cancel promise must settle.
        controller.error(error);
        cancelWithoutWaiting(reader, error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      if (settled) return;
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) {
          settled = true;
          cleanup();
          reader.releaseLock();
          controller.close();
          return;
        }
        countBytes(value.byteLength);
        controller.enqueue(value);
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        controller.error(error);
        cancelWithoutWaiting(reader, error);
      }
    },
    cancel(reason) {
      if (settled) return;
      settled = true;
      cleanup();
      cancelWithoutWaiting(reader, reason);
    },
  }, { highWaterMark: 0 });
}

export function buildGamingScopedPreviewAssertionInventory() {
  const native = buildGamingScopedPreviewRequestPlan().map(item => `native:${item.caseId}`);
  const mcpIds = buildGamingMcpPreviewRequestPlan().map(item => item.id);
  if (JSON.stringify(mcpIds) !== JSON.stringify(GAMING_SCOPED_PREVIEW_REQUIRED_MCP_CASE_IDS)
    || native.length + mcpIds.length !== MAX_REQUESTS) {
    fail('GAMING_SCOPED_PREVIEW_REQUIRED_ASSERTIONS_MISSING');
  }
  return Object.freeze([...native, ...mcpIds.map(id => `mcp:${id}`)]);
}

function boundedArguments(args, options, totalTimeoutMs) {
  const replaced = new Set(['--total-timeout-ms', '--request-timeout-ms', '--max-response-bytes']);
  const bounded = [];
  for (let index = 0; index < args.length; index += 1) {
    if (replaced.has(args[index])) { index += 1; continue; }
    bounded.push(args[index]);
  }
  return [...bounded, '--total-timeout-ms', String(totalTimeoutMs),
    '--request-timeout-ms', String(Math.min(options.requestTimeoutMs, 5_000)),
    '--max-response-bytes', String(Math.min(options.maxResponseBytes, MAX_RESPONSE_BYTES))];
}

// This supplements a trusted controller; it cannot create or attest Railway resources.
// There is deliberately no candidate-selectable CLI scope or hosted activation flag.
export async function runGamingScopedPreviewE2e({
  args = [], fetchImpl = globalThis.fetch, localGitState,
  monotonicNow = () => performance.now(),
} = {}) {
  const policy = resolveTrustedGamingPreviewConfiguration();
  assertTrustedGamingPreviewConfiguration(policy);
  const options = parseNativePrPreviewE2eArguments(args,
    { ...(localGitState === undefined ? {} : { localGitState }), includeSourceTree: true });
  const plannedCaseIds = buildGamingScopedPreviewAssertionInventory();
  const callerSuppliedTransport = fetchImpl !== globalThis.fetch;
  if (options.execute && (!callerSuppliedTransport || policy.hostedEnabled !== false)) {
    fail('GAMING_SCOPED_PREVIEW_TRUSTED_HOSTED_ACTIVATION_UNAVAILABLE');
  }
  const totalTimeoutMs = Math.min(options.totalTimeoutMs, MAX_TOTAL_TIMEOUT_MS);
  const startedAt = monotonicNow();
  const aggregateSignal = options.execute ? AbortSignal.timeout(totalTimeoutMs) : undefined;
  let requestsMade = 0;
  let responseBytes = 0;
  const boundedFetch = async (url, init) => {
    requestsMade += 1;
    if (requestsMade > MAX_REQUESTS) fail('GAMING_SCOPED_PREVIEW_REQUEST_LIMIT_EXCEEDED');
    if (aggregateSignal.aborted || monotonicNow() - startedAt >= totalTimeoutMs) {
      fail('GAMING_SCOPED_PREVIEW_TOTAL_TIMEOUT');
    }
    const parsedUrl = new URL(url);
    if (![options.webBaseUrl, options.workerBaseUrl].includes(parsedUrl.origin)) {
      fail('GAMING_SCOPED_PREVIEW_OUTBOUND_ORIGIN_FORBIDDEN');
    }
    const requestSignal = AbortSignal.any([init.signal, aggregateSignal]);
    const response = await settleTransport(fetchImpl, url, init, requestSignal);
    if (!response.body) return response;
    const stream = boundedResponseStream(response.body, requestSignal, bytes => {
      responseBytes += bytes;
      if (responseBytes > MAX_AGGREGATE_RESPONSE_BYTES) {
        fail('GAMING_SCOPED_PREVIEW_RESPONSE_LIMIT_EXCEEDED');
      }
    });
    const boundedResponse = new Response(stream, { status: response.status,
      statusText: response.statusText, headers: response.headers });
    Object.defineProperties(boundedResponse, {
      url: { value: response.url }, redirected: { value: response.redirected },
    });
    return boundedResponse;
  };
  const native = await runNativePrPreviewE2e({
    args: boundedArguments(args, options, totalTimeoutMs), localGitState,
    requestScope: GAMING_SCOPED_PREVIEW_SCOPE, fetchImpl: boundedFetch, monotonicNow,
  });
  const remainingMs = totalTimeoutMs - Math.max(0, Math.ceil(monotonicNow() - startedAt));
  // The shared argument guard has a 10s minimum. Fail rather than resetting the budget.
  if (options.execute && remainingMs < 10_000) fail('GAMING_SCOPED_PREVIEW_TOTAL_TIMEOUT');
  const mcp = await runGamingMcpPreviewE2e({
    args: boundedArguments(args, options, options.execute ? remainingMs : totalTimeoutMs),
    localGitState, fetchImpl: boundedFetch,
  });
  const executedCaseIds = [...native.checks.map(item => `native:${item.caseId}`),
    ...mcp.checks.map(item => `mcp:${item.caseId}`)];
  if (options.execute && (JSON.stringify(executedCaseIds) !== JSON.stringify(plannedCaseIds)
    || aggregateSignal.aborted || monotonicNow() - startedAt >= totalTimeoutMs)) {
    fail('GAMING_SCOPED_PREVIEW_REQUIRED_ASSERTIONS_MISSING');
  }
  return {
    kind: 'gaming_scoped_preview_verification', requestScope: policy.scope,
    GAMING_SCOPED_PREVIEW: 'NOT_RUN',
    offlineVerification: options.execute ? 'NOT_PROVEN' : 'NOT_RUN',
    executed: options.execute, callerSuppliedTransport,
    transport: options.execute ? 'caller-supplied-unverified' : 'not-used',
    hostedExecuted: options.execute ? null : false,
    target: native.target,
    limits: { maxRequests: MAX_REQUESTS, maxResponseBytes: Math.min(options.maxResponseBytes, MAX_RESPONSE_BYTES),
      maxAggregateResponseBytes: MAX_AGGREGATE_RESPONSE_BYTES,
      requestTimeoutMs: Math.min(options.requestTimeoutMs, 5_000), totalTimeoutMs },
    assertionInventory: { plannedCaseIds, executedCaseIds,
      skippedCaseIds: native.assertionInventory.skippedCaseIds.map(id => `native:${id}`) },
    boundaries: { controlPlaneProvenanceAsserted: false, hostedEnabled: policy.hostedEnabled,
      liveNotionConnectivity: options.execute ? null : false,
      paidProviderInference: options.execute ? null : false,
      durableSourceStorage: options.execute ? null : false },
    summary: { status: 'PASS', code: options.execute ? 'GAMING_SCOPED_PREVIEW_ASSERTIONS_PASS_UNATTESTED_TRANSPORT'
      : 'GAMING_SCOPED_PREVIEW_TARGET_VALIDATED_NO_NETWORK', requestsMade, responseBytes },
    native, mcp,
  };
}
