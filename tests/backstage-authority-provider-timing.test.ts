import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { OpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import type { BackstageNotionRagRetrievalDependencies } from '../src/services/backstageNotionRag.js';
import type { BackstageNotionPartitionCutoverDependencies } from '../src/services/backstageNotionPartitionCutover.js';
import type { BackstageNotionMonolithAuthorityStatusResolution } from '../src/services/backstageNotionAuthorityStatus.js';

const routeGptRequestMock = jest.fn();
const runTrinityWritingPipelineMock = jest.fn();
const recordJobEventMock = jest.fn(async () => undefined);
const queryMock = jest.fn(async () => { throw new Error('Unexpected database access in transport timing fixture.'); });
let adapter: OpenAIAdapter;
let authorityReady = true;
let returnErrorEnvelope = true;
let cutoverDependencies: BackstageNotionPartitionCutoverDependencies;

const signalListenersBeforeImport = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
};
const originalPayloadKey = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(), initializeDatabase: jest.fn(), isDatabaseConnected: () => false,
}));
jest.unstable_mockModule('@core/db/query.js', () => ({ query: queryMock }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createClaimedJobFence: jest.fn(), getJobById: async () => null,
  JobRepositoryUnavailableError: class extends Error {}, updateClaimedJobTerminal: jest.fn(),
}));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock, recordJobEventWithClient: jest.fn(),
}));
jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES: {},
  applyBackstageRosterMutation: jest.fn(), applyBackstageStorylineMutation: jest.fn(),
  isTransactionCommitAmbiguousError: () => false, query: queryMock,
  saveMemory: jest.fn(), transaction: jest.fn(), close: jest.fn(),
  getBackstageNotionPartitionCutoverEvidenceRepository: jest.fn(),
  getBackstageNotionPartitionRepository: jest.fn(), getBackstageNotionRagRepository: jest.fn(),
  getBackstageNotionSyncStatusRepository: jest.fn(), getStatus: jest.fn(),
  initializeDatabaseWithSchema: jest.fn(),
}));
jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({ postgresQueueSchedulerAdapter: {} }));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  WorkerAutonomyService: class {},
  classifyWorkerExecutionError: () => ({ retryable: false }), getWorkerAutonomySettings: jest.fn(),
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({
  executeQueuedGamingSourceIngestion: jest.fn(), GAMING_SOURCE_INGESTION_GPT_ID: 'arcanos-gaming',
  GAMING_SOURCE_INGESTION_REASON: 'gaming_source_ingestion',
  GAMING_SOURCE_INGESTION_REQUEST_PATH: '/gpt-access/gaming/sources/ingestions',
  GAMING_SOURCE_REFRESH_REQUEST_PATH: '/gpt-access/gaming/sources/refreshes',
  parseQueuedGamingSourceIngestionBody: jest.fn(),
}));
jest.unstable_mockModule('../src/workers/taskRunners.js', () => ({ runDagNodeJob: jest.fn() }));
jest.unstable_mockModule('../src/workers/trinityWorkerPipeline.js', () => ({ runWorkerTrinityPrompt: jest.fn() }));
jest.unstable_mockModule('@services/trinity/adapter.js', () => ({
  isTrinityDagGptAccessEnabled: () => false, routeDagNodeToGptAccess: jest.fn(),
}));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn(),
}));
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({ initializeModuleRegistry: jest.fn() }));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: async () => ({ 'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' } }),
}));
jest.unstable_mockModule('@routes/_core/gptDispatch.js', () => ({ routeGptRequest: routeGptRequestMock }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ adapter, client: adapter?.getClient() }),
}));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock,
}));

const actualCutover = await import('../src/services/backstageNotionPartitionCutover.js');
const actualAuthority = await import('../src/services/backstageNotionAuthority.js');
jest.unstable_mockModule('@services/backstageNotionAuthority.js', () => ({
  ...actualAuthority, isBackstageNotionAuthorityEnforced: async () => true,
}));
// Keep production admission and RAG code. Inject only its external observations.
jest.unstable_mockModule('@services/backstageNotionPartitionCutover.js', () => ({
  ...actualCutover,
  assertBackstageNotionProtectedBookingAdmission: (universeId: string, prompt: string) =>
    actualCutover.assertBackstageNotionProtectedBookingAdmission(universeId, prompt, cutoverDependencies),
  retrieveBackstageNotionAuthorityBookingRagContext: (universeId: string, prompt: string) =>
    actualCutover.retrieveBackstageNotionAuthorityBookingRagContext(universeId, prompt, cutoverDependencies),
}));

const { createOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js');
const { createAiExecutionContext, runWithAiExecutionContext } = await import('../src/services/openai/aiExecutionContext.js');
const { createEmbedding } = await import('../src/services/openai/embeddings.js');
const { retrieveBackstageNotionBookingRagContext, isBackstageNotionIndexUnavailableError } = await import('../src/services/backstageNotionRag.js');
const { generateBooking } = await import('../src/services/backstage-booker.js');
const { executeQueuedGptRequest } = await import('../src/workers/jobRunner.js');
const { buildProtectedBackstageQueuedGptJobInput } = await import('../src/shared/gpt/asyncGptJob.js');
const { unprotectBackstageQueuedGptJobOutput } = await import('../src/shared/backstage/backstageQueuedJobResultProtection.js');
const { resolveBackstageExecutionBudgetPolicy } = await import('../src/shared/backstage/backstageExecutionBudget.js');

const introducedSignalListeners = {
  SIGINT: process.listeners('SIGINT').filter(listener => !signalListenersBeforeImport.SIGINT.includes(listener)),
  SIGTERM: process.listeners('SIGTERM').filter(listener => !signalListenersBeforeImport.SIGTERM.includes(listener)),
};
const UNIVERSE_ID = 'synthetic-provider-timing';
const JOB_ID = '77777777-7777-4777-8777-777777777777';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_ID = '33333333-3333-4333-8333-333333333333';
const PROMPT = 'Plan the next wrestling show.';
const NOW = new Date('2026-10-20T12:00:00Z');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise; reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function authorityStatus(): BackstageNotionMonolithAuthorityStatusResolution {
  return { status: 'ready', data: {
    version: 1, surface: 'monolith_authority', authority: 'notion',
    status: authorityReady ? 'current_complete' : 'syncing',
    snapshotStatus: authorityReady ? 'current_complete' : 'last_known_good',
    freshnessSatisfied: true, syncInProgress: !authorityReady,
    activeSnapshotReadable: true, activeSnapshotChunkCount: 1,
    latestSyncOutcome: authorityReady ? 'unchanged' : 'running',
    latestSyncFailurePhase: null, latestSyncFailureReason: null,
  } };
}

function createRagFixture() {
  const content = 'Synthetic general continuity for an offline timing regression.';
  const contentHash = sha256(content);
  const candidate = {
    id: sha256(JSON.stringify({ format: 'backstage-notion-rag-chunk-v1', pageId: PAGE_ID, ordinal: 0, contentHash })),
    pageId: PAGE_ID, pageTitle: 'Synthetic continuity', pagePath: ['Synthetic continuity'],
    ordinal: 0, contentHash, content, codePoints: Array.from(content).length,
    embeddingModel: 'text-embedding-3-small', embedding: [1, 0], headingPath: [],
    metadata: { category: 'general', headingIndexVersion: 3, headingOccurrencePath: [],
      sourceHash: sha256('source'), sourceLastEditedAt: '2026-10-20T11:00:00Z' },
  };
  const rankSnapshotCandidates = jest.fn(async () => ({
    scopeChunkCount: 1, candidatePoolCount: 1, semanticCandidateCount: 1,
    lexicalCandidateCount: 0, mergedCandidateCount: 1, queryDurationMs: 1,
    queryTimeoutMs: 15_000, queryStrategy: 'native_sidecar_v1' as const, candidates: [candidate],
  }));
  const dependencies: BackstageNotionRagRetrievalDependencies = {
    resolveAuthorityRoot: () => ({ universeId: UNIVERSE_ID, rootPageId: ROOT_PAGE_ID, displayName: 'Synthetic continuity' }),
    now: () => NOW,
    repository: {
      loadActiveSnapshotHeader: async () => ({ authority: 'notion', verifiedAt: NOW, snapshot: {
        id: SNAPSHOT_ID, universeId: UNIVERSE_ID, rootPageId: ROOT_PAGE_ID,
        manifestHash: sha256('manifest'), embeddingModel: 'text-embedding-3-small', pageCount: 1, chunkCount: 1,
        sourceMaxEditedAt: new Date('2026-10-20T11:00:00Z'), syncHolderId: 'synthetic-sync',
        createdAt: new Date('2026-10-20T11:30:00Z'),
      } }),
      resolveSnapshotScope: async () => ({ status: 'not_found' }),
      loadSnapshotChunkPage: async () => ({ scopeChunkCount: 1, chunks: [candidate] }),
      rankSnapshotCandidates,
    },
    // The active snapshot is valid at retrieval start; authority changes only
    // after the native embedding transport has actually been entered.
    syncStatusRepository: { loadLatestSyncAttempt: async () => null },
  };
  const resolveMonolithAuthorityStatus = jest.fn(async () => authorityStatus());
  cutoverDependencies = {
    readEnvironment: () => undefined,
    resolveMonolithAuthorityStatus,
    embedQuery: text => createEmbedding(text),
    retrieveBookingMonolith: (universeId, query, overrides) => retrieveBackstageNotionBookingRagContext(
      universeId, query, { ...dependencies, ...overrides },
    ),
  };
  return { rankSnapshotCandidates, resolveMonolithAuthorityStatus };
}

function createTransport() {
  const entered = deferred<void>();
  const response = deferred<Response>();
  // A custom native transport supplies every response; no network is used.
  const fetch = jest.fn<typeof globalThis.fetch>(async () => {
    entered.resolve();
    return response.promise;
  });
  adapter = createOpenAIAdapter({ apiKey: 'test-synthetic-timing-key', maxRetries: 0, timeout: 600_000, fetch });
  return {
    entered: entered.promise, fetch,
    complete: () => response.resolve(new Response(JSON.stringify({
      object: 'list', data: [{ object: 'embedding', index: 0,
        embedding: Buffer.from(new Float32Array([1, 0]).buffer).toString('base64') }],
      model: 'text-embedding-3-small', usage: { prompt_tokens: 3, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })),
    fail: () => response.reject(new Error('synthetic-private-transport-failure')),
  };
}

function startExecution(cancellationSignal?: AbortSignal) {
  const rawInput = buildProtectedBackstageQueuedGptJobInput({
    action: 'generateBooking', universeId: UNIVERSE_ID, notionEnrichmentAuthorized: true,
    body: { action: 'generateBooking', payload: { universeId: UNIVERSE_ID, prompt: PROMPT } },
    prompt: PROMPT, requestId: 'synthetic-request', traceId: 'synthetic-trace',
  });
  const context = createAiExecutionContext({ sourceType: 'job', sourceName: 'gpt', jobId: JOB_ID });
  const execution = Promise.resolve(runWithAiExecutionContext(context, () => executeQueuedGptRequest({
    jobId: JOB_ID, rawInput, startedAt: NOW, cancellationSignal,
  })));
  return { context, execution, rawInput };
}

async function waitForTransport(entered: Promise<void>, execution: ReturnType<typeof startExecution>['execution']): Promise<void> {
  await Promise.race([entered, execution.then(outcome => {
    throw new Error(`Worker finished before embedding transport: ${JSON.stringify(outcome)}`);
  })]);
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  authorityReady = true;
  returnErrorEnvelope = true;
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = Buffer.alloc(32, 0x61).toString('base64');
  routeGptRequestMock.mockImplementation(async () => {
    // Exercise the real Booker orchestration between the worker and its
    // protected route envelope, including the final pre-Trinity admission.
    const _route = { gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', action: 'generateBooking' };
    try {
      const result = await generateBooking(PROMPT, UNIVERSE_ID);
      return { ok: true, result, _route };
    } catch (error) {
      if (returnErrorEnvelope && isBackstageNotionIndexUnavailableError(error)) {
        return { ok: false, error: { code: error.code, message: error.message }, _route };
      }
      throw error;
    }
  });
  runTrinityWritingPipelineMock.mockImplementation(() => { throw new Error('Generation must not start after authority loss.'); });
});

afterEach(() => jest.useRealTimers());
afterAll(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of introducedSignalListeners[signal]) process.removeListener(signal, listener);
  }
  if (originalPayloadKey === undefined) delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  else process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = originalPayloadKey;
});

describe('protected authority deferral with unresolved instrumented provider transport', () => {
  it.each([
    { settlement: 'success', errorEnvelope: true },
    { settlement: 'error', errorEnvelope: true },
    { settlement: 'success', errorEnvelope: false },
    { settlement: 'error', errorEnvelope: false },
  ] as const)(
    'never defers after pending embedding settlement=$settlement, errorEnvelope=$errorEnvelope', async ({ settlement, errorEnvelope }) => {
      returnErrorEnvelope = errorEnvelope;
      const rag = createRagFixture();
      const transport = createTransport();
      const running = startExecution();
      let settled = false;
      void running.execution.then(() => { settled = true; });
      await waitForTransport(transport.entered, running.execution);
      authorityReady = false;
      // The real transport is live while the real accounting still reports 0.
      expect(running.context.totals.calls).toBe(0);
      expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ai.request.started' }));
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(rag.rankSnapshotCandidates).not.toHaveBeenCalled();
      expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
      if (settlement === 'success') transport.complete();
      else transport.fail();
      const outcome = await running.execution;
      expect(running.context.totals.calls).toBe(1);
      expect(outcome).toMatchObject({ status: 'failed', retryable: false });
      expect(outcome.authorityDeferred).toBeUndefined();
      if (settlement === 'success') {
        expect(rag.rankSnapshotCandidates).toHaveBeenCalledTimes(1);
        expect(rag.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(3);
      } else {
        expect(rag.rankSnapshotCandidates).not.toHaveBeenCalled();
        expect(rag.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(2);
      }
      expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
      expect(transport.fetch).toHaveBeenCalledTimes(1);
      expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(outcome)).not.toContain('synthetic-private-transport-failure');
      const opened = unprotectBackstageQueuedGptJobOutput({ jobId: JOB_ID, rawInput: running.rawInput, output: outcome.output });
      expect(opened).toMatchObject({ ok: false, error: {
        code: errorEnvelope ? 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' : 'BACKSTAGE_ASYNC_EXECUTION_FAILED',
      } });
    },
  );

  it('defers a refresh observed immediately before embedding without starting native transport', async () => {
    const rag = createRagFixture();
    const current = authorityStatus();
    rag.resolveMonolithAuthorityStatus.mockImplementationOnce(async () => {
      authorityReady = false;
      return current;
    });
    const transport = createTransport();
    const running = startExecution();
    await expect(running.execution).resolves.toMatchObject({ status: 'failed', authorityDeferred: true, output: null });
    expect(running.context.totals.calls).toBe(0);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(recordJobEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ai.request.started' }));
    expect(rag.rankSnapshotCandidates).not.toHaveBeenCalled();
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
  });

  it('cancels while transport is unresolved without authority deferral or a second model execution', async () => {
    createRagFixture();
    const transport = createTransport();
    const cancellation = new AbortController();
    const running = startExecution(cancellation.signal);
    await waitForTransport(transport.entered, running.execution);
    authorityReady = false;
    expect(running.context.totals.calls).toBe(0);
    cancellation.abort(new Error('Synthetic cancellation.'));
    transport.complete();
    const outcome = await running.execution;
    expect(outcome).toMatchObject({ status: 'cancelled', retryable: false });
    expect(outcome.authorityDeferred).toBeUndefined();
    expect(running.context.totals.calls).toBe(1);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
  });

  it('terminalizes a worker deadline even if the native embedding transport ignores cancellation', async () => {
    createRagFixture();
    const transport = createTransport();
    const running = startExecution();
    await waitForTransport(transport.entered, running.execution);
    authorityReady = false;
    const policy = resolveBackstageExecutionBudgetPolicy({ profile: 'queued_generation', action: 'generateBooking' });
    await jest.advanceTimersByTimeAsync(policy.operationTimeoutMs + policy.abortDrainTimeoutMs + 1);
    const outcome = await running.execution;
    expect(outcome).toMatchObject({ status: 'failed', retryable: false });
    expect(outcome.authorityDeferred).toBeUndefined();
    expect(running.context.totals.calls).toBe(0);
    const opened = unprotectBackstageQueuedGptJobOutput({ jobId: JOB_ID, rawInput: running.rawInput, output: outcome.output });
    expect(opened).toMatchObject({ ok: false, error: { code: 'BACKSTAGE_ASYNC_TIMEOUT' } });
    // Complete detached work and prove it cannot produce a late booking.
    transport.complete();
    await jest.advanceTimersByTimeAsync(1);
    expect(running.context.totals.calls).toBe(1);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
  });
});
