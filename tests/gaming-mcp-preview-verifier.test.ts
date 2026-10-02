import { describe, expect, it } from '@jest/globals';
import { runGamingMcpPreviewE2e, buildGamingMcpPreviewRequestPlan } from '../scripts/gaming-mcp-preview-e2e.mjs';
import { expectedNativePrPreviewResponseBody } from '../scripts/native-pr-preview-e2e.mjs';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';
import { handleGamingMcpPreviewRequest } from '../src/shared/chatgpt/gamingMcpPreviewFixture.js';
const gaming = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptGaming;
const migration = NATIVE_PR_PREVIEW_E2E_CONTRACT.pluginMigration;
const options = { prNumber: 1520, commitSha: 'a'.repeat(40) };
const localGitState = { repository: 'pbjustin/Arcanos', head: options.commitSha, clean: true };
const args = ['--pr-number', String(options.prNumber), '--commit-sha', options.commitSha, '--web-base-url', 'https://web-pr-1520.up.railway.app',
  '--worker-base-url', 'https://worker-pr-1520.up.railway.app', '--execute', '--allow-network'];
const plan = buildGamingMcpPreviewRequestPlan();
type Mutation = (body: Record<string, unknown>, headers: Record<string, string>) => void;
function fakeFetch(changedId: string, mutate: Mutation) {
  let cursor = 0;
  return async () => {
    const item = plan[cursor++];
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-arcanos-preview-fixture': 'sealed-synthetic' };
    if (item.proof) { headers[gaming.proofHeader] = gaming.proofVersion; headers[migration.proofHeader] = migration.proofVersion;
      headers[gaming.compositionProofHeader] = gaming.compositionProofVersion; }
    let body: Record<string, unknown>;
    if (item.path === '/readyz') body = expectedNativePrPreviewResponseBody({ expectedType: `${item.role}-readiness` }, options);
    else if (item.id === 'malformed') body = { error: 'PREVIEW_REQUEST_INVALID' };
    else body = handleGamingMcpPreviewRequest(item.body).payload ?? {};
    body = JSON.parse(JSON.stringify(body));
    if (item.id === changedId) mutate(body, headers);
    return new Response(item.status === 202 ? null : item.denied ? 'not found' : JSON.stringify(body), { status: item.status, headers });
  };
}

describe('Gaming supplemental exact-head verifier fails closed', () => {
  it.each([
    ['query', (_body, headers) => { delete headers[gaming.proofHeader]; }, 'SUCCESS_PROOF'],
    ['hybrid', (_body, headers) => { delete headers[migration.proofHeader]; }, 'SUCCESS_PROOF'],
    ['query', (_body, headers) => { delete headers[gaming.compositionProofHeader]; }, 'SUCCESS_PROOF'],
    ['hybrid', (_body, headers) => { headers[gaming.compositionProofHeader] = 'gaming-instruction-sections/v0'; }, 'SUCCESS_PROOF'],
    ['catalog', (_body, headers) => { headers[gaming.compositionProofHeader] = gaming.compositionProofVersion; }, 'SUCCESS_PROOF'],
    ['worker-denial', (_body, headers) => { headers[gaming.compositionProofHeader] = gaming.compositionProofVersion; }, 'SUCCESS_PROOF'],
    ['arcanos_gaming_ingest_sources', (_body, headers) => { headers[gaming.compositionProofHeader] = gaming.compositionProofVersion; }, 'SUCCESS_PROOF'],
    ['catalog', (_body, headers) => { headers[gaming.proofHeader] = gaming.proofVersion; }, 'SUCCESS_PROOF'],
    ['arcanos_gaming_ingest_sources', (_body, headers) => { headers[migration.proofHeader] = migration.proofVersion; }, 'SUCCESS_PROOF'],
    ['worker-denial', (_body, headers) => { headers[gaming.proofHeader] = gaming.proofVersion; }, 'SUCCESS_PROOF'],
    ['query', (_body, headers) => { headers[NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptTutor.honestyProofHeader] = 'wrong-family'; }, 'CROSS_FAMILY_PROOF'],
    ['web-ready', body => { body.sourceCommit = 'b'.repeat(40); }, 'EXACT_ROLE_IDENTITY'],
    ['worker-ready', body => { body.processKind = 'web'; }, 'EXACT_ROLE_IDENTITY'],
    ['catalog', body => { (body.result as { tools: unknown[] }).tools.pop(); }, 'EXACT_CATALOG'],
    ['catalog', body => { const tools = (body.result as { tools: Array<{ name: string }> }).tools; tools[0].name = 'modules.invoke'; }, 'EXACT_CATALOG'],
    ['query', body => { (body.result as Record<string, unknown>).structuredContent = { stored: true }; }, 'SYNTHETIC_OUTPUT'],
    ['query', (_body, headers) => { headers['set-cookie'] = 'unwanted=session'; }, 'STATE_HEADER'],
  ] as Array<[string, Mutation, string]>)('rejects changed %s proof/body (%#)', async (id, mutation, code) => {
    await expect(runGamingMcpPreviewE2e({ args, localGitState, fetchImpl: fakeFetch(id, mutation) })).rejects.toThrow(`GAMING_PREVIEW_${code}:${id}`);
  });
  it('rejects dirty or mismatched local Git evidence before network', async () => {
    await expect(runGamingMcpPreviewE2e({ args, localGitState: { ...localGitState, clean: false } })).rejects.toThrow('LOCAL_WORKTREE_DIRTY');
    await expect(runGamingMcpPreviewE2e({ args, localGitState: { ...localGitState, head: 'b'.repeat(40) } })).rejects.toThrow('LOCAL_HEAD_MISMATCH');
  });
});
