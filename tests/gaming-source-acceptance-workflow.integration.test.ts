import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingSourceAcceptanceCases, gamingSourceAcceptanceHtml } from './fixtures/gaming-source-acceptance.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

const mockHttp = jest.fn();
const mockProvider = jest.fn();
const forbiddenWrite = jest.fn(async () => { throw new Error('Durable writes are forbidden in this transient fixture.'); });
const forbiddenDatabase = jest.fn(async () => { throw new Error('Database access is forbidden in this fixture.'); });
const mockMemory = jest.fn(() => ({ relevantEntries: [], contextSummary: '', accessLog: [] }));
const stages: string[] = [];
const auditInputs: any[] = [];
let answerSentences: string[] = [];
let expectedQuestion = '';
let currentHtml = '';
let clock = Date.parse('2026-10-13T12:00:00.000Z');

// Only external acquisition/provider transports and forbidden persistence sinks
// are replaced. Candidate validation, selection, Trinity intake/reasoning/final,
// model-response/schema checks, and the bound CLEAR answer audit remain real.
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
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { resetSafetyRuntimeStateForTests } = await import('../src/services/safety/runtimeState.js');
const { resetTrinitySelfHealingStateForTests } = await import('../src/services/selfImprove/selfHealingV2.js');
const contractVersion = 'gaming-hybrid-v2';
const url = 'https://guides.example.org/source-acceptance/guide';
const context = { actorKey: 'source-acceptance-transient-fixture' };
const env = {
  ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '12000',
  ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200',
  FINETUNED_MODEL_ID: 'ft:gpt-4.1:synthetic:source-acceptance-authority'
};
let previousEnv: Record<string, string | undefined>;

function providerInputText(payload: any): string {
  return typeof payload.input === 'string' ? payload.input
    : payload.input.flatMap((message: any) => typeof message.content === 'string' ? [message.content]
      : message.content?.map((part: any) => part.text ?? '') ?? []).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks(); stages.length = 0; auditInputs.length = 0;
  resetSafetyRuntimeStateForTests(); resetTrinitySelfHealingStateForTests();
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  clock = Date.parse('2026-10-13T12:00:00.000Z');
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
        achievable_subtasks: ['answer using the acquired guide'], blocked_subtasks: [], user_visible_caveats: [],
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
      }])), findings: [] });
    } else if (stages.length === 0) {
      stages.push('intake');
      expect(input).toContain(expectedQuestion);
      text = 'Task: give beginner guidance from Source 1 while retaining player progression constraints and source qualifications.';
    } else {
      stages.push('final');
      expect(input).toContain(expectedQuestion);
      for (const sentence of answerSentences) expect(input).toContain(sentence);
      text = answer;
    }
    return { id: `synthetic-${stages.at(-1)}`, model: payload.model, status: 'completed',
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
  const start = () => workflow.query({ contractVersion, idempotencyKey: 'acceptance-query-001',
    mode: 'build', storagePolicy: 'transient_only', ...Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) }, context);
  const submit = (state: GamingHybridResponse, key = 'acceptance-submit-001', sourceUrl = url) => workflow.candidates({
    contractVersion, workflowId: state.workflowId, expectedRevision: state.revision,
    discoveryType: 'gameplay_evidence', idempotencyKey: key, candidates: [{ url: sourceUrl }]
  }, context);
  return { retrieve, workflow, start, submit };
}

const fixtures = gamingSourceAcceptanceCases.flatMap(fixture => (
  fixture.id === 'fallout-76' ? [fixture.genericTitle, 'Heavy Gunner', 'Power Armor', 'Power Armour'] : [fixture.genericTitle]
).map(title => ({
  ...fixture, acquiredTitle: title, name: `${fixture.game} (${title})`, html: gamingSourceAcceptanceHtml(fixture, { title, furniture: true, records: '' }),
  class: fixture.id === 'elden-ring' ? 'Samurai' : undefined,
  role: fixture.id === 'fallout-76' ? 'Heavy Gunner' : undefined,
  progressPoint: fixture.id === 'elden-ring' ? 'just left the tutorial' : 'just left Vault 76',
  sentences: fixture.id === 'elden-ring'
    ? ['Immediately after the tutorial, practice the starting weapon and preserve stamina for dodging after attacks.',
      'Raise Vigor for survival and upgrade Uchigatana as Smithing Stones become available.']
    : ['In Fallout 76, a beginner Heavy Gunner immediately after leaving Vault 76 should first use available equipment, collect ammunition, and repair the starter weapon.',
      'The Heavy Gunner build is a later progression goal: do not assume heavy weapons, Power Armor, or later perks are already available.']
})));

describe('source acceptance through the actual hybrid-v2 and Trinity pipeline', () => {
  it.each(['Heavy Gunner', 'Power Armor', 'Power Armour'].flatMap(title =>
    ['missing', 'comparison'].map(scope => ({ title, scope }))))
  ('does not select the bare topic $title with $scope affirmative game scope', async ({ title, scope }) => {
    const fixture = fixtures[1];
    currentHtml = gamingSourceAcceptanceHtml(fixture, { title, records: '', prose: fixture.prose.replace('In Fallout 76, ',
      scope === 'comparison' ? 'Unlike in Fallout 76, ' : '') });
    const run = harness({ game: fixture.game, question: fixture.question, role: fixture.role, progressPoint: fixture.progressPoint });
    const initial = await run.start();
    const final = await run.submit(initial.body);
    expect(final.body).toMatchObject({ nextAction: 'search', evidenceSelected: false });
    expect(final.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
    expect(final.body.answer).toBeUndefined();
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it.each(fixtures)('grounds $name using acquired, selected passages without durable writes', async fixture => {
    currentHtml = fixture.html; answerSentences = fixture.sentences; expectedQuestion = fixture.question;
    const run = harness({ game: fixture.game, question: fixture.question, class: fixture.class,
      role: fixture.role, progressPoint: fixture.progressPoint });
    const initial = await run.start();
    expect(initial.body).toMatchObject({ contractVersion, nextAction: 'search', coverageSatisfied: false, evidenceSelected: false });
    expect(mockProvider).not.toHaveBeenCalled();
    const final = await run.submit(initial.body);
    expect(final.body).toMatchObject({ contractVersion, revision: 1, nextAction: 'answer', state: 'answer_ready',
      coverageSatisfied: true, evidenceSelected: true, missingCoverage: [], answer: { provenance: 'arcanos-trinity' } });
    expect(final.body.selectedCandidateIds).toHaveLength(1);
    expect(final.body.selectedEvidenceIds!.length).toBeGreaterThan(0);
    expect(final.body.answer!.sources).toEqual([expect.objectContaining({ url, sourceId: final.body.selectedCandidateIds![0] })]);
    expect(final.body.answer!.response).toContain('[Source 1]');
    expect(final.body.answer!.response).toMatch(/current.?patch compatibility.*(?:not|unverified|could not)/iu);
    for (const sentence of fixture.sentences) expect(final.body.answer!.response).toContain(sentence);
    expect(stages).toEqual(['intake', 'reasoning', 'final', 'answer_audit']);
    expect(mockHttp).toHaveBeenCalledTimes(1);
    expect(mockProvider).toHaveBeenCalledTimes(4);
    expect(auditInputs[0].evidence.every((chunk: any) => final.body.selectedCandidateIds!.includes(chunk.sourceId)
      && final.body.selectedEvidenceIds!.includes(chunk.chunkId))).toBe(true);
    expect(JSON.stringify(auditInputs[0].evidence)).not.toContain(fixture.unrelatedGame);
    const sourceEvaluation = (logger.info as jest.Mock).mock.calls.find(call => call[0] === 'gaming.source.evaluation')![1] as any;
    expect(sourceEvaluation).toMatchObject({ outcome: 'selected', stages: {
      acquisition: { status: 'passed', reasonCode: 'SOURCE_ACQUIRED' },
      extraction: { status: 'passed', reasonCode: 'EXTRACTION_INTACT', diagnostic: { truncated: false, partialRecords: 0, ambiguousRecords: 0 } },
      identity: { status: 'passed', diagnostic: { identityRuleId: 'gaming.identity.acquired_anchors_verified' } },
      applicability: { status: 'passed' }, relevance: { status: 'passed' }, provenance: { status: 'passed' },
      selection: { status: 'passed', reasonCode: 'EVIDENCE_SELECTED' }
    } });
    expect(JSON.stringify(sourceEvaluation)).not.toContain(fixture.prose);
    expect(await run.submit(initial.body)).toEqual(final);
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockProvider).toHaveBeenCalledTimes(4);
  });

  it.each(fixtures)('stops $name with accepted but insufficient evidence after its bounded recovery', async fixture => {
    currentHtml = fixture.html;
    const run = harness({ game: fixture.game, question: `${fixture.question} Explain cooking recipes.`,
      class: fixture.class, role: fixture.role, progressPoint: fixture.progressPoint });
    const initial = await run.start();
    const first = await run.submit(initial.body);
    expect(first.body).toMatchObject({ contractVersion, revision: 1, nextAction: 'search', coverageSatisfied: false,
      evidenceSelected: true, discovery: { recoveryRemaining: 1, replacementAllowed: true } });
    expect(first.body.candidates![0].decision).toBe('accepted_transient');
    expect(first.body.missingCoverage!.length).toBeGreaterThan(0);
    const final = await run.submit(first.body, 'acceptance-recovery-002', `${url}-replacement`);
    expect(final.body).toMatchObject({ contractVersion, revision: 2, nextAction: 'stop', coverageSatisfied: false,
      discovery: { recoveryRemaining: 0, continuationRequired: false, replacementAllowed: false } });
    expect(final.body.answer).toBeUndefined();
    expect(final.body.missingCoverage!.length).toBeGreaterThan(0);
    expect(final.body.candidates!.every(candidate => candidate.decision === 'accepted_transient')).toBe(true);
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockHttp).toHaveBeenCalledTimes(2);
    expect((await run.submit(final.body, 'acceptance-forbidden-third', `${url}-third`)).body.reason).toBe('WORKFLOW_CLOSED');
    expect(mockHttp).toHaveBeenCalledTimes(2); expect(mockProvider).not.toHaveBeenCalled();
  });

  it.each(fixtures)('stops $name when both acquired guides actually declare another game', async fixture => {
    currentHtml = gamingSourceAcceptanceHtml(fixture, { title: fixture.id === 'fallout-76' ? fixture.acquiredTitle : fixture.title,
      prose: fixture.prose.replaceAll(fixture.game, fixture.unrelatedGame), records: '' });
    const run = harness({ game: fixture.game, question: fixture.question,
      class: fixture.class, role: fixture.role, progressPoint: fixture.progressPoint });
    const initial = await run.start();
    const first = await run.submit(initial.body);
    expect(first.body.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] });
    expect(first.body).toMatchObject({ contractVersion, revision: 1, nextAction: 'search', coverageSatisfied: false,
      evidenceSelected: false, discovery: { recoveryRemaining: 1 } });
    const final = await run.submit(first.body, 'acceptance-wrong-game-recovery', `${url}-wrong-game-replacement`);
    expect(final.body).toMatchObject({ contractVersion, revision: 2, nextAction: 'stop',
      coverageSatisfied: false, evidenceSelected: false, selectedCandidateIds: [], selectedEvidenceIds: [],
      discovery: { recoveryRemaining: 0, continuationRequired: false, replacementAllowed: false } });
    expect(final.body.answer).toBeUndefined();
    expect(final.body.candidates).toHaveLength(2);
    expect(final.body.candidates!.every(candidate => candidate.reasonCodes.includes('GAME_MISMATCH'))).toBe(true);
    const evaluations = (logger.info as jest.Mock).mock.calls.filter(call => call[0] === 'gaming.source.evaluation').map(call => call[1]) as any[];
    expect(evaluations).toHaveLength(2);
    for (const evaluation of evaluations) expect(evaluation).toMatchObject({ outcome: 'rejected', stages: {
      acquisition: { status: 'passed' }, extraction: { status: 'passed' },
      identity: { status: 'rejected', reasonCode: 'GAME_MISMATCH', diagnostic: {
        identityRuleId: fixture.id === 'elden-ring' ? 'gaming.identity.distinct_body_scope' : 'gaming.identity.affirmative_body_scope_conflict'
      } },
      applicability: { status: 'not_run' }, selection: { status: 'not_run' }, generation: { status: 'not_run' }
    } });
    expect(mockHttp).toHaveBeenCalledTimes(2); expect(mockProvider).not.toHaveBeenCalled();
  });
});
