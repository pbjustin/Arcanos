import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildGamingScopedPreviewAssertionInventory,
  runGamingScopedPreviewE2e,
} from './gaming-scoped-preview-e2e.mjs';
import {
  buildGamingScopedPreviewRequestPlan, expectedNativePrPreviewResponseBody,
  nativePrPreviewCaseCorrelation,
} from './native-pr-preview-e2e.mjs';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT as contract } from './native-pr-preview-contract.mjs';

const sha = 'a'.repeat(40);
const localGitState = { repository: 'pbjustin/Arcanos', head: sha, clean: true, sourceTreeSha: 'b'.repeat(40) };
const args = ['--pr-number', '1558', '--commit-sha', sha,
  '--web-base-url', 'https://web-pr-1558.up.railway.app',
  '--worker-base-url', 'https://worker-pr-1558.up.railway.app'];
const executeArgs = [...args, '--execute', '--allow-network', '--request-timeout-ms', '1000'];

function withinTestWatchdog(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_VERIFIER_DID_NOT_SETTLE')), 2_500);
  })]).finally(() => clearTimeout(timer));
}

function firstReadinessResponse(url, body = undefined) {
  const item = buildGamingScopedPreviewRequestPlan()[0];
  const correlation = nativePrPreviewCaseCorrelation(item);
  const headers = {
    'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(), geolocation=(), microphone=()',
    'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'x-request-id': correlation.requestId, 'x-trace-id': correlation.traceId,
    [contract.sessionContext.contractProofHeader]: contract.sessionContext.contractProofVersion,
  };
  for (const key of ['generativeModelPolicy', 'iosDevicePolicy', 'dagMetricsRetention', 'dagTokenAccounting', 'sessionContext']) {
    headers[contract[key].proofHeader] = contract[key].proofVersion;
  }
  const response = new Response(body ?? JSON.stringify(expectedNativePrPreviewResponseBody(item,
    { prNumber: 1558, commitSha: sha })), { headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('closed Gaming inventory combines maintained native and MCP assertions without the Notion canary', () => {
  const plan = buildGamingScopedPreviewAssertionInventory();
  assert.ok(Object.isFrozen(plan));
  assert.equal(plan.length, 84);
  assert.equal(new Set(plan).size, 84);
  assert.ok(plan.includes('native:gaming-query-guide'));
  assert.ok(plan.includes('native:gaming-source-ingestion-unsafe'));
  assert.ok(plan.includes('native:mcp-body-cap-effective-limits'));
  assert.ok(plan.includes('native:status-auth-before-parser'));
  assert.ok(plan.includes('mcp:query'));
  assert.ok(plan.includes('mcp:arcanos_gaming_ingest_sources'));
  assert.ok(plan.every(id => !/notion|backstage|research|tutor/iu.test(id)));
});

test('Gaming dry-run needs no application credentials or network and preserves bounded inventory', async () => {
  let requests = 0;
  const result = await runGamingScopedPreviewE2e({ args: [...args,
    '--total-timeout-ms', '120000', '--request-timeout-ms', '10000', '--max-response-bytes', '131072'],
    localGitState, fetchImpl: async () => { requests += 1; throw new Error('Network forbidden'); } });
  assert.equal(requests, 0);
  assert.equal(result.GAMING_SCOPED_PREVIEW, 'NOT_RUN');
  assert.equal(result.offlineVerification, 'NOT_RUN');
  assert.equal(result.hostedExecuted, false);
  assert.equal(result.target.sourceTreeSha, localGitState.sourceTreeSha);
  assert.equal(result.executed, false);
  assert.equal(result.limits.totalTimeoutMs, 60_000);
  assert.equal(result.limits.requestTimeoutMs, 5_000);
  assert.equal(result.limits.maxResponseBytes, 65_536);
  assert.equal(result.assertionInventory.plannedCaseIds.length, 84);
  assert.equal(result.assertionInventory.executedCaseIds.length, 0);
  assert.ok(result.assertionInventory.skippedCaseIds.includes('native:backstage-generation-notion-authority-rag'));
  assert.equal(result.boundaries.hostedEnabled, false);
  assert.equal(result.boundaries.liveNotionConnectivity, false);
});

test('Gaming hosted execution and caller-supplied scope configuration fail closed before outbound requests', async () => {
  await assert.rejects(runGamingScopedPreviewE2e({ args: [...args, '--execute', '--allow-network'],
    localGitState, trustedConfiguration: { version: 1, scope: 'full', hostedEnabled: true } }),
  error => error.code === 'GAMING_SCOPED_PREVIEW_TRUSTED_HOSTED_ACTIVATION_UNAVAILABLE');
  await assert.rejects(runGamingScopedPreviewE2e({ args: [...args, '--scope', 'skip-security'], localGitState }),
    error => error.code === 'NATIVE_PR_PREVIEW_ARGUMENT_INVALID');
});

test('a thin global-fetch wrapper is caller-supplied transport, not evidence of mocked or offline execution', async () => {
  const wrappedFetch = (url, init) => globalThis.fetch(url, init);
  const result = await runGamingScopedPreviewE2e({ args, localGitState, fetchImpl: wrappedFetch });
  assert.equal(result.callerSuppliedTransport, true);
  assert.equal(Object.hasOwn(result, 'mockedExecution'), false);
  assert.equal(result.offlineVerification, 'NOT_RUN');
  assert.equal(result.transport, 'not-used');
  assert.equal(result.GAMING_SCOPED_PREVIEW, 'NOT_RUN');
});

test('a selected Gaming or shared-security failure cannot be reported as a passing scoped preview', async () => {
  let requests = 0;
  await assert.rejects(runGamingScopedPreviewE2e({ args: [...args, '--execute', '--allow-network'], localGitState,
    fetchImpl: async url => {
      requests += 1;
      const response = new Response('{}', { status: 500 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    } }),
  error => error.code === 'NATIVE_PR_PREVIEW_HTTP_STATUS_MISMATCH');
  assert.equal(requests, 1);
});

test('the combined aggregate deadline expires before issuing another request', async () => {
  let clockReads = 0;
  let requests = 0;
  await assert.rejects(runGamingScopedPreviewE2e({ args: [...args, '--execute', '--allow-network'], localGitState,
    monotonicNow: () => clockReads++ === 0 ? 0 : 60_000,
    fetchImpl: async () => { requests += 1; throw new Error('The expired budget must prevent network'); } }),
  error => error.code === 'NATIVE_PR_PREVIEW_NETWORK_REQUEST_FAILED');
  assert.equal(requests, 0);
});

for (const lateCompletion of ['resolve', 'reject']) {
  test(`the request deadline settles a noncooperative transport and observes its late ${lateCompletion}`, async () => {
    let complete;
    let requestSignal;
    let requestedUrl;
    let requests = 0;
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const started = performance.now();
    try {
      await assert.rejects(withinTestWatchdog(runGamingScopedPreviewE2e({ args: executeArgs, localGitState,
        fetchImpl: (url, init) => {
          requests += 1; requestSignal = init.signal; requestedUrl = url;
          return new Promise((resolve, reject) => { complete = lateCompletion === 'resolve' ? resolve : reject; });
        } })), error => error.code === 'NATIVE_PR_PREVIEW_NETWORK_REQUEST_FAILED');
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 900 && elapsed < 2_500, `settled after ${elapsed}ms`);
      assert.equal(requests, 1);
      assert.equal(requestSignal.aborted, true);
      assert.equal(getEventListeners(requestSignal, 'abort').length, 0);
      let cancelled = 0;
      complete(lateCompletion === 'resolve'
        ? firstReadinessResponse(requestedUrl, new ReadableStream({ cancel() { cancelled += 1; return new Promise(() => {}); } }))
        : new Error('Late transport rejection'));
      await delay(20);
      assert.equal(cancelled, lateCompletion === 'resolve' ? 1 : 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
}

test('the request deadline errors a stalled body without awaiting its noncooperative read or cancellation', async () => {
  let requests = 0;
  let requestSignal;
  let cancelAttempts = 0;
  let readAttempts = 0;
  let rejectRead;
  let rejectCancel;
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const started = performance.now();
  try {
    await assert.rejects(withinTestWatchdog(runGamingScopedPreviewE2e({ args: executeArgs, localGitState,
      fetchImpl: async (url, init) => {
        requests += 1; requestSignal = init.signal;
        return firstReadinessResponse(url, new ReadableStream({
          pull() { readAttempts += 1; return new Promise((_, reject) => { rejectRead = reject; }); },
          cancel() { cancelAttempts += 1; return new Promise((_, reject) => { rejectCancel = reject; }); },
        }));
      } })), error => error.code === 'GAMING_SCOPED_PREVIEW_REQUEST_ABORTED');
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 2_500, `settled after ${elapsed}ms`);
    assert.equal(requests, 1);
    assert.equal(readAttempts, 1);
    assert.equal(cancelAttempts, 1);
    assert.equal(getEventListeners(requestSignal, 'abort').length, 0);
    rejectRead(new Error('Late read rejection'));
    rejectCancel(new Error('Late cancellation rejection'));
    await delay(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('completed body reads remove their abort listener before the next assertion fails', async () => {
  let requests = 0;
  let completedSignal;
  await assert.rejects(runGamingScopedPreviewE2e({ args: executeArgs, localGitState,
    fetchImpl: async (url, init) => {
      requests += 1;
      if (requests === 1) { completedSignal = init.signal; return firstReadinessResponse(url); }
      throw new Error('Stop after the completed first case');
    } }), error => error.code === 'NATIVE_PR_PREVIEW_NETWORK_REQUEST_FAILED');
  assert.equal(requests, 2);
  assert.equal(getEventListeners(completedSignal, 'abort').length, 0);
});
