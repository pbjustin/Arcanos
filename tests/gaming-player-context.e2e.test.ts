import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const responsesCreate = jest.fn();
const runStructuredReasoning = jest.fn();
const createGPT5Reasoning = jest.fn();
const storePattern = jest.fn();
const recordFeedback = jest.fn();

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'test',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true,
  setDefaultModel: jest.fn(),
  getDefaultModel: () => 'gpt-5.1',
  getComplexModel: () => 'gpt-5.1',
  getFallbackModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5.1',
  getTrinityReasoningModel: () => 'gpt-5.6-terra'
}));
jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({ runStructuredReasoning }));
jest.unstable_mockModule('@services/openai/chatFlow/index.js', () => ({ createGPT5Reasoning }));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: recordFeedback
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn()
}));

const searchActiveGamingKnowledge = jest.fn();
const findActiveGamingSourceIdentities = jest.fn();
const forbiddenWrite = jest.fn(() => { throw new Error('No persistent writes allowed in this fixture'); });
const modelClient = {
  models: { retrieve: jest.fn().mockResolvedValue({ id: 'gpt-5.1' }) },
  responses: { create: responsesCreate }
};
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: modelClient }) }));
jest.unstable_mockModule('@services/openai.js', () => ({ generateMockResponse: jest.fn(), getGPT5Model: () => 'gpt-5.1' }));
jest.unstable_mockModule('@services/hrcWrapper.js', () => ({ evaluateWithHRC: forbiddenWrite }));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({ planAutonomousWorkerJob: forbiddenWrite }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  ...Object.fromEntries(['createJob', 'createClaimedJobFence', 'claimNextPendingJob', 'claimNextPendingJobWithAdmission', 'deferJobForProviderRecovery', 'failPendingJobIfUnclaimed', 'normalizeJobClaimGeneration', 'recordJobHeartbeat', 'scheduleJobRetry', 'recoverStaleJobs', 'updateClaimedJobTerminal', 'updateJob', 'getLatestJob', 'getJobQueueSummary', 'getJobExecutionStatsSince'].map(name => [name, forbiddenWrite])),
  findOrCreateGptJob: forbiddenWrite, getJobById: forbiddenWrite,
  requestJobCancellation: forbiddenWrite,
  IdempotencyKeyConflictError: class extends Error {}, JobRepositoryUnavailableError: class extends Error {}
}));
jest.unstable_mockModule('@core/db/repositories/gamingSourceRepository.js', () => ({
  findActiveGamingSourceIdentities,
  searchActiveGamingKnowledge,
  createGamingSourceRepository: forbiddenWrite,
  findGamingSourceById: forbiddenWrite,
  queryActiveGamingKnowledge: searchActiveGamingKnowledge,
  listDueGamingSources: forbiddenWrite,
  markGamingSourceRefreshFailure: forbiddenWrite,
  GamingSourceCanonicalHashCollisionError: class extends Error {},
  PostgresGamingSourceRepository: class {},
  GAMING_KNOWLEDGE_RECORD_TYPES: ['guide', 'build', 'meta'],
  GAMING_SOURCE_TYPES: ['official', 'patch_notes', 'wiki', 'curated', 'supplied'],
  getGamingSourceById: forbiddenWrite,
  persistGamingSourceRevision: forbiddenWrite,
  GamingSourceRepositoryUnavailableError: class extends Error {}
}));
// Keep the HTTP router and public dispatcher real while binding only the module registry.
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: jest.fn(),
  resolveLegacyModule: forbiddenWrite,
  getModuleMetadata: () => ({ name: 'ARCANOS:GAMING', actions: ['query'], route: 'gaming', defaultAction: 'query', defaultTimeoutMs: 60000 }),
  dispatchModuleAction: async (_module: string, action: string, payload: Record<string, unknown>) => {
    if (action !== 'query') throw new Error('Only gameplay queries are permitted by this fixture');
    return gamingModule.actions.query(payload);
  }
}));
jest.unstable_mockModule('@services/arcanos-core.js', () => ({
  buildArcanosCoreTimeoutFallbackEnvelope: forbiddenWrite, resolveArcanosCoreTimeoutPhase: forbiddenWrite
}));
jest.unstable_mockModule('@services/naturalLanguageMemory.js', () => ({
  executeNaturalLanguageMemoryCommand: forbiddenWrite,
  parseNaturalLanguageMemoryCommand: () => ({ intent: 'unknown' }),
  extractNaturalLanguageSessionId: () => null,
  extractNaturalLanguageStorageLabel: () => null,
  hasDagOrchestrationIntentCue: () => false,
  hasNaturalLanguageMemoryCue: () => false
}));
jest.unstable_mockModule('@services/arcanosMcp.js', () => ({ arcanosMcpService: { invokeTool: forbiddenWrite, listTools: forbiddenWrite } }));
jest.unstable_mockModule('@services/systemState.js', () => ({ executeSystemStateRequest: forbiddenWrite, SystemStateConflictError: class extends Error {} }));
jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({ saveMessage: forbiddenWrite }));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: async () => ({ 'arcanos-gaming': { module: 'ARCANOS:GAMING', route: 'gaming' } }),
  getGptModuleMap: async () => ({ 'arcanos-gaming': { module: 'ARCANOS:GAMING', route: 'gaming' } }),
  rebuildGptModuleMap: async () => ({ 'arcanos-gaming': { module: 'ARCANOS:GAMING', route: 'gaming' } }),
  validateGptRegistry: () => ({ requiredGptIds: [], missingGptIds: [], registeredGptIds: ['arcanos-gaming'], registeredGptCount: 1 })
}));

const { readFileSync } = await import('node:fs');
const { default: gamingModule } = await import('../src/modules/arcanos-gaming.js');
const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { default: errorHandler } = await import('../src/transport/http/middleware/errorHandler.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const logInfo = jest.fn();
const corpus = JSON.parse(readFileSync(new URL('./fixtures/gaming-guide-assistance.json', import.meta.url), 'utf8')) as {
  cases: Array<{ id: string; request: Record<string, unknown>; evidence: string; referenceAnswer: string; excludedFuture?: string }>
};
const cases = [...corpus.cases, {
  ...corpus.cases[3]!,
  id: 'all-optional-context-fields',
  request: {
    ...corpus.cases[3]!.request,
    platform: 'PC', edition: 'Navigator Edition', version: '2.1', difficulty: 'Standard',
    currentArea: 'Ash Foundry', lastCompletedObjective: 'Opened foundry gate', progressPoint: 'Anvil checkpoint',
    class: 'Scout', role: 'Salvager', constraints: ['No shield', 'Starter power unit']
  }
}];

function record(fixture: typeof corpus.cases[number], text = fixture.evidence, id = fixture.id) {
  const game = fixture.request.game as string;
  const sourceGameName = fixture.request.edition ? `${game} ${fixture.request.edition}` : game;
  return {
    recordId: id, recordType: 'guide', semanticKey: id, payloadHash: 'a'.repeat(64),
    title: 'Synthetic gameplay guide', patch: fixture.request.version ?? null, searchText: text,
    normalized: { text, chunk: { ordinal: 399, totalChunks: 400, startChar: 590000, endChar: 590000 + text.length } },
    recordCreatedAt: new Date('2026-09-01T00:00:00Z'), sourceId: 'synthetic-source',
    gameKey: sourceGameName.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), gameName: sourceGameName,
    canonicalUrl: 'https://example.com/guide', publicUrl: 'https://example.com/guide',
    canonicalUrlHash: 'b'.repeat(64), host: 'example.com', sourceType: 'supplied', trustScore: 0.8,
    revisionId: 'synthetic-active-revision', contentHash: 'c'.repeat(64),
    fetchedAt: new Date('2026-09-01T00:00:00Z'), publishedAt: null, revisionPatch: null,
    extractor: 'synthetic', extractorVersion: 'fixture-v1', normalizerSchemaVersion: 'gaming-document-chunks-v1',
    provenance: fixture.request.version ? { patchVerificationMethod: 'extractor', verifiedPatchVersion: fixture.request.version } : {},
    extractionMetrics: {}, relevance: 0.9
  };
}

function completion(text: string, incomplete = false) {
  return {
    id: 'synthetic-player-context', model: 'gpt-5.1', status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output_text: text, output: [],
    usage: { input_tokens: 700, output_tokens: incomplete ? 500 : 80, total_tokens: incomplete ? 1200 : 780 }
  };
}

async function publicQuery(payload: Record<string, unknown>) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use('/gpt', gptRouter);
  app.use(errorHandler);
  const response = await request(app).post('/gpt/arcanos-gaming').send({ action: 'query', payload });
  expect(response.status).toBe(200);
  return response.body.result as {
    ok: boolean; data: { response: string; sources: Array<{ url: string }>; fallbackReason?: string; grounding?: { groundingStatus: string; groundedInSuppliedEvidence: boolean; selectedChunkCount: number } }
  };
}

describe('public Gaming player context to selected evidence and normal Trinity response', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(logger, 'info').mockImplementation(logInfo);
    responsesCreate.mockReset();
    searchActiveGamingKnowledge.mockReset();
    findActiveGamingSourceIdentities.mockImplementation(async (input: { game: string; edition?: string }) => {
      const gameName = input.edition ? `${input.game} ${input.edition}` : input.game;
      return [{ sourceId: 'synthetic-source', gameKey: gameName.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), gameName }];
    });
    createGPT5Reasoning.mockResolvedValue({ content: JSON.stringify({ clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 }) });
  });

  it.each(cases)('runs validation, mapping, stored acquisition/selection, Trinity and projection for $id', async fixture => {
    searchActiveGamingKnowledge.mockResolvedValue([
      record(fixture),
      record(fixture, fixture.excludedFuture ?? 'An unrelated distant chapter reveals the ending and final identity.', 'future-unrelated')
    ]);
    responsesCreate.mockResolvedValueOnce(completion('Question and player constraints retained; verify source [1].'))
      .mockResolvedValueOnce(completion(fixture.referenceAnswer));
    runStructuredReasoning.mockResolvedValue({
      reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [], alternatives_considered: [], chosen_path_justification: '',
      response_mode: 'answer', achievable_subtasks: ['answer the requested gameplay question'], blocked_subtasks: [], user_visible_caveats: [], claim_tags: [],
      final_answer: fixture.referenceAnswer
    });
    const result = await publicQuery(fixture.request);
    expect(result.ok).toBe(true);
    expect(result.data.response).toBe(fixture.referenceAnswer);
    expect(result.data.sources).toEqual([expect.objectContaining({ url: 'https://example.com/guide' })]);
    expect(result.data.grounding).toMatchObject({ groundingStatus: 'grounded', selectedChunkCount: 1 });
    expect(result.data.fallbackReason).toBeUndefined();
    expect(searchActiveGamingKnowledge).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({ max_output_tokens: 500, reasoning: { effort: 'none' } });
    const reasoning = runStructuredReasoning.mock.calls[0]?.[2] as string;
    expect(reasoning).toContain(fixture.evidence);
    expect(reasoning).toContain('[Source 1]');
    expect(reasoning).toContain('Passage: 400');
    expect(logInfo).toHaveBeenCalledWith('gaming.stored_evidence.selected', expect.objectContaining({
      chunks: [expect.objectContaining({ sourceIndex: 1, sourceId: 'synthetic-source', revisionId: 'synthetic-active-revision', recordId: fixture.id })]
    }));
    expect(reasoning).not.toContain(fixture.excludedFuture ?? 'An unrelated distant chapter');
    for (const [field, value] of Object.entries(fixture.request)) {
      if (['mode', 'spoilerTolerance', 'answerDepth'].includes(field)) continue;
      for (const part of Array.isArray(value) ? value : [value]) {
        expect(reasoning).toContain(part as string);
        expect(JSON.stringify(responsesCreate.mock.calls[1]?.[0])).toContain(part as string);
      }
    }
    expect(createGPT5Reasoning.mock.calls[0]?.[1]).toContain(fixture.evidence);
    expect(forbiddenWrite).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
  });

  it('does not turn incomplete intake into grounded success or reuse it on a repeated public request', async () => {
    const fixture = corpus.cases[0]!;
    searchActiveGamingKnowledge.mockResolvedValue([record(fixture)]);
    responsesCreate.mockResolvedValue(completion('PRIVATE unfinished guide', true));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await publicQuery(fixture.request);
      expect(result.data.fallbackReason).toBe('PROVIDER_COMPLETION_INCOMPLETE');
      expect(result.data.response).not.toContain('PRIVATE unfinished guide');
      expect(result.data.grounding?.groundedInSuppliedEvidence).toBe(false);
    }
    expect(searchActiveGamingKnowledge).toHaveBeenCalledTimes(2);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
  });

  it.each(['Lumen Voyage', 'Cinder Cartographer', 'Vector Harbor'])('clarifies %s through the real public HTTP path before any model call', async game => {
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.use('/gpt', gptRouter);
    app.use(errorHandler);
    const result = await request(app).post('/gpt/arcanos-gaming').send({ action: 'query', payload: {
      mode: 'guide', game, prompt: 'What should I do next?', platform: 'PC', difficulty: 'Normal',
      spoilerTolerance: 'none', answerDepth: 'concise'
    } });
    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain(game);
    expect(serialized).toContain('Where are you now');
    expect(serialized).not.toMatch(/Backend-supported|Fallback status|upgrade.*gear|stock.*healing/iu);
    expect(findActiveGamingSourceIdentities).toHaveBeenCalledTimes(1);
    expect(searchActiveGamingKnowledge).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(modelClient.models.retrieve).not.toHaveBeenCalled();
    expect(runStructuredReasoning).not.toHaveBeenCalled();
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });

  it('keeps an unrepresented edition separate while recovering the known live request shape', async () => {
    findActiveGamingSourceIdentities.mockResolvedValue([]);
    const result = await publicQuery({ mode: 'guide', game: 'Synthetic Voyage 1.5 Remix', prompt: 'What should I do next?' });
    expect(result.data.response).toContain('current progress point');
    expect(result.data.response).not.toContain('guide available');
    expect(result.data.grounding?.groundedInSuppliedEvidence).toBe(false);
    expect(searchActiveGamingKnowledge).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('recovers an evidence-backed timeout without invented strategy or caching a success', async () => {
    const fixture = corpus.cases[0]!;
    searchActiveGamingKnowledge.mockResolvedValue([record(fixture)]);
    const timedOut = Object.assign(new Error('OpenAI chat completion timed out after 24000ms'), { name: 'AbortError', timeoutPhase: 'intake' });
    responsesCreate.mockRejectedValue(timedOut);
    const result = await publicQuery(fixture.request);
    expect(result.data.response).toContain('found the relevant guide material');
    expect(result.data.response).toContain('timed out');
    expect(result.data.response).not.toMatch(/OpenAI|Trinity|Backend-supported|Fallback status|upgrade|stock/iu);
    expect(result.data.fallbackReason).toBe('INTAKE_UPSTREAM_TIMEOUT');
    expect(result.data.grounding?.groundedInSuppliedEvidence).toBe(false);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
  });
});
