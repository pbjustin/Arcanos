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
  const mockedExecution = fetchImpl !== globalThis.fetch;
  if (options.execute && !mockedExecution) {
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
    const response = await fetchImpl(url, { ...init,
      signal: AbortSignal.any([init.signal, aggregateSignal]) });
    if (!response.body) return response;
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_AGGREGATE_RESPONSE_BYTES) {
          controller.error(new NativePrPreviewE2eError('GAMING_SCOPED_PREVIEW_RESPONSE_LIMIT_EXCEEDED'));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
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
    offlineVerification: options.execute ? 'PASS' : 'NOT_RUN',
    executed: options.execute, mockedExecution, hostedExecuted: false,
    target: native.target,
    limits: { maxRequests: MAX_REQUESTS, maxResponseBytes: Math.min(options.maxResponseBytes, MAX_RESPONSE_BYTES),
      maxAggregateResponseBytes: MAX_AGGREGATE_RESPONSE_BYTES,
      requestTimeoutMs: Math.min(options.requestTimeoutMs, 5_000), totalTimeoutMs },
    assertionInventory: { plannedCaseIds, executedCaseIds,
      skippedCaseIds: native.assertionInventory.skippedCaseIds.map(id => `native:${id}`) },
    boundaries: { controlPlaneProvenanceAsserted: false, hostedEnabled: policy.hostedEnabled,
      liveNotionConnectivity: false, paidProviderInference: false, durableSourceStorage: false },
    summary: { status: 'PASS', code: options.execute ? 'GAMING_SCOPED_PREVIEW_OFFLINE_PASS'
      : 'GAMING_SCOPED_PREVIEW_TARGET_VALIDATED_NO_NETWORK', requestsMade, responseBytes },
    native, mcp,
  };
}
