import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingUniversalIdentityFixtures, gamingUniversalIdentityHtml } from './fixtures/gaming-universal-identity.js';
import { gamingIndependentWorkflowFixtures } from './fixtures/gaming-independent-workflow.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import { resolveGamingRegistryGame } from '../src/shared/gaming/gamingGameRegistry.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

const mockHttp = jest.fn();
const mockProvider = jest.fn();
const forbiddenWrite = jest.fn(async () => { throw new Error('Persistent writes are forbidden in this synthetic fixture.'); });
const forbiddenDatabase = jest.fn(async () => { throw new Error('Database access is forbidden in this synthetic fixture.'); });
const mockMemory = jest.fn(() => ({ relevantEntries: [], contextSummary: '', accessLog: [] }));
const stages: string[] = [];
const auditInputs: any[] = [];
let answerSentences: readonly string[] = [];
let expectedQuestion = '';
let currentHtml = '';
let auditRejects = false;
let clock = Date.parse('2026-10-14T12:00:00.000Z');

// These are synthetic acquisition/provider transports and empty corpus/memory
// reads. Real resolver attestation, extraction, identity/applicability, CLEAR,
// coverage, selection, hybrid revision/recovery, Trinity stages and answer
// binding run. Semantic provider judgment is deliberately a labeled fixture.
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {
  responses: { create: mockProvider }, models: { retrieve: async (id: string) => ({ id }) }
} }) }));
jest.unstable_mockModule('@services/memoryAware.js', () => ({ getMemoryContext: mockMemory, storePattern: forbiddenWrite }));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback: forbiddenWrite }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: forbiddenWrite }));
jest.unstable_mockModule('../src/core/db/client.js', () => ({
  getPool: () => ({ query: forbiddenDatabase, connect: forbiddenDatabase }), isDatabaseConnected: () => true,
  initializeDatabase: forbiddenDatabase, closePoolIfCurrent: jest.fn(), close: jest.fn(), getStatus: jest.fn()
}));
jest.unstable_mockModule('../src/core/db/index.js', () => ({
  getPool: () => ({ query: forbiddenDatabase, connect: forbiddenDatabase }), isDatabaseConnected: () => true,
  query: forbiddenDatabase, transaction: forbiddenDatabase
}));

const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { resetSafetyRuntimeStateForTests } = await import('../src/services/safety/runtimeState.js');
const { resetTrinitySelfHealingStateForTests } = await import('../src/services/selfImprove/selfHealingV2.js');
const contractVersion = 'gaming-hybrid-v2';
// URL paths and submitted metadata contain no acquired game identity.
const url = 'https://guides.example.org/universal/fixture';
const context = { actorKey: 'universal-transient-synthetic-fixture' };
const reviewedFixtures = [...gamingUniversalIdentityFixtures, ...gamingIndependentWorkflowFixtures];
// An ordinary word needs an explicit acquired game declaration. This source
// assertion comes from the synthetic document, never from submitted metadata.
const reviewedHtml: typeof gamingUniversalIdentityHtml = (fixture, options = {}) =>
  gamingUniversalIdentityHtml(fixture, options).replace(/<p>In /gu, '<p>In the game ');
const env = {
  ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '12000',
  ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200',
  FINETUNED_MODEL_ID: 'ft:gpt-4.1:synthetic:universal-workflow-authority'
};
let previousEnv: Record<string, string | undefined>;

function providerInputText(payload: any): string {
  return typeof payload.input === 'string' ? payload.input
    : payload.input.flatMap((message: any) => typeof message.content === 'string' ? [message.content]
      : message.content?.map((part: any) => part.text ?? '') ?? []).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks(); stages.length = 0; auditInputs.length = 0; auditRejects = false;
  mockHttp.mockReset(); mockProvider.mockReset();
  resetSafetyRuntimeStateForTests(); resetTrinitySelfHealingStateForTests();
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  clock = Date.parse('2026-10-14T12:00:00.000Z');
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'clearImmediate', 'nextTick', 'hrtime', 'performance', 'queueMicrotask'] });
  jest.setSystemTime(clock);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockHttp.mockImplementation(async (target: string, options: any) => {
    expect(new URL(target).hostname).toBe('93.184.216.34');
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'stream' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('Cookie');
    clock += 25; jest.setSystemTime(clock);
    return { status: 200, data: currentHtml, headers: { 'content-type': 'text/html' } };
  });
  mockProvider.mockImplementation(async (payload: any) => {
    const input = providerInputText(payload);
    const answer = `${answerSentences.join(' ')} [Source 1]`;
    let text: string;
    if (payload.text?.format?.type === 'json_schema') {
      stages.push('reasoning');
      expect(input).toContain(expectedQuestion);
      for (const sentence of answerSentences) expect(input).toContain(sentence);
      text = JSON.stringify({ reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [],
        alternatives_considered: [], chosen_path_justification: '', response_mode: 'answer',
        achievable_subtasks: ['answer using acquired synthetic passages'], blocked_subtasks: [], user_visible_caveats: [],
        claim_tags: [], final_answer: answer });
    } else if (payload.text?.format?.type === 'json_object') {
      stages.push('answer_audit');
      const data = payload.input.flatMap((message: any) => message.content ?? [])
        .map((part: any) => part.text).find((value: unknown) => typeof value === 'string' && value.startsWith('{"answer":'));
      const audited = JSON.parse(data);
      auditInputs.push(audited);
      expect(audited.question).toBe(expectedQuestion);
      expect(audited.evidence.length).toBeGreaterThan(0);
      for (const sentence of answerSentences) {
        expect(audited.answer).toContain(sentence);
        expect(audited.evidence.some((chunk: any) => chunk.text.includes(sentence))).toBe(true);
      }
      const refs = audited.evidence.map((chunk: any) => chunk.chunkId);
      text = JSON.stringify({ dimensions: Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
        status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED_SYNTHETIC_PASSAGE'], evidenceRefs: refs.slice(0, 8), unresolvedFacts: []
      }])), findings: auditRejects ? [{ code: 'SYNTHETIC_UNSUPPORTED_CLAIM', severity: 'blocking', evidenceRefs: refs.slice(0, 1) }] : [] });
    } else if (stages.length === 0) {
      stages.push('intake');
      expect(input).toContain(expectedQuestion);
      text = 'Task: answer the requested mechanic using Source 1 and retain its scope and qualifications.';
    } else {
      stages.push('final');
      expect(input).toContain(expectedQuestion);
      for (const sentence of answerSentences) expect(input).toContain(sentence);
      text = answer;
    }
    return { id: `synthetic-universal-${stages.at(-1)}`, model: payload.model, status: 'completed',
      output_text: text, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 400, output_tokens: 150, total_tokens: 550 } };
  });
});
afterEach(() => {
  expect(forbiddenWrite).not.toHaveBeenCalled(); expect(forbiddenDatabase).not.toHaveBeenCalled();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  jest.restoreAllMocks(); jest.useRealTimers(); resetSafetyRuntimeStateForTests(); resetTrinitySelfHealingStateForTests();
});

function harness(query: Record<string, unknown>) {
  const retrieve = jest.fn(async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }));
  const workflow = createGamingHybridWorkflow({ retrieve, ingest: forbiddenWrite as never, now: () => clock });
  const start = () => workflow.query({ contractVersion, idempotencyKey: 'universal-query-001',
    mode: 'guide', storagePolicy: 'transient_only', ...query }, context);
  const submit = (state: GamingHybridResponse, key = 'universal-submit-001', sourceUrl = url,
    caller = context, candidate = {}) => workflow.candidates({
    contractVersion, workflowId: state.workflowId, expectedRevision: state.revision,
    discoveryType: state.discovery?.type ?? 'gameplay_evidence', idempotencyKey: key, candidates: [{ url: sourceUrl, ...candidate }]
  }, caller);
  return { retrieve, workflow, start, submit };
}

describe('universal acquired evidence through actual hybrid-v2 and Trinity stages (synthetic providers)', () => {
  it('includes eight requested games plus a synthetic title absent from the production registry', () => {
    expect(new Set(gamingUniversalIdentityFixtures.map(fixture => fixture.game)).size).toBe(9);
    expect(resolveGamingRegistryGame('Copperwind Loom')).toBeUndefined();
    for (const fixture of gamingIndependentWorkflowFixtures) expect(resolveGamingRegistryGame(fixture.game)).toBeUndefined();
  });

  it.each(reviewedFixtures)('answers $game / $genre from its novel generic topic without a class or registry override', async fixture => {
    currentHtml = reviewedHtml(fixture, { furniture: true,
      ...(gamingIndependentWorkflowFixtures.includes(fixture) ? { title: `${fixture.topic} guide` } : {}) });
    // Guide excerpt selection is conservative: answer the requested mechanic
    // from the independently selected first passage, not every article section.
    answerSentences = fixture.mode === 'guide' ? fixture.sentences.slice(0, 1) : fixture.sentences;
    expectedQuestion = fixture.question;
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    expect(initial.body).toMatchObject({ nextAction: 'search', evidenceSelected: false });
    expect(mockProvider).not.toHaveBeenCalled();
    const final = await run.submit(initial.body);
    expect(final.body).toMatchObject({ contractVersion, revision: 1, nextAction: 'answer', state: 'answer_ready',
      coverageSatisfied: true, evidenceSelected: true, missingCoverage: [], answer: { provenance: 'arcanos-trinity' } });
    expect(final.body.answer!.response).toContain('[Source 1]');
    for (const sentence of answerSentences) expect(final.body.answer!.response).toContain(sentence);
    expect(final.body.answer!.sources).toEqual([expect.objectContaining({ url, sourceId: final.body.selectedCandidateIds![0] })]);
    expect(stages).toEqual(['intake', 'reasoning', 'final', 'answer_audit']);
    expect(auditInputs[0].game).toBe(fixture.game);
    expect(auditInputs[0].playerContext.class).toBeUndefined();
    expect(auditInputs[0].playerContext.role).toBeUndefined();
    expect(auditInputs[0].evidence.every((chunk: any) => final.body.selectedCandidateIds!.includes(chunk.sourceId)
      && final.body.selectedEvidenceIds!.includes(chunk.chunkId))).toBe(true);
    expect(JSON.stringify(auditInputs[0].evidence)).not.toMatch(/FURNITURE_ONLY/u);
    expect(JSON.stringify(auditInputs[0].evidence)).not.toContain(`In the game ${fixture.unrelatedGame},`);
    expect(final.body.answer!.response).not.toContain('UNRELATED_ARTICLE_SECTION');
    if (fixture.mode === 'guide') expect(JSON.stringify(auditInputs[0].evidence)).not.toContain('UNRELATED_ARTICLE_SECTION');
    expect(mockHttp).toHaveBeenCalledTimes(1);
    expect(mockProvider).toHaveBeenCalledTimes(4);
    expect(await run.submit(initial.body)).toEqual(final);
    expect((await run.submit(initial.body, 'new-operation-after-answer')).body.reason).toBe('WORKFLOW_CLOSED');
    expect((await run.submit(initial.body, 'universal-submit-001', `${url}-changed`)).body.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect((await run.submit(final.body, 'other-actor', url, { actorKey: 'different-universal-actor' })).body.reason).toBe('WORKFLOW_UNAVAILABLE');
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockProvider).toHaveBeenCalledTimes(4);
  });

  it.each(gamingUniversalIdentityFixtures.flatMap(fixture => ['missing', 'comparison'].map(scope => ({ fixture, scope }))))
  ('rejects $fixture.game generic topics with $scope game scope even when caller hints claim the game', async ({ fixture, scope }) => {
    currentHtml = gamingUniversalIdentityHtml(fixture, { scope: scope as 'missing' | 'comparison' });
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const final = await run.submit(initial.body, undefined, undefined, context,
      { claimedGame: fixture.game, title: `${fixture.game} guide` });
    expect(final.body).toMatchObject({ nextAction: 'search', evidenceSelected: false, coverageSatisfied: false });
    expect(final.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it.each(reviewedFixtures)('refuses $game after bounded wrong-game recovery', async fixture => {
    currentHtml = gamingUniversalIdentityHtml(fixture, { scope: 'wrong' });
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const first = await run.submit(initial.body);
    expect(first.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] });
    expect(first.body).toMatchObject({ revision: 1, nextAction: 'search', evidenceSelected: false,
      discovery: { recoveryRemaining: 1 } });
    const final = await run.submit(first.body, 'wrong-game-recovery', `${url}-replacement`);
    expect(final.body).toMatchObject({ revision: 2, nextAction: 'stop', evidenceSelected: false,
      coverageSatisfied: false, selectedCandidateIds: [], selectedEvidenceIds: [], discovery: { recoveryRemaining: 0 } });
    expect(final.body.answer).toBeUndefined();
    expect(final.body.candidates!.every(candidate => candidate.reasonCodes.includes('GAME_MISMATCH'))).toBe(true);
    expect(mockHttp).toHaveBeenCalledTimes(2); expect(mockProvider).not.toHaveBeenCalled();
  });

  it.each(reviewedFixtures)('keeps incomplete $game question coverage out of Trinity', async fixture => {
    currentHtml = reviewedHtml(fixture);
    const question = `${fixture.question} Explain luminescent cartography.`;
    const run = harness({ game: fixture.game, question, mode: fixture.mode });
    const initial = await run.start();
    const first = await run.submit(initial.body);
    expect(first.body).toMatchObject({ revision: 1, nextAction: 'search', coverageSatisfied: false,
      evidenceSelected: true, discovery: { recoveryRemaining: 1 } });
    expect(['accepted_transient', 'eligible_for_ingestion']).toContain(first.body.candidates![0].decision);
    expect((await run.submit(initial.body, 'stale-during-recovery')).body.reason).toBe('STALE_WORKFLOW_REVISION');
    const final = await run.submit(first.body, 'insufficient-recovery', `${url}-replacement`);
    expect(final.body).toMatchObject({ revision: 2, nextAction: 'stop', coverageSatisfied: false,
      discovery: { recoveryRemaining: 0, replacementAllowed: false } });
    expect(final.body.answer).toBeUndefined();
    expect(final.body.missingCoverage!.length).toBeGreaterThan(0);
    expect((await run.submit(final.body, 'third-round', `${url}-third`)).body.reason).toBe('WORKFLOW_CLOSED');
    expect(mockHttp).toHaveBeenCalledTimes(2); expect(mockProvider).not.toHaveBeenCalled();
  });

  it.each(gamingUniversalIdentityFixtures)('does not promote an ambiguous foreign bare scope as $game', async fixture => {
    currentHtml = gamingUniversalIdentityHtml(fixture, { scope: 'bare_wrong' });
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const final = await run.submit(initial.body);
    expect(final.body).toMatchObject({ evidenceSelected: false, coverageSatisfied: false });
    expect(final.body.candidates![0].decision).toBe('rejected');
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it.each(gamingUniversalIdentityFixtures.filter(fixture => ['farm-layout', 'unknown-resonance'].includes(fixture.id)))
  ('withholds the $game answer when the synthetic semantic auditor rejects it', async fixture => {
    currentHtml = gamingUniversalIdentityHtml(fixture);
    answerSentences = fixture.sentences; expectedQuestion = fixture.question; auditRejects = true;
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const final = await run.submit(initial.body);
    expect(stages).toEqual(['intake', 'reasoning', 'final', 'answer_audit']);
    expect(final.body.state).not.toBe('answer_ready');
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).toHaveBeenCalledTimes(4);
    expect(await run.submit(initial.body)).toEqual(final);
    expect(mockProvider).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: 'platform', metadata: '<p>Platforms: PlayStation 5.</p>', query: { platform: 'PC' }, reason: 'PLATFORM_MISMATCH' },
    { name: 'edition', metadata: '<p>Edition: Remastered.</p>', query: { edition: 'base-game' }, reason: 'EDITION_CONFLICT' }
  ])('keeps explicit $name contradictions terminal for an unregistered game', async ({ metadata, query, reason }) => {
    const fixture = gamingUniversalIdentityFixtures.at(-1)!;
    currentHtml = gamingUniversalIdentityHtml(fixture, { metadata });
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode, ...query });
    const initial = await run.start();
    const final = await run.submit(initial.body);
    expect(final.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: [reason] });
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('retains the acquisition deadline for an unknown game before any provider or persistence effect', async () => {
    const fixture = gamingUniversalIdentityFixtures.at(-1)!;
    currentHtml = gamingUniversalIdentityHtml(fixture);
    mockHttp.mockImplementationOnce(async () => {
      clock += 5_001; jest.setSystemTime(clock);
      const data = Object.assign(Readable.from([currentHtml]), { rawHeaders: ['content-type', 'text/html'] });
      data.on('error', () => undefined);
      return { status: 200, data, headers: { 'content-type': 'text/html' } };
    });
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const final = await run.submit(initial.body);
    expect(final.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['SOURCE_TIMEOUT'] });
    expect(final.body.evidenceSelected).toBe(false);
    expect(final.body.answer).toBeUndefined();
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockProvider).not.toHaveBeenCalled();
  });

  it('does not promote unsupported arbitrary table headers into a verified novel mechanic', async () => {
    const fixture = gamingUniversalIdentityFixtures.at(-1)!;
    // Generic identity does not broaden the closed structured-claim adapters.
    // An intact DOM row is not automatically supported gameplay evidence.
    currentHtml = `<html><head><title>${fixture.game} guide</title></head><body><article>`
      + `<h1>${fixture.game} guide</h1><p>Game: ${fixture.game}.</p>`
      + '<table><tr><th>Spindle</th><th>Braid</th><th>Pulse</th></tr>'
      + '<tr><td>lumen spindle</td><td>unlinked braid</td><td>ravel pulse</td></tr></table></article></body></html>';
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const final = await run.submit(initial.body);
    expect(final.body.evidenceSelected).toBe(false);
    expect(final.body.candidates![0].decision).toBe('rejected');
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('does not turn an unknown game identity into official current-patch authority', async () => {
    const fixture = gamingUniversalIdentityFixtures.at(-1)!;
    currentHtml = gamingUniversalIdentityHtml(fixture, { metadata: '<p>Patch: 1.0.</p>' });
    // Exercise the real candidate phase's authority boundary directly. Workflow
    // phase/revision checks are separate and cannot grant publisher authority.
    const final = await evaluateGamingHybridCandidates({ game: fixture.game,
      prompt: `What is the current patch in ${fixture.game}?`, mode: 'guide', protocolVersion: contractVersion,
      discoveryType: 'currentness_verification', candidates: [{ url }] }, context);
    expect(final.accepted).toEqual([]);
    expect(final.knowledge.sources).toEqual([]);
    expect(final.decisions[0]).toMatchObject({ decision: 'rejected', reasonCodes: ['REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED'] });
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockHttp).not.toHaveBeenCalled();
  });

  it.each([gamingUniversalIdentityFixtures[0], gamingIndependentWorkflowFixtures[0]])
  ('selects only independently acquired $game evidence beside a competing source', async fixture => {
    const goodHtml = reviewedHtml(fixture, { furniture: true });
    const wrongHtml = reviewedHtml({ ...fixture, game: fixture.unrelatedGame,
      unrelatedGame: fixture.game, topic: 'Conflicting movement' });
    const syntheticTransport = mockHttp.getMockImplementation()!;
    mockHttp.mockImplementation(async (target: string, options: any) => {
      currentHtml = new URL(target).pathname.endsWith('/competing') ? wrongHtml : goodHtml;
      return syntheticTransport(target, options);
    });
    answerSentences = fixture.sentences.slice(0, 1); expectedQuestion = fixture.question;
    const run = harness({ game: fixture.game, question: fixture.question, mode: fixture.mode });
    const initial = await run.start();
    const final = await run.workflow.candidates({ contractVersion, workflowId: initial.body.workflowId,
      expectedRevision: initial.body.revision, idempotencyKey: 'mixed-candidates', discoveryType: 'gameplay_evidence',
      candidates: [{ url }, { url: `${url}/competing` }] }, context);
    expect(final.body).toMatchObject({ state: 'answer_ready', evidenceSelected: true, coverageSatisfied: true });
    expect(final.body.candidates![1]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] });
    expect(final.body.selectedCandidateIds).toEqual([final.body.candidates![0].candidateId]);
    expect(final.body.answer!.sources).toEqual([expect.objectContaining({ url })]);
    expect(JSON.stringify(auditInputs[0].evidence)).not.toContain(fixture.unrelatedGame);
    expect(auditInputs[0].evidence.every((chunk: any) => chunk.sourceId === final.body.candidates![0].candidateId)).toBe(true);
    expect(mockHttp).toHaveBeenCalledTimes(2); expect(mockProvider).toHaveBeenCalledTimes(4);
  });

  it('withholds mixed acquired identities despite misleading URL and frontend claims', async () => {
    const fixture = gamingIndependentWorkflowFixtures[0];
    currentHtml = reviewedHtml(fixture, { title: 'Elden Ring Nightreign strategy' });
    answerSentences = fixture.sentences.slice(0, 1); expectedQuestion = fixture.question;
    const run = harness({ game: fixture.game, question: fixture.question });
    const initial = await run.start();
    const misleadingUrl = `${url}/fallout-76`;
    const final = await run.submit(initial.body, 'misleading-source', misleadingUrl, context,
      { claimedGame: 'Elden Ring', title: 'Fallout 76 guide' });
    expect(final.body).toMatchObject({ state: 'discovery_required', revision: 1, coverageSatisfied: false, evidenceSelected: false });
    expect(final.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] });
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).not.toHaveBeenCalled();
    const stopped = await run.submit(final.body, 'misleading-recovery', `${misleadingUrl}-replacement`);
    expect(stopped.body).toMatchObject({ nextAction: 'stop', revision: 2, coverageSatisfied: false, evidenceSelected: false });
    expect(mockProvider).not.toHaveBeenCalled();
  });
});
