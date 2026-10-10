import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from './native-pr-preview-contract.mjs';
import { parseProbeArguments, runStackedDraftPreviewProbe, validateProbeTarget } from './stacked-draft-preview-probe.mjs';
const now = Date.now();
const expiresAt = new Date(now + 60_000).toISOString();
const authorization = { version: 1, controllerSha: 'a'.repeat(40), expiresAt,
  stack: [{ prNumber: 1533 }, { prNumber: 1534 }, { prNumber: 1535, headSha: 'b'.repeat(40) }] };
const deployment = { schemaVersion: 1, status: 'VERIFIED', cleanup: null,
  ownership: { repository: 'pbjustin/Arcanos', controllerSha: authorization.controllerSha,
    candidateSha: authorization.stack.at(-1).headSha, expiresAt, environmentName: 'pr-1532aa-1535',
    image: `ghcr.io/pbjustin/arcanos-stacked-preview@sha256:${'c'.repeat(64)}` },
  hosts: { web: 'https://web-pr-1532aa-1535.up.railway.app', worker: 'https://worker-pr-1532aa-1535.up.railway.app' } };
test('probe dry run never fetches and records unexecuted provider and production boundaries', async () => {
  const report = await runStackedDraftPreviewProbe({ authorization, deployment,
    now: () => now, localGitState: { clean: true, head: authorization.stack.at(-1).headSha,
      repository: 'pbjustin/Arcanos' },
    expectedBackstageBookerOpenApiDocument: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.document,
    fetchImpl() { throw new Error('must not fetch'); } });
  assert.equal(report.executed, false);
  assert.equal(report.summary.requestsMade, 0);
  assert.equal(report.performance.guideRequestElapsedMs, null);
  assert.equal(report.boundaries.paidProviderCalls, false);
  assert.equal(report.boundaries.realPluginAuthentication, false);
});
test('probe refuses expired, cleaned, unverified and substituted deployment receipts', () => {
  for (const change of [{ status: 'NOT VERIFIED' }, { cleanup: { status: 'VERIFIED' } },
    { ownership: { ...deployment.ownership, image: 'ghcr.io/pbjustin/arcanos-stacked-preview:latest' } },
    { ownership: { ...deployment.ownership, candidateSha: 'd'.repeat(40) } },
    { ownership: { ...deployment.ownership, environmentName: 'production' } }]) {
    assert.throws(() => validateProbeTarget(authorization, { ...deployment, ...change }, now), /TARGET_UNVERIFIED/u);
  }
  assert.throws(() => validateProbeTarget(authorization, deployment, now + 60_000), /TARGET_UNVERIFIED/u);
});
test('probe argument parsing rejects duplicate flags and arbitrary target overrides', () => {
  const args = ['--authorization', 'auth.json', '--deployment', 'deployment.json', '--git-evidence-root', '/head'];
  assert.equal(parseProbeArguments(args)['--deployment'], 'deployment.json');
  for (const extra of [['--deployment', 'other.json'], ['--skip-security'], ['--web-base-url', 'https://production.invalid']]) {
    assert.throws(() => parseProbeArguments([...args, ...extra]), /ARGUMENT_INVALID/u);
  }
});
