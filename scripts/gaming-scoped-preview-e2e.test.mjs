import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGamingScopedPreviewAssertionInventory,
  runGamingScopedPreviewE2e,
} from './gaming-scoped-preview-e2e.mjs';

const sha = 'a'.repeat(40);
const localGitState = { repository: 'pbjustin/Arcanos', head: sha, clean: true, sourceTreeSha: 'b'.repeat(40) };
const args = ['--pr-number', '1558', '--commit-sha', sha,
  '--web-base-url', 'https://web-pr-1558.up.railway.app',
  '--worker-base-url', 'https://worker-pr-1558.up.railway.app'];

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
