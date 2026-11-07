import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
function fakeFetch(changedId: string, mutate: Mutation, identity = options) {
  let cursor = 0;
  return async () => {
    const item = plan[cursor++];
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-arcanos-preview-fixture': 'sealed-synthetic' };
    if (item.proof) { headers[gaming.proofHeader] = gaming.proofVersion; headers[migration.proofHeader] = migration.proofVersion;
      headers[gaming.compositionProofHeader] = gaming.compositionProofVersion; }
    let body: Record<string, unknown>;
    if (item.path === '/readyz') body = expectedNativePrPreviewResponseBody({ expectedType: `${item.role}-readiness` }, identity);
    else if (item.id === 'malformed') body = { error: 'PREVIEW_REQUEST_INVALID' };
    else body = handleGamingMcpPreviewRequest(item.body).payload ?? {};
    body = JSON.parse(JSON.stringify(body));
    if (item.id === changedId) mutate(body, headers);
    return new Response(item.status === 202 ? null : item.denied ? 'not found' : JSON.stringify(body), { status: item.status, headers });
  };
}

describe('Gaming supplemental exact-head verifier fails closed', () => {
  it('accepts the matching historical catalog only under its attested frozen contract', async () => {
    // Own protocol catalog rebuilt from the three pure source/schema Git blobs
    // at 848d6be5. This is not publisher bytes, image execution or current E2E.
    const tools = JSON.parse(readFileSync(new URL('./fixtures/gaming-historical-catalog-848d6be5.json', import.meta.url), 'utf8'));
    const frozenImageContract = { candidateSha: '848d6be5fc7d73936bb7921bd496d3051e30752d', treeSha: 'd78ffd0a423e9755008784b6c244cafc131d1acf',
      sourceArchiveSha256: '5bc4713eb4842f5927354bebc9ae82f43f9c32516dd7f32b61a8c446db684123',
      catalogSha256: 'd43aa08b59e003f447bbb2e24e9bc116f67c0e66778cd3d9de1e6f1785de4953' };
    expect(createHash('sha256').update(JSON.stringify(tools)).digest('hex')).toBe(frozenImageContract.catalogSha256);
    const frozenArgs = args.map(value => value === options.commitSha ? frozenImageContract.candidateSha : value);
    const result = await runGamingMcpPreviewE2e({ args: frozenArgs, frozenImageContract,
      localGitState: { ...localGitState, head: frozenImageContract.candidateSha },
      fetchImpl: fakeFetch('catalog', body => { (body.result as { tools: unknown[] }).tools = tools; },
        { ...options, commitSha: frozenImageContract.candidateSha }) });
    expect(result.summary).toMatchObject({ status: 'PASS', requestsMade: plan.length });
    expect(result.checks.find((check: { caseId: string }) => check.caseId === 'catalog')).toMatchObject({ httpStatus: 200 });
    expect(result.limits.maxResponseBytes).toBe(65_536);
  });
  it('keeps exact catalog validation when the attested historical image contract is selected', async () => {
    const frozenImageContract = { candidateSha: '848d6be5fc7d73936bb7921bd496d3051e30752d', treeSha: 'd78ffd0a423e9755008784b6c244cafc131d1acf',
      sourceArchiveSha256: '5bc4713eb4842f5927354bebc9ae82f43f9c32516dd7f32b61a8c446db684123',
      catalogSha256: 'd43aa08b59e003f447bbb2e24e9bc116f67c0e66778cd3d9de1e6f1785de4953' };
    const frozenArgs = args.map(value => value === options.commitSha ? frozenImageContract.candidateSha : value);
    await expect(runGamingMcpPreviewE2e({ args: frozenArgs, frozenImageContract,
      localGitState: { ...localGitState, head: frozenImageContract.candidateSha },
      fetchImpl: fakeFetch('unchanged', () => {}, { ...options, commitSha: frozenImageContract.candidateSha }) }))
      .rejects.toMatchObject({ code: 'GAMING_PREVIEW_EXACT_CATALOG', caseId: 'catalog' });
    let requests = 0;
    await expect(runGamingMcpPreviewE2e({ args, localGitState, frozenImageContract,
      fetchImpl: async () => { requests++; throw new Error('Must reject before transport'); } }))
      .rejects.toMatchObject({ code: 'GAMING_PREVIEW_FROZEN_CONTRACT_INVALID', caseId: 'catalog' });
    expect(requests).toBe(0);
  });
  it('accepts the exact released catalog before verifying the fixed outputs and denied writes', async () => {
    const result = await runGamingMcpPreviewE2e({ args, localGitState, fetchImpl: fakeFetch('unchanged', () => {}) });
    expect(result.summary).toMatchObject({ status: 'PASS', requestsMade: plan.length });
    expect(result.limits.maxResponseBytes).toBe(65_536);
    expect(result.checks.find((check: { caseId: string }) => check.caseId === 'catalog')).toMatchObject({ httpStatus: 200 });
  });
  it.each(['description', 'outcome', 'scope'] as const)('rejects an unreviewed %s change to the released catalog', async field => {
    const mutate: Mutation = body => {
      const tools = (body.result as { tools: Array<Record<string, any>> }).tools;
      if (field === 'description') tools[0].description += ' Unreviewed discovery authority.';
      else if (field === 'outcome') tools.find(tool => tool.name === 'arcanos_gaming_hybrid_query')!
        .outputSchema.$defs.GamingHybridResponse.properties.frontendOutcome.enum.push('unreviewed');
      else tools[0].securitySchemes[0].scopes.push('arcanos:gaming:sources:write');
    };
    await expect(runGamingMcpPreviewE2e({ args, localGitState, fetchImpl: fakeFetch('catalog', mutate) }))
      .rejects.toThrow('GAMING_PREVIEW_EXACT_CATALOG:catalog');
  });
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
