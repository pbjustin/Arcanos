import { afterAll, describe, expect, it, jest } from '@jest/globals';

const queryMock = jest.fn();
const isDatabaseConnectedMock = jest.fn(() => true);
const recordJobEventMock = jest.fn(async () => undefined);
const claimNextMock = jest.fn();
const runWorkerTrinityPromptMock = jest.fn();
const fakeOpenAIClient = {};
const stopAfterOneIteration = new Error('STOP_AFTER_ONE_WORKER_ITERATION');
const sleepMock = jest.fn(async () => {
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
const originalAskRetentionMs = process.env.QUEUE_ASK_TERMINAL_RETENTION_MS;

process.env.OPENAI_API_KEY = 'provider-free-worker-test-key';

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getStatus: jest.fn(),
  initializeDatabaseWithSchema: jest.fn()
}));

jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({
  postgresQueueSchedulerAdapter: {
    claimNext: claimNextMock
  }
}));

jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
  getOpenAIAdapter: jest.fn(() => ({
    getClient: () => fakeOpenAIClient
  }))
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIProviderRuntimeStatus: jest.fn(() => providerRuntime),
  probeOpenAIProviderHealth: jest.fn(async () => ({
    ok: true,
    runtime: providerRuntime
  })),
  syncOpenAIProviderRuntime: jest.fn(() => ({
    runtime: providerRuntime
  }))
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  WorkerAutonomyService: class {},
  classifyWorkerExecutionError: jest.fn(),
  getWorkerAutonomySettings: jest.fn()
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
  runDagNodeJob: jest.fn()
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
  routeGptRequest: jest.fn()
}));

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: jest.fn()
}));

jest.unstable_mockModule('@shared/sleep.js', () => ({
  sleep: sleepMock
}));

const { runWorkerConsumerSlot } = await import('../src/workers/jobRunner.js');

const introducedSignalListeners = {
  SIGINT: process
    .listeners('SIGINT')
    .filter(listener => !signalListenersBeforeImport.SIGINT.includes(listener)),
  SIGTERM: process
    .listeners('SIGTERM')
    .filter(listener => !signalListenersBeforeImport.SIGTERM.includes(listener))
};

afterAll(() => {
  for (const listener of introducedSignalListeners.SIGINT) {
    process.removeListener('SIGINT', listener);
  }
  for (const listener of introducedSignalListeners.SIGTERM) {
    process.removeListener('SIGTERM', listener);
  }

  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  if (originalAskRetentionMs === undefined) {
    delete process.env.QUEUE_ASK_TERMINAL_RETENTION_MS;
  } else {
    process.env.QUEUE_ASK_TERMINAL_RETENTION_MS = originalAskRetentionMs;
  }
});

describe('job runner successful Ask terminal retention', () => {
  it('executes Ask through Trinity and reaches the real claimed terminal writer with retention', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    process.env.QUEUE_ASK_TERMINAL_RETENTION_MS = '3600000';

    const claimedJob = {
      id: 'ask-job-provider-free-success',
      worker_id: 'queue',
      job_type: 'ask',
      status: 'running',
      claim_generation: '7',
      input: {
        prompt: 'Return a provider-free successful Ask response.',
        endpointName: 'ask'
      },
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2026-08-10T12:01:00.000Z'),
      correlation_id: 'request-provider-free-success',
      created_at: new Date('2026-08-10T11:59:59.000Z'),
      updated_at: new Date('2026-08-10T12:00:00.000Z')
    };
    let terminalSql = '';
    let terminalParams: unknown[] = [];

    claimNextMock.mockResolvedValueOnce({ job: claimedJob });
    runWorkerTrinityPromptMock.mockResolvedValueOnce({
      result: 'Provider-free Ask completed.',
      module: 'arcanos-final',
      meta: {
        id: 'response-provider-free-success',
        created: 1786363200
      },
      activeModel: 'mock-openai-model',
      fallbackFlag: false,
      dryRun: false
    });
    queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
      const normalizedSql = String(sql);
      if (normalizedSql.startsWith('SELECT * FROM job_data')) {
        return { rows: [claimedJob] };
      }
      if (normalizedSql.includes('UPDATE job_data')) {
        terminalSql = normalizedSql;
        terminalParams = params;
        return {
          rows: [{
            ...claimedJob,
            status: 'completed',
            output: JSON.parse(String(params[1])),
            last_heartbeat_at: null,
            lease_expires_at: null,
            retention_until: new Date(
              Date.now() + Number(params[12])
            ),
            completed_at: new Date('2026-08-10T12:00:00.000Z')
          }]
        };
      }

      throw new Error(`Unexpected repository query: ${normalizedSql}`);
    });

    const autonomyService = {
      markDispatcherStarted: jest.fn(async () => undefined),
      getHeartbeatIntervalMs: jest.fn(() => 30_000),
      getRecommendedWorkerHeartbeatDelayMs: jest.fn(() => 30_000),
      recordWorkerHeartbeat: jest.fn(async () => undefined),
      evaluateBudgetsBeforeClaim: jest.fn(async () => ({ allowed: true })),
      recordClaimAttempt: jest.fn(),
      getClaimOptions: jest.fn(() => ({
        workerId: 'worker-test-slot-1',
        leaseMs: 30_000
      })),
      recordClaimResult: jest.fn(),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => claimedJob),
      recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
      markJobLeaseLost: jest.fn(async () => undefined),
      markJobCompleted: jest.fn(async () => undefined),
      flushSnapshotPipeline: jest.fn(async () => undefined)
    };

    try {
      await expect(runWorkerConsumerSlot(
        {
          slotIndex: 0,
          slotNumber: 1,
          workerId: 'worker-test-slot-1',
          statsWorkerId: 'worker-test-stats',
          isInspectorSlot: true
        },
        {
          pollMs: 1,
          idleBackoffMs: 1,
          concurrency: 1,
          baseWorkerId: 'worker-test',
          statsWorkerId: 'worker-test-stats'
        },
        autonomyService as never
      )).rejects.toBe(stopAfterOneIteration);

      expect(runWorkerTrinityPromptMock).toHaveBeenCalledWith(
        fakeOpenAIClient,
        expect.objectContaining({
          prompt: 'Return a provider-free successful Ask response.',
          sourceEndpoint: 'ask'
        })
      );
      expect(terminalSql).toContain("WHEN 'ask' THEN CASE");
      expect(terminalSql).toContain(
        "NOW() + ($13::bigint * INTERVAL '1 millisecond')"
      );
      expect(terminalParams[0]).toBe('completed');
      expect(JSON.parse(String(terminalParams[1]))).toMatchObject({
        result: 'Provider-free Ask completed.',
        endpoint: 'ask'
      });
      expect(terminalParams[4]).toBeNull();
      expect(terminalParams[5]).toBeNull();
      expect(terminalParams.slice(9, 12)).toEqual([
        'ask-job-provider-free-success',
        'worker-test-slot-1',
        '7'
      ]);
      expect(terminalParams[12]).toBe(3_600_000);
      expect(autonomyService.markJobCompleted).toHaveBeenCalledWith(
        'ask-job-provider-free-success'
      );
      expect(autonomyService.flushSnapshotPipeline).toHaveBeenCalledWith(
        'worker-slot-shutdown'
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
