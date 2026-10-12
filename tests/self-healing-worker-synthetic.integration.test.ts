import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const queryMock = jest.fn();
const isDatabaseConnectedMock = jest.fn(() => true);
const recordJobEventMock = jest.fn(async () => undefined);
const claimNextMock = jest.fn();
const runWorkerTrinityPromptMock = jest.fn();
const runDagNodeJobMock = jest.fn();
const classifyWorkerAiBudgetErrorMock = jest.fn((_error: unknown): unknown => null);
const routeGptRequestMock = jest.fn();
const getOpenAIAdapterMock = jest.fn(() => ({
  getClient: () => fakeOpenAIClient
}));
const probeOpenAIProviderHealthMock = jest.fn(async () => ({
  ok: true,
  runtime: providerRuntime
}));
const syncOpenAIProviderRuntimeMock = jest.fn(() => ({
  runtime: providerRuntime
}));
const getGptModuleMapMock = jest.fn(async () => ({
  'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
  'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
}));
const fakeOpenAIClient = {};
const stopAfterOneIteration = new Error('STOP_AFTER_ONE_WORKER_ITERATION');
const sleepMock = jest.fn(async (_delayMs: number) => {
  throw stopAfterOneIteration;
});
const providerRuntime = {
  configVersion: 'provider-config-v1',
  nextRetryAt: null,
  lastFailureAt: null,
  lastFailureCategory: null,
  consecutiveFailures: 0
};

const signalListenersBeforeImport = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM')
};
const originalOpenAIKey = process.env.OPENAI_API_KEY;

process.env.OPENAI_API_KEY = 'provider-free-worker-test-key';

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  initializeDatabase: jest.fn(),
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: getGptModuleMapMock,
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock,
  recordJobEventWithClient: jest.fn()
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getBackstageNotionPartitionCutoverEvidenceRepository: jest.fn(),
  getBackstageNotionPartitionRepository: jest.fn(),
  getBackstageNotionRagRepository: jest.fn(),
  getBackstageNotionSyncStatusRepository: jest.fn(),
  getStatus: jest.fn(),
  initializeDatabaseWithSchema: jest.fn()
}));

jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({
  postgresQueueSchedulerAdapter: {
    claimNext: claimNextMock
  }
}));

jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
  assertValidResponsesCreateParams: jest.fn(),
  classifyWorkerAiBudgetError: classifyWorkerAiBudgetErrorMock,
  createOpenAIAdapter: getOpenAIAdapterMock,
  normalizeWorkerAiBudgetError: jest.fn((error: unknown) => error),
  normalizeResponsesCreateParams: jest.fn((value: unknown) => value),
  getOpenAIAdapter: getOpenAIAdapterMock,
  isOpenAIAdapterInitialized: jest.fn(() => true),
  resetOpenAIAdapter: jest.fn()
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: jest.fn(() => providerRuntime),
  getOpenAIProviderRuntimeStatus: jest.fn(() => providerRuntime),
  probeOpenAIProviderHealth: probeOpenAIProviderHealthMock,
  syncOpenAIProviderRuntime: syncOpenAIProviderRuntimeMock
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null)
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({
  executeQueuedGamingSourceIngestion: jest.fn(),
  GAMING_SOURCE_INGESTION_GPT_ID: 'arcanos-gaming',
  GAMING_SOURCE_INGESTION_REASON: 'gaming_source_ingestion',
  GAMING_SOURCE_INGESTION_REQUEST_PATH: '/gpt-access/gaming/sources/ingestions',
  GAMING_SOURCE_REFRESH_REQUEST_PATH: '/gpt-access/gaming/sources/refreshes',
  parseQueuedGamingSourceIngestionBody: jest.fn()
}));

jest.unstable_mockModule('../src/workers/taskRunners.js', () => ({
  runDagNodeJob: runDagNodeJobMock
}));

jest.unstable_mockModule('../src/workers/trinityWorkerPipeline.js', () => ({
  runWorkerTrinityPrompt: runWorkerTrinityPromptMock
}));

jest.unstable_mockModule('@services/trinity/adapter.js', () => ({
  isTrinityDagGptAccessEnabled: jest.fn(() => false),
  routeDagNodeToGptAccess: jest.fn()
}));

jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn()
}));

jest.unstable_mockModule('@routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock
}));

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: jest.fn()
}));

jest.unstable_mockModule('@shared/sleep.js', () => ({
  sleep: sleepMock
}));
jest.unstable_mockModule('../src/queue/cleanup.js', () => ({
  runFailedJobCleanup: jest.fn(),
  runJobEventCleanup: jest.fn(),
  runNonGptTerminalCleanup: jest.fn()
}));

const { runWorkerConsumerSlot } = await import('../src/workers/jobRunner.js');
const { WorkerAutonomyService, getWorkerAutonomySettings } = await import(
  '../src/services/workerAutonomyService.js'
);
const { createClaimedJobFence, scheduleJobRetry } = await import(
  '../src/core/db/repositories/jobRepository.js'
);
const { BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE } = await import(
  '../src/shared/jobs/backstageNotionPartitionSyncJob.js'
);
type Job = import('../src/core/db/schema.js').JobData;

const slot = {
  slotIndex: 0, slotNumber: 1, workerId: 'synthetic-slot-1',
  statsWorkerId: 'synthetic-budget', isInspectorSlot: false
};
const runtime = {
  pollMs: 50, idleBackoffMs: 50, concurrency: 1,
  baseWorkerId: 'synthetic', statsWorkerId: 'synthetic-budget'
};
const now = new Date('2026-10-12T10:00:00.000Z');
let durableJob: Job;
let writes: Array<{ kind: string; generation: string; delayMs?: number }>;

function claimedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    worker_id: 'queue', job_type: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
    status: 'running', claim_generation: '1', input: { synthetic: true },
    output: null, error_message: null, retry_count: 0, max_retries: 2,
    last_worker_id: slot.workerId, lease_expires_at: new Date(now.getTime() + 30_000),
    correlation_id: 'synthetic-worker-recovery', cancel_requested_at: null,
    cancel_reason: null, created_at: now, updated_at: now,
    ...overrides
  } as Job;
}

// The real repository constructs and executes SQL. This explicit deterministic
// CAS substitute controls external storage only; it cannot prove PostgreSQL
// locking, isolation levels or crash atomicity. Guarded PG18 CI owns that proof.
function installRepositorySubstitute(): void {
  queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const source = String(sql);
    if (source.startsWith('SELECT * FROM job_data')) return { rows: [{ ...durableJob }] };
    if (source.includes('UPDATE job_data')) {
      const retry = source.includes('retry_count = retry_count + 1');
      expect(source).toContain("AND status = 'running'");
      expect(source).toContain('AND claim_generation =');
      expect(source).toContain('AND lease_expires_at >= NOW()');
      const generation = String(params[retry ? 5 : 11]);
      const workerId = String(params[retry ? 4 : 10]);
      const jobId = String(params[retry ? 3 : 9]);
      if (durableJob.status !== 'running' || durableJob.claim_generation !== generation ||
          durableJob.last_worker_id !== workerId || durableJob.id !== jobId ||
          !durableJob.lease_expires_at || durableJob.lease_expires_at.getTime() < Date.now()) {
        return { rows: [] };
      }
      if (retry) {
        expect(source).toContain('AND cancel_requested_at IS NULL');
        if (durableJob.cancel_requested_at) return { rows: [] };
        durableJob = { ...durableJob, status: 'pending',
          retry_count: durableJob.retry_count + 1, lease_expires_at: null,
          autonomy_state: JSON.parse(String(params[2])) };
        writes.push({ kind: 'retry', generation, delayMs: Number(params[1]) });
      } else {
        durableJob = { ...durableJob, status: params[0] as Job['status'],
          output: params[1] ? JSON.parse(String(params[1])) : null,
          error_message: String(params[2] ?? ''), lease_expires_at: null,
          autonomy_state: JSON.parse(String(params[3] ?? '{}')) };
        writes.push({ kind: String(params[0]), generation });
      }
      return { rows: [{ ...durableJob }] };
    }
    if (source.includes('FROM job_data')) return { rows: [{ pending: 0, running: 0,
      completed: 0, failed: 0, total: 0, delayed: 0, stalled_running: 0 }] };
    throw new Error('Synthetic fixture rejected an unexpected SQL operation.');
  });
}

function actualAutonomy() {
  const settings = {
    ...getWorkerAutonomySettings(), workerId: slot.workerId, statsWorkerId: slot.statsWorkerId,
    defaultMaxRetries: 2, retryBackoffBaseMs: 100, retryBackoffMaxMs: 200,
    failureWebhookUrl: null, heartbeatIntervalMs: 30_000, leaseMs: 30_000
  };
  const service = new WorkerAutonomyService(settings, null);
  // Snapshot I/O and resource measurements are external boundaries. Failure
  // classification, retries, terminal decisions and SQL fences stay real.
  const internal = service as unknown as {
    persistSnapshot: () => Promise<void>;
    persistLeaseIndependentSnapshot: () => void;
    readCurrentHourlyStats: () => Promise<unknown>;
  };
  jest.spyOn(internal, 'persistSnapshot').mockResolvedValue(undefined);
  jest.spyOn(internal, 'persistLeaseIndependentSnapshot').mockImplementation(() => undefined);
  jest.spyOn(internal, 'readCurrentHourlyStats').mockResolvedValue({ stats: {} });
  jest.spyOn(service, 'evaluateBudgetsBeforeClaim').mockResolvedValue({
    allowed: true, sleepMs: 0, reason: null, stats: {} as never, rssMb: 1,
    claimAcceptance: 'accepting', retryAt: null
  });
  jest.spyOn(service, 'recordWorkerHeartbeat').mockResolvedValue(undefined);
  jest.spyOn(service, 'recordHeartbeat').mockImplementation(async () => ({ ...durableJob }));
  return service;
}

function reclaim(): void {
  durableJob = { ...durableJob, status: 'running',
    claim_generation: String(Number(durableJob.claim_generation) + 1),
    lease_expires_at: new Date(Date.now() + 30_000) };
}

async function runOneAttempt(
  service: ReturnType<typeof actualAutonomy>,
  executor: (...args: unknown[]) => Promise<unknown>
): Promise<void> {
  claimNextMock.mockResolvedValueOnce({ job: { ...durableJob } }).mockResolvedValue({ job: null });
  await expect(runWorkerConsumerSlot(slot, runtime, service, undefined,
    executor as never, undefined, jest.fn())).rejects.toBe(stopAfterOneIteration);
}

afterAll(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListenersBeforeImport[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  jest.clearAllMocks();
  claimNextMock.mockReset();
  queryMock.mockReset();
  sleepMock.mockImplementation(async () => { throw stopAfterOneIteration; });
  durableJob = claimedJob();
  writes = [];
  installRepositorySubstitute();
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Synthetic worker fixture forbids network.'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('real worker loop, failure policy and repository synthetic integration', () => {
  it('S06 retries one transient execution and completes once under the new lease generation', async () => {
    const service = actualAutonomy();
    const executor = jest.fn(async () => ({ status: 'failed', output: null,
      errorMessage: 'synthetic dependency timeout', retryable: true }));
    await runOneAttempt(service, executor);
    expect(writes).toEqual([{ kind: 'retry', generation: '1', delayMs: 100 }]);
    expect(durableJob).toMatchObject({ status: 'pending', retry_count: 1 });
    jest.setSystemTime(new Date(now.getTime() + 100));
    reclaim();
    executor.mockResolvedValue({ status: 'completed', output: { synthetic: 'recovered' },
      errorMessage: '', retryable: false });
    await runOneAttempt(service, executor);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([
      { kind: 'retry', generation: '1', delayMs: 100 }, { kind: 'completed', generation: '2' }
    ]);
    expect(durableJob).toMatchObject({ status: 'completed', retry_count: 1 });
    // Duplicate delivery of a former running claim cannot schedule another retry.
    await expect(scheduleJobRetry(durableJob.id, {
      fence: createClaimedJobFence(slot.workerId, '1'), delayMs: 100, errorMessage: 'duplicate'
    })).resolves.toBeNull();
    expect(writes).toHaveLength(2);
    expect(getOpenAIAdapterMock).not.toHaveBeenCalled();
  });

  it('S06 bounds sustained failures at two retries and one terminal dead-letter decision', async () => {
    const service = actualAutonomy();
    const executor = jest.fn(async () => ({ status: 'failed', output: null,
      errorMessage: 'synthetic persistent execution failure', retryable: true }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runOneAttempt(service, executor);
      if (attempt < 2) {
        jest.setSystemTime(new Date(Date.now() + (attempt ? 200 : 100)));
        reclaim();
      }
    }
    expect(executor).toHaveBeenCalledTimes(3);
    expect(writes).toEqual([
      { kind: 'retry', generation: '1', delayMs: 100 },
      { kind: 'retry', generation: '2', delayMs: 200 },
      { kind: 'failed', generation: '3' }
    ]);
    expect(durableJob).toMatchObject({ status: 'failed', retry_count: 2,
      autonomy_state: { lastFailure: { retryExhausted: true, deadLetter: true } } });
    expect(getOpenAIAdapterMock).not.toHaveBeenCalled();
  });

  it('S14 rejects an old completion after restart has reclaimed the durable job', async () => {
    const service = actualAutonomy();
    const markLeaseLost = jest.spyOn(service, 'markJobLeaseLost');
    const executor = jest.fn(async () => {
      reclaim(); // Another process owns generation 2 before generation 1 finishes.
      return { status: 'completed', output: { stale: true }, retryable: false };
    });
    await runOneAttempt(service, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(markLeaseLost).toHaveBeenCalledWith(durableJob.id,
      'Queue job lease lost before terminal persistence.');
    expect(durableJob).toMatchObject({ status: 'running', claim_generation: '2' });
    const restartedService = actualAutonomy();
    const currentExecutor = jest.fn(async () => ({ status: 'completed',
      output: { stale: false }, retryable: false }));
    await runOneAttempt(restartedService, currentExecutor);
    expect(writes).toEqual([{ kind: 'completed', generation: '2' }]);
    expect(durableJob.output).toEqual({ stale: false });
  });

  it('S06 rejects a duplicate claim before consumer execution when its first heartbeat loses ownership', async () => {
    const service = actualAutonomy();
    jest.spyOn(service, 'recordHeartbeat').mockResolvedValueOnce(null);
    const markLeaseLost = jest.spyOn(service, 'markJobLeaseLost');
    const executor = jest.fn(async () => ({ status: 'completed', output: { duplicate: true } }));
    await runOneAttempt(service, executor);
    expect(executor).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(markLeaseLost).toHaveBeenCalledWith(durableJob.id,
      'Initial heartbeat fence was lost before provider initialization.');
  });

  it('fails closed before job execution when PostgreSQL claim admission is unavailable', async () => {
    const service = actualAutonomy();
    const states = jest.fn();
    const executor = jest.fn(async () => ({ status: 'completed', output: null }));
    const unavailable = Object.assign(new Error('synthetic database unavailable'), { code: 'ECONNREFUSED' });
    claimNextMock.mockRejectedValue(unavailable);
    await expect(runWorkerConsumerSlot(slot, runtime, service, undefined,
      executor as never, undefined, states)).rejects.toBe(stopAfterOneIteration);
    expect(executor).not.toHaveBeenCalled();
    expect(claimNextMock).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(states).toHaveBeenCalledWith('dependency_failure', 'worker_budget_or_queue_database_unavailable');
    expect(sleepMock).toHaveBeenCalledWith(5_000, { signal: expect.any(AbortSignal) });
  });
});
