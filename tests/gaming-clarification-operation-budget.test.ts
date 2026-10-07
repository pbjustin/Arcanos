import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';
import type { GamingHybridDependencies } from '../src/services/gamingHybridKnowledge.js';

const guideUrl = 'https://guides.example.org/elden-ring/early-samurai';
const guideHtml = readFileSync(new URL('./fixtures/gaming-samurai-guide.html', import.meta.url), 'utf8');
const guideWithPcControls = guideHtml.replace('<p>Game: Elden Ring. Edition: base game.</p>',
  '<p>Game: Elden Ring. Edition: base game. Platforms: PC.</p><p>PC Samurai katana keybindings use keyboard and mouse controls for movement and Unsheathe.</p>');
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

function harness(ingest?: GamingHybridDependencies['ingest']) {
  let clock = Date.now();
  const retrieve = jest.fn(async () => empty);
  const evaluateCandidates = jest.fn<typeof evaluateGamingHybridCandidates>(async (input, context) => {
    const result = await evaluateGamingHybridCandidates(input, context);
    clock += 250;
    return { ...result, acquisitionWorkMs: 250 };
  });
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates, now: () => clock, ...(ingest ? { ingest } : {}) });
  const submit = (body: GamingHybridResponse, suffix = 'initial') => workflow.candidates({ contractVersion,
    workflowId: body.workflowId, expectedRevision: body.revision, idempotencyKey: `clarification-source-${suffix}`,
    discoveryType: 'gameplay_evidence', candidates: [{ url: guideUrl + (suffix === 'initial' ? '' : `/${suffix}`) }] }, actor);
  return { workflow, retrieve, evaluateCandidates, submit, advance: (ms: number) => { clock += ms; } };
}

function queuedIngestion() {
  return jest.fn<GamingHybridDependencies['ingest']>(async () => ({ statusCode: 202, payload: {
    ok: true, ingestionId: 'd03f749a-c036-45df-995c-1897ae712da0', status: 'queued'
  } }) as Awaited<ReturnType<GamingHybridDependencies['ingest']>>);
}

describe('Gaming clarification operations preserve acquisition and storage allowances', () => {
  it('preserves authorized storage after missing platform, source recovery and three decisions', async () => {
    const ingest = queuedIngestion();
    const run = harness(ingest);
    const request = { ...query, storagePolicy: 'ask_before_store', question: `${query.question} Include keybindings. I'm undecided between bleed and pure Dexterity. I'm undecided between single katana and dual wield. I'm undecided between aggressive and defensive.` };
    const initial = await run.workflow.query(request, actor);
    expect(initial.body).toMatchObject({ reason: 'PLATFORM_REQUIRED', revision: 0 });
    const scopedRequest = { ...request, platform: 'PC' };
    const scoped = await run.workflow.query({ ...scopedRequest, workflowId: initial.body.workflowId,
      expectedRevision: 0, idempotencyKey: 'clarification-platform-answer' }, actor);
    expect(scoped.body).toMatchObject({ nextAction: 'search', revision: 1 });
    mockHttp.mockRejectedValueOnce(new Error('Synthetic unavailable guide'));
    const unavailable = await run.submit(scoped.body);
    expect(unavailable.body).toMatchObject({ nextAction: 'search', revision: 2, discovery: { round: 1, recoveryRemaining: 1 } });
    mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: guideWithPcControls }));
    let result = await run.submit(unavailable.body, 'recovery');
    expect(result.body).toMatchObject({ nextAction: 'clarify', revision: 3, clarification: 'Do you prefer bleed or pure Dexterity?' });
    const retained = result.body;
    expect(retained.discovery).toMatchObject({ round: 2, recoveryRemaining: 0,
      remainingCandidateUrls: 4, remainingTotalAcquisitionMs: 23_500 });
    const choices = ['pure Dexterity', 'single katana', 'defensive'];
    for (let count = 1; count <= choices.length; count += 1) {
      const continuation = { ...scopedRequest, constraints: choices.slice(0, count), workflowId: initial.body.workflowId,
        expectedRevision: result.body.revision, idempotencyKey: `clarification-budget-choice-${count}` };
      result = await run.workflow.query(continuation, actor);
      expect(result.body).toMatchObject({ selectedCandidateIds: retained.selectedCandidateIds,
        selectedEvidenceIds: retained.selectedEvidenceIds });
      if (result.body.nextAction === 'clarify') expect(result.body.discovery).toEqual(retained.discovery);
      expect(await run.workflow.query(continuation, actor)).toEqual(result);
    }
    expect(result.body).toMatchObject({ nextAction: 'answer', revision: 6, frontendOutcome: 'answer_ready' });
    const storage = { contractVersion, workflowId: initial.body.workflowId,
      idempotencyKey: 'clarification-budget-store', candidateIds: result.body.selectedCandidateIds,
      storagePolicy: 'ask_before_store', confirmStore: true };
    const stored = await run.workflow.ingest(storage, { ...actor, canStore: true });
    expect(stored).toMatchObject({ status: 202, body: { nextAction: 'poll_ingestion' } });
    expect(await run.workflow.ingest(storage, { ...actor, canStore: true })).toEqual(stored);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0]).toMatchObject({ storagePolicy: 'ask_before_store', confirmed: true,
      candidates: [expect.objectContaining({ candidateId: retained.selectedCandidateIds![0] })] });
    expect(ingest.mock.calls[0][1]).toMatchObject({ canStore: true });
    expect(run.retrieve).toHaveBeenCalledTimes(1); expect(run.evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(mockHttp).toHaveBeenCalledTimes(2); expect(mockTrinity).toHaveBeenCalledTimes(1); expect(mockAudit).toHaveBeenCalledTimes(1);
    expect((await run.submit(stored.body, 'after-storage')).body.reason).toBe('WORKFLOW_CLOSED');
  });

  it('bounds distinct clarification operations at eight while replay remains available', async () => {
    const run = harness();
    const request = { ...query, question: `${query.question} Include keybindings.` };
    let result = await run.workflow.query(request, actor);
    let first: Awaited<ReturnType<typeof run.workflow.query>> | undefined;
    let firstInput: Record<string, unknown> | undefined;
    for (let index = 1; index <= 8; index += 1) {
      const continuation = { ...request, workflowId: result.body.workflowId, expectedRevision: result.body.revision,
        idempotencyKey: `clarification-bounded-${index}` };
      result = await run.workflow.query(continuation, actor);
      expect(result.body).toMatchObject({ nextAction: 'clarify', reason: 'PLATFORM_REQUIRED', revision: index });
      if (index === 1) { first = result; firstInput = continuation; }
    }
    const denied = await run.workflow.query({ ...request, platform: 'PC', workflowId: result.body.workflowId,
      expectedRevision: result.body.revision, idempotencyKey: 'clarification-bounded-ninth' }, actor);
    expect(denied).toMatchObject({ status: 429, body: { reason: 'SUBMISSION_LIMIT_REACHED', revision: 8 } });
    expect(await run.workflow.query(firstInput, actor)).toEqual(first);
    expect(run.retrieve).toHaveBeenCalledTimes(1); expect(run.evaluateCandidates).not.toHaveBeenCalled();
    expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each(['gaming-hybrid-v1', 'gaming-hybrid-v2'])('preserves the six other-operation limit for %s and rejects caller prefix spoofing', async version => {
    const ingest = queuedIngestion();
    const run = harness(ingest);
    const request = { ...query, contractVersion: version, storagePolicy: 'ask_before_store', question: `${query.question} Include keybindings.` };
    let result = await run.workflow.query(version === contractVersion ? request : { ...request, platform: 'PC' }, actor);
    if (version === contractVersion) {
      for (let index = 1; index <= 8; index += 1) {
        result = await run.workflow.query({ ...request, ...(index === 8 ? { platform: 'PC' } : {}),
          workflowId: result.body.workflowId, expectedRevision: result.body.revision,
          idempotencyKey: `clarification-other-bound-${index}` }, actor);
      }
      expect(result.body).toMatchObject({ nextAction: 'search', revision: 8 });
    }
    mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: guideWithPcControls }));
    result = await run.workflow.candidates({ contractVersion: version, workflowId: result.body.workflowId,
      ...(version === contractVersion ? { expectedRevision: result.body.revision } : {}),
      idempotencyKey: 'clarify:other-bound-source', discoveryType: 'gameplay_evidence', candidates: [{ url: guideUrl }] }, actor);
    expect(result.body).toMatchObject({ nextAction: version === contractVersion ? 'answer' : 'verify_currentness',
      candidates: [expect.objectContaining({ decision: 'accepted_transient', candidateId: expect.any(String) })] });
    const storage = { contractVersion: version, workflowId: result.body.workflowId,
      candidateIds: result.body.selectedCandidateIds ?? result.body.candidates!.map(candidate => candidate.candidateId),
      storagePolicy: 'ask_before_store', confirmStore: true };
    let first: Awaited<ReturnType<typeof run.workflow.ingest>> | undefined;
    for (let index = 1; index <= 5; index += 1) {
      const stored = await run.workflow.ingest({ ...storage, idempotencyKey: `clarify:other-bound-store-${index}` }, { ...actor, canStore: true });
      expect(stored).toMatchObject({ status: 202, body: { nextAction: 'poll_ingestion' } });
      if (index === 1) first = stored;
    }
    const denied = await run.workflow.ingest({ ...storage, idempotencyKey: 'clarify:other-bound-store-sixth' }, { ...actor, canStore: true });
    expect(denied).toMatchObject({ status: 429, body: { reason: 'SUBMISSION_LIMIT_REACHED' } });
    expect(await run.workflow.ingest({ ...storage, idempotencyKey: 'clarify:other-bound-store-1' }, { ...actor, canStore: true })).toEqual(first);
    expect(ingest).toHaveBeenCalledTimes(5); expect(run.evaluateCandidates).toHaveBeenCalledTimes(1); expect(mockHttp).toHaveBeenCalledTimes(1);
  });
});
