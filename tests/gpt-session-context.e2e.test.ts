/**
 * Scoped HTTP application-path proof: real request middleware, GPT router/auth,
 * dispatcher, registry, CORE action, Trinity direct/default stages, Responses
 * mapper, conversation persistence, session repository and process cache.
 * Discovery is restricted to the real CORE module. Provider transport and
 * durable KV I/O are synthetic; unrelated semantic-memory/RAG mirrors,
 * audit-file writes, feedback/self-improvement and queue operations are isolated.
 * This is not live-provider, PostgreSQL, full-startup or production evidence.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  createSessionContextScenario,
  createSyntheticDurableMemory,
  respondFromObservedInput,
  type SyntheticResponsesRequest,
} from './fixtures/session-context-e2e.js';

const durableMemory = createSyntheticDurableMemory();
const responsesCreate = jest.fn(async (input: SyntheticResponsesRequest) => respondFromObservedInput(input));
const forbiddenIO = jest.fn(() => { throw new Error('Unexpected external/queue I/O in session fixture'); });
const recordConversationSnippet = jest.fn(async () => undefined);
const modelClient = {
  models: { retrieve: jest.fn(async (id: string) => ({ id })) },
  responses: { create: responsesCreate },
};
const environmentKeys = [
  'ARCANOS_MEMORY_ACCESS_TOKEN', 'GPT_ASYNC_HEAVY_PROMPT_CHARS',
  'PRIORITY_QUEUE_ENABLED', 'GPT_MODULE_MAP', 'GPTID_CORE', 'GPT_FAST_PATH_ENABLED',
  'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG', 'PUBLIC_PROVIDER_RATE_LIMIT_MAX',
  'PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX', 'OPENAI_STORE',
] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const accessToken = `synthetic-memory-${'q'.repeat(48)}`;
process.env.ARCANOS_MEMORY_ACCESS_TOKEN = accessToken;
process.env.GPT_ASYNC_HEAVY_PROMPT_CHARS = '1';
process.env.PRIORITY_QUEUE_ENABLED = 'false';
process.env.GPT_FAST_PATH_ENABLED = 'false';
process.env.PUBLIC_PROVIDER_RATE_LIMIT_MAX = '1000';
process.env.PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX = '999';
process.env.OPENAI_STORE = 'false';
delete process.env.GPT_MODULE_MAP;
delete process.env.GPTID_CORE;
delete process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;

const { AUDITED_TRANSIENT_READ_QUERIES } = await import('../src/core/db/transientReadRegistry.js');
jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  loadMemory: durableMemory.load,
  saveMemory: durableMemory.save,
  ...Object.fromEntries([
    'applyBackstageRosterMutation', 'applyBackstageStorylineMutation', 'close',
    'createJob', 'deleteMemory', 'getLatestJob', 'getMemoryRecordByKey',
    'getMemoryRecordByLegacyRowId', 'getMemoryRecordByRecordId', 'getPool',
    'initializeDatabase', 'initializeDatabaseWithSchema', 'loadMemoryRecordById',
    'logExecution', 'logExecutionBatch', 'query', 'saveRagDoc', 'transaction', 'updateJob',
  ].map(name => [name, forbiddenIO])),
  getStatus: () => ({ connected: false, hasPool: false, error: null }),
  isDatabaseConnected: () => false,
  isDatabaseSchemaReady: () => false,
  isTransactionCommitAmbiguousError: () => false,
  loadAllRagDocs: async () => [],
  loadRagDocsByIds: async () => [],
}));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'synthetic',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true,
  setDefaultModel: jest.fn(),
  getDefaultModel: () => 'gpt-5.1',
  getComplexModel: () => 'gpt-5.1',
  getFallbackModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5.1',
  getTrinityReasoningModel: () => 'gpt-5.6-terra',
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: modelClient }),
  requireOpenAIClientOrAdapter: () => ({ client: modelClient }),
}));
jest.unstable_mockModule('@services/webRag.js', () => ({
  recordConversationSnippet,
  queryRag: forbiddenIO,
  queryRagWithDiagnostics: forbiddenIO,
  queryRagDocuments: forbiddenIO,
  recordPersistentMemorySnippet: forbiddenIO,
  ingestContent: forbiddenIO,
  ingestUrl: forbiddenIO,
  answerQuestion: forbiddenIO,
}));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern: jest.fn(),
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn(),
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: async () => ({ enabled: false, attempted: false, reason: 'synthetic' }),
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({ planAutonomousWorkerJob: forbiddenIO }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  ...Object.fromEntries([
    'createJob', 'createClaimedJobFence', 'claimNextPendingJob', 'claimNextPendingJobWithAdmission',
    'deferJobForProviderRecovery', 'failPendingJobIfUnclaimed', 'normalizeJobClaimGeneration',
    'recordJobHeartbeat', 'scheduleJobRetry', 'recoverStaleJobs', 'updateClaimedJobTerminal',
    'updateJob', 'getLatestJob', 'getJobQueueSummary', 'getJobExecutionStatsSince',
    'findOrCreateGptJob', 'getJobById', 'requestJobCancellation',
  ].map(name => [name, forbiddenIO])),
  IdempotencyKeyConflictError: class extends Error {},
  JobRepositoryUnavailableError: class extends Error {},
}));
const auditSafe = await import('../src/services/auditSafe.js');
jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...auditSafe, logAITaskLineage: jest.fn() }));
const moduleLoader = await import('../src/services/moduleLoader.js');
const { MODULE_CATALOG } = await import('../src/services/moduleCatalog.js');
const coreLoader = moduleLoader.createModuleDefinitionLoader(
  MODULE_CATALOG.filter(entry => entry.name === 'ARCANOS:CORE'),
);
jest.unstable_mockModule('@services/moduleLoader.js', () => ({ ...moduleLoader, loadModuleDefinitions: () => coreLoader.load() }));

const { configureArcanosCoreOperatorDispatch } = await import('../src/services/arcanosCoreOperatorDispatchPort.js');
configureArcanosCoreOperatorDispatch(async () => null);
const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { default: errorHandler } = await import('../src/transport/http/middleware/errorHandler.js');
const { default: memoryStore } = await import('../src/core/memory/store.js');

const app = express();
app.use(requestContext);
app.use(express.json());
app.use('/gpt', gptRouter);
app.use(errorHandler);

function query(prompt: string, sessionId?: string, token: string | null = accessToken) {
  const pending = request(app).post('/gpt/arcanos-core');
  if (token !== null) pending.set('x-arcanos-memory-token', token);
  return pending.send({ action: 'query', prompt, sessionId, answerMode: 'direct', async: false });
}

function channelKey(sessionId: string) { return `session:${sessionId}:conversations_core`; }

function lastProviderInput() {
  const input = responsesCreate.mock.calls.at(-1)?.[0];
  expect(input).toBeDefined();
  return input!;
}

describe('GPT session context across the real HTTP to provider path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    durableMemory.reset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenIO);
  });

  afterEach(() => {
    try { expect(forbiddenIO).not.toHaveBeenCalled(); }
    finally { jest.restoreAllMocks(); }
  });

  afterAll(() => {
    configureArcanosCoreOperatorDispatch(null);
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('recalls a unique preference written by the first HTTP turn in the second provider-backed answer', async () => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    const firstStored = durableMemory.peek(channelKey(scenario.sessionId)) as Array<{ role: string; content: string }>;
    expect(firstStored).toHaveLength(2);
    expect(firstStored[0]).toMatchObject({ role: 'user', content: scenario.firstPrompt });
    memoryStore.saveSession({ sessionId: scenario.sessionId, conversations_core: [] });
    expect(memoryStore.getSession(scenario.sessionId)?.conversations_core).toHaveLength(0);
    expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(2);

    expect(scenario.secondPrompt).not.toContain(scenario.marker);
    const second = await query(scenario.secondPrompt, scenario.sessionId);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    const providerRequest = lastProviderInput();
    expect(providerRequest.instructions ?? '').not.toContain(scenario.marker);
    expect(Array.isArray(providerRequest.input)).toBe(true);
    const providerMessages = providerRequest.input as Array<{ role: string; content: unknown }>;
    const historyMessages = providerMessages.filter(message => JSON.stringify(message.content).includes(scenario.marker));
    expect(historyMessages).toHaveLength(1);
    expect(historyMessages[0].role).toBe('user');
    expect(JSON.stringify(providerMessages.at(-1))).toContain(scenario.secondPrompt);
    expect(durableMemory.reads).toContain(channelKey(scenario.sessionId));
    const stored = durableMemory.peek(channelKey(scenario.sessionId)) as Array<{ role: string; content: string }>;
    expect(stored).toHaveLength(4);
    expect(stored.filter(turn => turn.role === 'user').map(turn => turn.content)).toEqual([scenario.firstPrompt, scenario.secondPrompt]);
    expect(stored.every(turn => !turn.content.includes('<__arcanosSessionContext>'))).toBe(true);
    expect(recordConversationSnippet).toHaveBeenCalledTimes(4);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-gpt-route-decision-reason']).toBe('session_context_hydration');
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.headers['x-gpt-route-decision-reason']).toBe('session_context_hydration');
  });

  it('keeps another authenticated session isolated from a persisted preference', async () => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(2);
    responsesCreate.mockClear();
    const second = await query(scenario.secondPrompt, `synthetic-other-${randomUUID()}`);
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('No earlier palette code is available in this conversation.');
    expect(JSON.stringify(lastProviderInput())).not.toContain(scenario.marker);
  });

  it('keeps sessionless requests free of prior context and conversation writes', async () => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(2);
    const priorWrites = durableMemory.writes.length;
    const priorReads = durableMemory.reads.length;
    const second = await query(scenario.secondPrompt);
    expect(second.body).toMatchObject({ ok: true, result: 'No earlier palette code is available in this conversation.' });
    expect(JSON.stringify(lastProviderInput())).not.toContain(scenario.marker);
    expect(durableMemory.writes).toHaveLength(priorWrites);
    expect(durableMemory.reads).toHaveLength(priorReads);
  });

  it.each([null, `invalid-memory-${'z'.repeat(48)}`])('does not hydrate prior turns with missing/invalid memory token %p', async (token) => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(2);
    responsesCreate.mockClear();
    const second = await query(scenario.secondPrompt, scenario.sessionId, token);
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('No earlier palette code is available in this conversation.');
    expect(JSON.stringify(lastProviderInput())).not.toContain(scenario.marker);
    expect(second.headers['x-gpt-route-decision-reason']).not.toBe('session_context_hydration');
  });

  it('uses the real repository process cache when durable reads become unavailable', async () => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    expect(memoryStore.getSession(scenario.sessionId)?.conversations_core).toHaveLength(2);
    durableMemory.setUnavailable(true);
    const second = await query(scenario.secondPrompt, scenario.sessionId);
    expect(second.status).toBe(200);
    expect(second.body.result).toContain(scenario.marker);
    expect(memoryStore.getSession(scenario.sessionId)?.conversations_core).toHaveLength(4);
  });

  it('answers the current request when durable storage fails without any cached history', async () => {
    durableMemory.setUnavailable(true);
    const scenario = createSessionContextScenario();
    const response = await query(scenario.secondPrompt, scenario.sessionId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, result: 'No earlier palette code is available in this conversation.' });
    expect(JSON.stringify(lastProviderInput())).not.toContain(scenario.marker);
    expect(memoryStore.getSession(scenario.sessionId)?.conversations_core).toHaveLength(2);
  });

  it('carries the earlier preference through default Trinity intake, structured reasoning and final output', async () => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(2);
    responsesCreate.mockClear();
    const second = await request(app).post('/gpt/arcanos-core')
      .set('x-arcanos-memory-token', accessToken)
      .send({ action: 'query', prompt: scenario.secondPrompt, sessionId: scenario.sessionId, async: false });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    const providerRequests = responsesCreate.mock.calls.map(call => call[0]);
    const reasoning = providerRequests.filter(input => input.text?.format?.name?.startsWith('trinity_structured_reasoning'));
    expect(reasoning).toHaveLength(1);
    expect(JSON.stringify(reasoning[0].input)).toContain(scenario.marker);
    expect(providerRequests.filter(input => !input.text?.format)).toHaveLength(3);
    expect(JSON.stringify(providerRequests[0].input)).toContain(scenario.marker);
    expect(JSON.stringify(providerRequests.at(-1)?.input)).toContain(scenario.marker);
    expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(4);
  });

  it.each(['query', 'query_and_wait'])('bypasses fast and async queue hints for authenticated %s continuity', async action => {
    const scenario = createSessionContextScenario();
    const first = await query(scenario.firstPrompt, scenario.sessionId);
    expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
    responsesCreate.mockClear();
    process.env.GPT_FAST_PATH_ENABLED = 'true';
    try {
      const second = await request(app).post('/gpt/arcanos-core')
        .set('x-arcanos-memory-token', accessToken)
        .set('Idempotency-Key', `synthetic-context-${randomUUID()}`)
        .set('Prefer', 'respond-async')
        .send({ action, prompt: scenario.secondPrompt, sessionId: scenario.sessionId, mode: 'fast', executionMode: 'async', answerMode: 'direct' });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
      expect(second.headers['x-gpt-route-decision-reason']).toBe('session_context_hydration');
      expect(second.headers['x-gpt-queue-bypassed']).toBe('true');
      expect(second.headers['cache-control']).toBe('no-store');
      expect(responsesCreate).toHaveBeenCalledTimes(1);
      expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(4);
    } finally {
      process.env.GPT_FAST_PATH_ENABLED = 'false';
    }
  });

  it('isolates two session contexts while both HTTP provider calls are in flight', async () => {
    const scenarios = [createSessionContextScenario(), createSessionContextScenario()];
    for (const scenario of scenarios) {
      const first = await query(scenario.firstPrompt, scenario.sessionId);
      expect(first.body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
      expect(durableMemory.peek(channelKey(scenario.sessionId))).toHaveLength(2);
    }
    responsesCreate.mockClear();
    let releaseProviders!: () => void;
    const bothProvidersEntered = new Promise<void>(resolve => { releaseProviders = resolve; });
    let entered = 0;
    responsesCreate.mockImplementation(async input => {
      entered += 1;
      if (entered === 2) releaseProviders();
      await bothProvidersEntered;
      return respondFromObservedInput(input);
    });
    const pendingRequests = scenarios.map(scenario =>
      query(scenario.secondPrompt, scenario.sessionId).timeout({ deadline: 5000 }).then(result => result),
    );
    try {
      const results = await Promise.all(pendingRequests);
      expect(entered).toBe(2);
      for (const [index, scenario] of scenarios.entries()) {
        const otherMarker = scenarios[1 - index].marker;
        expect(results[index].body).toMatchObject({ ok: true, result: expect.stringContaining(scenario.marker) });
        expect(results[index].body.result).not.toContain(otherMarker);
        const matchingInputs = responsesCreate.mock.calls.map(call => JSON.stringify(call[0].input))
          .filter(input => input.includes(scenario.marker));
        expect(matchingInputs).toHaveLength(1);
        expect(matchingInputs[0]).not.toContain(otherMarker);
        const channel = durableMemory.peek(channelKey(scenario.sessionId));
        expect(channel).toHaveLength(4);
        expect(JSON.stringify(channel)).not.toContain(otherMarker);
      }
    } finally {
      releaseProviders();
      await Promise.allSettled(pendingRequests);
      responsesCreate.mockImplementation(async input => respondFromObservedInput(input));
    }
  });
});
