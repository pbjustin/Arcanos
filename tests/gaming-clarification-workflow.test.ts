import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

const guideUrl = 'https://guides.example.org/elden-ring/early-samurai';
const guideHtml = readFileSync(new URL('./fixtures/gaming-samurai-guide.html', import.meta.url), 'utf8');
const mockHttp = jest.fn();
const mockTrinity = jest.fn();
const mockAudit = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: mockTrinity }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createSingleChatCompletion: mockAudit, createChatCompletionWithFallback: jest.fn(), ensureModelMatchesExpectation: jest.fn()
}));
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { resolveGamingUserDecisionGap } = await import('../src/shared/gaming/gamingRetrievalPolicy.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const actor = { actorKey: 'clarification-fixture-owner', requestId: 'clarification-fixture-request' };
const contractVersion = 'gaming-hybrid-v2';
const query = { contractVersion, idempotencyKey: 'clarification-query', game: 'Elden Ring', mode: 'build', class: 'Samurai',
  progressPoint: 'just exited the tutorial', question: 'Recommend an early-game Samurai katana build.' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };
const env = { ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '12000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200' };
let previous: Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: guideHtml }));
  mockAudit.mockImplementation(async (_client: unknown, params: any) => {
    const refs = JSON.parse(params.messages[1].content).evidence.map((item: any) => item.chunkId);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      dimensions: Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
        status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED_FIXTURE'], evidenceRefs: refs.slice(0, 8), unresolvedFacts: []
      }])), findings: []
    }) } }], usage: { prompt_tokens: 400, completion_tokens: 150, total_tokens: 550 } };
  });
  mockTrinity.mockImplementation(async (request: any) => {
    const result = 'Keep the Samurai starting Uchigatana katana with Unsheathe. Prioritize Vigor toward 20 and Dexterity later. Upgrade with ordinary Smithing Stones in Limgrave. [Source 1]';
    const { assessment } = await request.context.runOptions.gamingClearAnswerAudit(result, request.context.runtimeBudget);
    return { result, gamingClearAudit: assessment, meta: { provider: { finishReason: 'stop' } } };
  });
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  jest.restoreAllMocks();
});

function harness() {
  let clock = Date.now();
  const retrieve = jest.fn(async () => empty);
  const evaluateCandidates = jest.fn<typeof evaluateGamingHybridCandidates>(async (input, context) => {
    const result = await evaluateGamingHybridCandidates(input, context);
    clock += 250;
    return { ...result, acquisitionWorkMs: 250 };
  });
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates, now: () => clock });
  const submit = (body: GamingHybridResponse, suffix = 'initial') => workflow.candidates({ contractVersion,
    workflowId: body.workflowId, expectedRevision: body.revision, idempotencyKey: `clarification-source-${suffix}`,
    discoveryType: 'gameplay_evidence', candidates: [{ url: guideUrl + (suffix === 'initial' ? '' : `/${suffix}`) }] }, actor);
  return { workflow, retrieve, evaluateCandidates, submit, advance: (ms: number) => { clock += ms; } };
}

describe('Gaming user decisions retain the acquired evidence workflow', () => {
  it.each([
    ['bleed and pure Dexterity', 'pure Dexterity', 'Do you prefer bleed or pure Dexterity?'],
    ['single katana and dual wield', 'single katana', 'Do you prefer a single katana or dual wielding?'],
    ['aggressive and defensive', 'defensive', 'Do you prefer an aggressive or defensive playstyle?']
  ])('clarifies %s once and resumes selected artifacts without acquisition or budget renewal', async (alternatives, preference, question) => {
    const run = harness();
    const request = { ...query, question: `${query.question} I'm undecided between ${alternatives}.` };
    const initial = await run.workflow.query(request, actor);
    expect(initial.body.frontendOutcome).toBe('need_new_source');
    const clarified = await run.submit(initial.body);
    expect(clarified.body).toMatchObject({ workflowId: initial.body.workflowId, revision: 1,
      frontendOutcome: 'clarification_required', nextAction: 'clarify', evidenceSelected: true,
      coverageSatisfied: true, missingCoverage: [], gapAssessmentStatus: 'assessed', clarification: question,
      discovery: { round: 1, recoveryRemaining: 1, remainingCandidateUrls: 5, remainingTotalAcquisitionMs: 23_750,
        searchQueries: [], continuationRequired: false, nextSubmissionCandidateLimit: 0 } });
    expect(clarified.body.selectedCandidateIds).toHaveLength(1);
    expect(clarified.body.selectedEvidenceIds!.length).toBeGreaterThan(0);
    expect(clarified.body.candidates).toEqual([expect.objectContaining({ candidateId: clarified.body.selectedCandidateIds![0], url: guideUrl })]);
    expect(clarified.body.clarification!.match(/\?/gu)).toHaveLength(1);
    expect(mockTrinity).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
    const continuation = { ...request, workflowId: clarified.body.workflowId, expectedRevision: clarified.body.revision,
      idempotencyKey: 'clarification-answer', constraints: [preference] };
    const resumed = await run.workflow.query(continuation, actor);
    expect(resumed.body).toMatchObject({ workflowId: initial.body.workflowId, revision: 2,
      frontendOutcome: 'answer_ready', evidenceSelected: true, coverageSatisfied: true, missingCoverage: [],
      selectedCandidateIds: clarified.body.selectedCandidateIds, selectedEvidenceIds: clarified.body.selectedEvidenceIds,
      requirementSupport: clarified.body.requirementSupport, candidates: clarified.body.candidates });
    expect(resumed.body.answer!.sources.map(source => source.url)).toEqual([guideUrl]);
    expect(resumed.body.answer!.response).toMatch(/current.?patch compatibility.*(?:not|unverified|could not)/iu);
    expect(mockTrinity).toHaveBeenCalledTimes(1); expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(run.retrieve).toHaveBeenCalledTimes(1); expect(run.evaluateCandidates).toHaveBeenCalledTimes(1); expect(mockHttp).toHaveBeenCalledTimes(1);
    expect(await run.workflow.query(continuation, actor)).toEqual(resumed);
    expect(mockTrinity).toHaveBeenCalledTimes(1);
    expect((await run.submit(resumed.body, 'after-answer')).body.reason).toBe('WORKFLOW_CLOSED');
  });

  it('keeps all search/recovery allowances after rejecting a changed scope during clarification', async () => {
    const run = harness();
    const request = { ...query, question: `${query.question} I'm undecided between bleed and pure Dexterity.` };
    const initial = await run.workflow.query(request, actor);
    const clarified = await run.submit(initial.body);
    // A player constraint is context, never source evidence. The retained guide
    // cannot establish an explicitly requested expansion-only recommendation.
    const conflict = await run.workflow.query({ ...request, workflowId: clarified.body.workflowId, expectedRevision: 1,
      idempotencyKey: 'clarification-conflict', edition: 'Shadow of the Erdtree', constraints: ['pure Dexterity'] }, actor);
    expect(conflict.body.reason).toBe('QUERY_CONTEXT_CONFLICT');
    const unchanged = await run.workflow.query(request, actor);
    expect(unchanged.body).toMatchObject({ workflowId: clarified.body.workflowId, revision: 1,
      selectedCandidateIds: clarified.body.selectedCandidateIds, selectedEvidenceIds: clarified.body.selectedEvidenceIds,
      candidates: clarified.body.candidates, coverageSatisfied: true, discovery: clarified.body.discovery });
    expect(run.retrieve).toHaveBeenCalledTimes(1); expect(mockHttp).toHaveBeenCalledTimes(1);
  });

  it('asks one targeted question at a time for two unresolved choices without consuming recovery', async () => {
    const run = harness();
    const request = { ...query, question: `${query.question} I'm undecided between bleed and pure Dexterity. I'm undecided between single katana and dual wield.` };
    const initial = await run.workflow.query(request, actor); const first = await run.submit(initial.body);
    expect(first.body.clarification).toBe('Do you prefer bleed or pure Dexterity?');
    const second = await run.workflow.query({ ...request, workflowId: first.body.workflowId, expectedRevision: 1,
      idempotencyKey: 'clarification-first-choice', constraints: ['pure Dexterity'] }, actor);
    expect(second.body).toMatchObject({ workflowId: first.body.workflowId, revision: 2,
      frontendOutcome: 'clarification_required', clarification: 'Do you prefer a single katana or dual wielding?',
      evidenceSelected: true, coverageSatisfied: true, selectedCandidateIds: first.body.selectedCandidateIds,
      selectedEvidenceIds: first.body.selectedEvidenceIds, discovery: first.body.discovery });
    const final = await run.workflow.query({ ...request, workflowId: first.body.workflowId, expectedRevision: 2,
      idempotencyKey: 'clarification-second-choice', constraints: ['pure Dexterity', 'single katana'] }, actor);
    expect(final.body).toMatchObject({ workflowId: first.body.workflowId, revision: 3, frontendOutcome: 'answer_ready' });
    expect(mockTrinity).toHaveBeenCalledTimes(1); expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(run.retrieve).toHaveBeenCalledTimes(1);
  });

  it('does not classify missing factual evidence as a player preference or discard an admitted contribution', async () => {
    const run = harness();
    const request = { ...query, question: 'Recommend early-game Samurai katana weapon configuration and secret cavern upgrade route. I am undecided between bleed and pure Dexterity.' };
    const initial = await run.workflow.query(request, actor);
    const result = await run.submit(initial.body);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', coverageSatisfied: false, nextAction: 'search',
      discovery: { round: 1, recoveryRemaining: 1 } });
    expect(result.body.candidates![0].candidateId).toBeDefined();
    expect(result.body.clarification).toBeUndefined();
    expect(result.body.missingCoverage).toContain('requested topic 2');
    expect(mockTrinity).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
  });

  it('answers a useful unspecified-edition Samurai request with an explicit unknown-patch qualification', async () => {
    const run = harness(); const initial = await run.workflow.query(query, actor);
    const result = await run.submit(initial.body);
    expect(result.body).toMatchObject({ frontendOutcome: 'answer_ready', evidenceSelected: true, coverageSatisfied: true });
    expect(result.body.clarification).toBeUndefined();
    expect(result.body.answer!.response).toMatch(/current.?patch compatibility.*(?:not|unverified|could not)/iu);
    expect(mockTrinity).toHaveBeenCalledTimes(1); expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  it('requires missing material patch evidence before asking an unresolved player preference', async () => {
    const run = harness(); const initial = await run.workflow.query({ ...query, requestedVersion: '1.12',
      question: `${query.question} I'm undecided between bleed and pure Dexterity.` }, actor);
    const result = await run.submit(initial.body);
    expect(result.body.frontendOutcome).toBe('need_new_source');
    expect(result.body.clarification).toBeUndefined(); expect(result.body.answer).toBeUndefined();
    expect(result.body.candidates![0].candidateId).toBeDefined();
    expect(mockTrinity).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong game', guideHtml.replaceAll('Elden Ring', 'Sekiro'), 'GAME_MISMATCH'],
    ['DLC-only', guideHtml.replace('Edition: base game.', 'Edition: Shadow of the Erdtree.').replace('It does not cover Shadow of the Erdtree or other expansion content.', 'This guide only covers Shadow of the Erdtree expansion content.'), 'EDITION_CONFLICT']
  ])('rejects %s despite an unresolved player preference', async (_label, html, reason) => {
    mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: html }));
    const run = harness(); const initial = await run.workflow.query({ ...query,
      question: `${query.question} Without DLC. I'm undecided between bleed and pure Dexterity.` }, actor);
    const result = await run.submit(initial.body);
    expect(result.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: expect.arrayContaining([reason]) });
    expect(result.body.clarification).toBeUndefined(); expect(result.body.answer).toBeUndefined();
    expect(mockTrinity).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
  });

  it('fences clarification continuation by actor, revision, scope, policy, expiry and payload idempotency', async () => {
    const run = harness(); const request = { ...query, question: `${query.question} I'm undecided between bleed and pure Dexterity.` };
    const initial = await run.workflow.query(request, actor); const clarified = await run.submit(initial.body);
    const continuation = { ...request, workflowId: clarified.body.workflowId, expectedRevision: 1,
      idempotencyKey: 'clarification-fenced-answer', constraints: ['pure Dexterity'] };
    expect((await run.workflow.query(continuation, { actorKey: 'another-owner' })).body.reason).toBe('WORKFLOW_UNAVAILABLE');
    expect((await run.workflow.query({ ...continuation, expectedRevision: 0 }, actor)).body.reason).toBe('STALE_WORKFLOW_REVISION');
    for (const changes of [{ game: 'Sekiro' }, { question: 'Recommend a DLC build.' }, { storagePolicy: 'auto_store_approved' },
      { spoilerTolerance: 'full' }, { requestedVersion: '1.12' }, { class: 'Astrologer' }])
      expect((await run.workflow.query({ ...continuation, ...changes }, actor)).body.reason).toBe('QUERY_CONTEXT_CONFLICT');
    expect((await run.workflow.query({ ...continuation, constraints: ['bleed', 'pure Dexterity'] }, actor)).body.reason).toBe('CLARIFICATION_UNRESOLVED');
    const result = await run.workflow.query(continuation, actor);
    expect(result.body.frontendOutcome).toBe('answer_ready');
    expect((await run.workflow.query({ ...continuation, constraints: ['bleed'] }, actor)).body.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect(mockTrinity).toHaveBeenCalledTimes(1); expect(mockHttp).toHaveBeenCalledTimes(1);
    run.advance(10 * 60_000);
    expect((await run.workflow.query({ ...continuation, idempotencyKey: 'clarification-expired' }, actor)).body.reason).toBe('WORKFLOW_UNAVAILABLE');
  });

  it('preserves comparison requests as factual work and honors an already selected preference', () => {
    const input = { game: query.game, mode: 'build' as const, prompt: "Recommend Samurai katana build. I'm undecided between bleed and pure Dexterity." };
    expect(resolveGamingUserDecisionGap({ ...input, constraints: ['pure Dexterity'] }).clarification).toBeUndefined();
    expect(resolveGamingUserDecisionGap({ ...input, prompt: 'Compare bleed versus pure Dexterity.' })).toEqual({ prompt: 'Compare bleed versus pure Dexterity.' });
    expect(resolveGamingUserDecisionGap({ ...input, prompt: query.question }).clarification).toBeUndefined();
    for (const constraint of ["I'm still undecided about bleed", 'do not use aggressive', 'not pure Dexterity', 'bleed or pure Dexterity'])
      expect(resolveGamingUserDecisionGap({ ...input, constraints: [constraint] }).clarification).toBeDefined();
  });
});
