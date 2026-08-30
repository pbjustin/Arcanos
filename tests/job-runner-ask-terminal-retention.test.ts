import { afterAll, describe, expect, it, jest } from '@jest/globals';

const queryMock = jest.fn();
const isDatabaseConnectedMock = jest.fn(() => true);
const recordJobEventMock = jest.fn(async () => undefined);
const claimNextMock = jest.fn();
const runWorkerTrinityPromptMock = jest.fn();
const routeGptRequestMock = jest.fn();
const classifyWorkerExecutionErrorMock = jest.fn((error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
  retryable: true,
}));
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
const originalPartitionSyncRetentionMs =
  process.env.QUEUE_BACKSTAGE_NOTION_PARTITION_SYNC_TERMINAL_RETENTION_MS;
const originalBackstagePayloadKey =
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
const originalBackstageWorkerJobTimeout =
  process.env.BOOKER_WORKER_JOB_TIMEOUT_MS;

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
  normalizeResponsesCreateParams: jest.fn((value: unknown) => value),
  getOpenAIAdapter: getOpenAIAdapterMock
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

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  WorkerAutonomyService: class {},
  classifyWorkerExecutionError: classifyWorkerExecutionErrorMock,
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
  routeGptRequest: routeGptRequestMock
}));

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: jest.fn()
}));

jest.unstable_mockModule('@shared/sleep.js', () => ({
  sleep: sleepMock
}));

const { runWorkerConsumerSlot } = await import('../src/workers/jobRunner.js');
const { buildProtectedBackstageQueuedGptJobInput } = await import(
  '../src/shared/gpt/asyncGptJob.js'
);
const { unprotectBackstageQueuedGptJobOutput } = await import(
  '../src/shared/backstage/backstageQueuedJobResultProtection.js'
);
const { runBackstageBookerCompactOutputAttempts } = await import(
  '../src/shared/backstage/backstageCompactOutputContract.js'
);
const { createClaimedJobFence, updateClaimedJobTerminal } = await import(
  '../src/core/db/repositories/jobRepository.js'
);
const {
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
  BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
  BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
} = await import('../src/shared/jobs/backstageNotionPartitionSyncJob.js');

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
  if (originalPartitionSyncRetentionMs === undefined) {
    delete process.env
      .QUEUE_BACKSTAGE_NOTION_PARTITION_SYNC_TERMINAL_RETENTION_MS;
  } else {
    process.env.QUEUE_BACKSTAGE_NOTION_PARTITION_SYNC_TERMINAL_RETENTION_MS =
      originalPartitionSyncRetentionMs;
  }
  if (originalBackstagePayloadKey === undefined) {
    delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  } else {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      originalBackstagePayloadKey;
  }
  if (originalBackstageWorkerJobTimeout === undefined) {
    delete process.env.BOOKER_WORKER_JOB_TIMEOUT_MS;
  } else {
    process.env.BOOKER_WORKER_JOB_TIMEOUT_MS =
      originalBackstageWorkerJobTimeout;
  }
});

describe('job runner terminal persistence', () => {
  it('executes partition synchronization through its dedicated provider-free lane and fenced terminal writer', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    process.env.QUEUE_BACKSTAGE_NOTION_PARTITION_SYNC_TERMINAL_RETENTION_MS =
      '7200000';
    claimNextMock.mockReset();
    queryMock.mockReset();
    recordJobEventMock.mockClear();
    routeGptRequestMock.mockReset();
    runWorkerTrinityPromptMock.mockReset();
    getOpenAIAdapterMock.mockClear();
    probeOpenAIProviderHealthMock.mockClear();
    syncOpenAIProviderRuntimeMock.mockClear();

    const claimedJob = {
      id: '44444444-4444-4444-8444-444444444444',
      worker_id: 'queue',
      job_type: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
      status: 'running',
      claim_generation: '21',
      input: {
        protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
        version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
        universeId: 'my-universe-2k26',
        shardKey: 'raw/year-1',
        configurationGeneration: 'generation-1',
        configurationDigest: 'a'.repeat(64),
      },
      retry_count: 0,
      max_retries: 1,
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2026-08-24T12:01:00.000Z'),
      correlation_id: 'trace-partition-sync-completed',
      cancel_requested_at: null,
      cancel_reason: null,
      created_at: new Date('2026-08-24T11:59:59.000Z'),
      updated_at: new Date('2026-08-24T12:00:00.000Z'),
    };
    const boundedResult = {
      protocol: BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
      version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
      outcome: 'synchronized' as const,
      safeReasonCode: null,
      universeId: 'my-universe-2k26',
      shardKey: 'raw/year-1',
      fullSourceScan: true,
      manifestStatus: 'published' as const,
      manifestId: '55555555-5555-4555-8555-555555555555',
      freshSnapshotId: '66666666-6666-4666-8666-666666666666',
      pageCount: 4,
      chunkCount: 12,
      pageVersionReuseCount: 3,
      embeddedChunkCount: 2,
      pageChanges: {
        added: 1,
        changed: 0,
        moved: 0,
        deleted: 0,
        unchanged: 3,
      },
    };
    let executorSignal: AbortSignal | null = null;
    const partitionSyncExecutor = jest.fn(async (input: {
      rawInput: unknown;
      cancellationSignal: AbortSignal;
    }) => {
      executorSignal = input.cancellationSignal;
      expect(input.rawInput).toEqual(claimedJob.input);
      return {
        status: 'completed' as const,
        output: boundedResult,
        retryable: false,
      };
    });
    let terminalSql = '';
    let terminalParams: unknown[] = [];
    claimNextMock.mockResolvedValueOnce({ job: claimedJob });
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
            retention_until: new Date(Date.now() + Number(params[14])),
            completed_at: new Date('2026-08-24T12:00:00.000Z'),
          }],
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
        leaseMs: 30_000,
      })),
      recordClaimResult: jest.fn(),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => claimedJob),
      recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
      handleJobFailure: jest.fn(async () => ({ action: 'failed' as const })),
      markJobLeaseLost: jest.fn(async () => undefined),
      markJobCompleted: jest.fn(async () => undefined),
      flushSnapshotPipeline: jest.fn(async () => undefined),
    };

    try {
      await expect(runWorkerConsumerSlot(
        {
          slotIndex: 0,
          slotNumber: 1,
          workerId: 'worker-test-slot-1',
          statsWorkerId: 'worker-test-stats',
          isInspectorSlot: true,
        },
        {
          pollMs: 1,
          idleBackoffMs: 1,
          concurrency: 1,
          baseWorkerId: 'worker-test',
          statsWorkerId: 'worker-test-stats',
        },
        autonomyService as never,
        undefined,
        partitionSyncExecutor
      )).rejects.toBe(stopAfterOneIteration);

      expect(partitionSyncExecutor).toHaveBeenCalledTimes(1);
      expect(executorSignal?.aborted).toBe(false);
      expect(getOpenAIAdapterMock).not.toHaveBeenCalled();
      expect(probeOpenAIProviderHealthMock).not.toHaveBeenCalled();
      expect(syncOpenAIProviderRuntimeMock).not.toHaveBeenCalled();
      expect(runWorkerTrinityPromptMock).not.toHaveBeenCalled();
      expect(routeGptRequestMock).not.toHaveBeenCalled();
      expect(terminalSql).toContain(
        "WHEN 'backstage-notion-partition-sync' THEN CASE"
      );
      expect(terminalSql).toContain(
        "AND claim_generation = $12::bigint"
      );
      expect(terminalParams[0]).toBe('completed');
      expect(JSON.parse(String(terminalParams[1]))).toEqual(boundedResult);
      expect(JSON.stringify(terminalParams[1])).not.toContain(
        claimedJob.input.configurationDigest
      );
      expect(terminalParams[4]).toBeNull();
      expect(terminalParams[5]).toBeNull();
      expect(terminalParams.slice(9, 12)).toEqual([
        claimedJob.id,
        'worker-test-slot-1',
        '21',
      ]);
      expect(terminalParams[14]).toBe(7_200_000);
      expect(autonomyService.markJobCompleted).toHaveBeenCalledWith(
        claimedJob.id
      );
      expect(autonomyService.handleJobFailure).not.toHaveBeenCalled();
      expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      label: 'hands off one retry while the persisted budget remains',
      retryCount: 0,
      maxRetries: 1,
      expectedAction: 'retried',
    },
    {
      label: 'stops retrying at the persisted retry ceiling',
      retryCount: 1,
      maxRetries: 1,
      expectedAction: 'failed',
    },
  ] as const)('$label for a retryable partition-sync outcome', async ({
    retryCount,
    maxRetries,
    expectedAction,
  }) => {
    claimNextMock.mockReset();
    queryMock.mockReset();
    routeGptRequestMock.mockReset();
    runWorkerTrinityPromptMock.mockReset();
    getOpenAIAdapterMock.mockClear();
    probeOpenAIProviderHealthMock.mockClear();
    syncOpenAIProviderRuntimeMock.mockClear();

    const claimedJob = {
      id: retryCount === 0
        ? '77777777-7777-4777-8777-777777777777'
        : '88888888-8888-4888-8888-888888888888',
      worker_id: 'queue',
      job_type: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
      status: 'running',
      claim_generation: '22',
      input: {
        protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
        version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
        universeId: 'my-universe-2k26',
        shardKey: 'raw/year-1',
        configurationGeneration: 'generation-1',
        configurationDigest: 'b'.repeat(64),
      },
      retry_count: retryCount,
      max_retries: maxRetries,
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2099-08-24T12:01:00.000Z'),
      correlation_id: `trace-partition-sync-retry-${retryCount}`,
      cancel_requested_at: null,
      cancel_reason: null,
      created_at: new Date('2026-08-24T11:59:59.000Z'),
      updated_at: new Date('2026-08-24T12:00:00.000Z'),
    };
    const partitionSyncExecutor = jest.fn(async () => ({
      status: 'failed' as const,
      output: null,
      errorMessage:
        'Partition synchronization infrastructure is temporarily unavailable.',
      retryable: true,
    }));
    claimNextMock.mockResolvedValueOnce({ job: claimedJob });
    queryMock.mockImplementation(async (sql: unknown) => {
      const normalizedSql = String(sql);
      if (normalizedSql.startsWith('SELECT * FROM job_data')) {
        return { rows: [claimedJob] };
      }
      throw new Error(`Unexpected repository query: ${normalizedSql}`);
    });
    const retryPolicyActions: string[] = [];
    // Retry budgeting is owned by WorkerAutonomyService. This loop-level seam
    // proves the dedicated executor's retryable outcome reaches that policy
    // exactly once with the claimed row's persisted counters unchanged.
    const handleJobFailure = jest.fn(async (
      job: typeof claimedJob,
      _errorMessage: string,
      retryable: boolean
    ) => {
      const action = retryable && job.retry_count < job.max_retries
        ? 'retried' as const
        : 'failed' as const;
      retryPolicyActions.push(action);
      return { action };
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
        leaseMs: 30_000,
      })),
      recordClaimResult: jest.fn(),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => claimedJob),
      recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
      handleJobFailure,
      markJobLeaseLost: jest.fn(async () => undefined),
      markJobCompleted: jest.fn(async () => undefined),
      flushSnapshotPipeline: jest.fn(async () => undefined),
    };

    await expect(runWorkerConsumerSlot(
      {
        slotIndex: 0,
        slotNumber: 1,
        workerId: 'worker-test-slot-1',
        statsWorkerId: 'worker-test-stats',
        isInspectorSlot: true,
      },
      {
        pollMs: 1,
        idleBackoffMs: 1,
        concurrency: 1,
        baseWorkerId: 'worker-test',
        statsWorkerId: 'worker-test-stats',
      },
      autonomyService as never,
      undefined,
      partitionSyncExecutor
    )).rejects.toBe(stopAfterOneIteration);

    expect(partitionSyncExecutor).toHaveBeenCalledTimes(1);
    expect(handleJobFailure).toHaveBeenCalledTimes(1);
    expect(handleJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        id: claimedJob.id,
        retry_count: retryCount,
        max_retries: maxRetries,
      }),
      'Partition synchronization infrastructure is temporarily unavailable.',
      true,
      null
    );
    expect(retryPolicyActions).toEqual([expectedAction]);
    expect(getOpenAIAdapterMock).not.toHaveBeenCalled();
    expect(probeOpenAIProviderHealthMock).not.toHaveBeenCalled();
    expect(syncOpenAIProviderRuntimeMock).not.toHaveBeenCalled();
    expect(runWorkerTrinityPromptMock).not.toHaveBeenCalled();
    expect(routeGptRequestMock).not.toHaveBeenCalled();
    expect(autonomyService.markJobCompleted).not.toHaveBeenCalled();
    expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
  });

  it('aborts partition synchronization and refuses terminal persistence after the claim fence changes', async () => {
    claimNextMock.mockReset();
    queryMock.mockReset();
    routeGptRequestMock.mockReset();
    runWorkerTrinityPromptMock.mockReset();
    getOpenAIAdapterMock.mockClear();
    probeOpenAIProviderHealthMock.mockClear();
    syncOpenAIProviderRuntimeMock.mockClear();

    const claimedJob = {
      id: '99999999-9999-4999-8999-999999999999',
      worker_id: 'queue',
      job_type: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
      status: 'running',
      claim_generation: '23',
      input: {
        protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
        version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
        universeId: 'my-universe-2k26',
        shardKey: 'raw/year-1',
        configurationGeneration: 'generation-1',
        configurationDigest: 'c'.repeat(64),
      },
      retry_count: 0,
      max_retries: 1,
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2099-08-24T12:01:00.000Z'),
      correlation_id: 'trace-partition-sync-fence-loss',
      cancel_requested_at: null,
      cancel_reason: null,
      created_at: new Date('2026-08-24T11:59:59.000Z'),
      updated_at: new Date('2026-08-24T12:00:00.000Z'),
    };
    const reclaimedJob = {
      ...claimedJob,
      claim_generation: '24',
      last_worker_id: 'worker-test-slot-2',
    };
    let executorSignal: AbortSignal | null = null;
    const partitionSyncExecutor = jest.fn(async (input: {
      cancellationSignal: AbortSignal;
    }) => {
      executorSignal = input.cancellationSignal;
      return {
        status: 'completed' as const,
        output: {
          protocol: BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
          version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
          outcome: 'synchronized' as const,
          safeReasonCode: null,
          universeId: 'my-universe-2k26',
          shardKey: 'raw/year-1',
          fullSourceScan: true,
          manifestStatus: 'published' as const,
          manifestId: null,
          freshSnapshotId: null,
          pageCount: 0,
          chunkCount: 0,
          pageVersionReuseCount: 0,
          embeddedChunkCount: 0,
          pageChanges: {
            added: 0,
            changed: 0,
            moved: 0,
            deleted: 0,
            unchanged: 0,
          },
        },
        retryable: false,
      };
    });
    claimNextMock
      .mockResolvedValueOnce({ job: claimedJob })
      .mockResolvedValueOnce({ job: null });
    queryMock.mockImplementation(async (sql: unknown) => {
      const normalizedSql = String(sql);
      if (normalizedSql.startsWith('SELECT * FROM job_data')) {
        return { rows: [reclaimedJob] };
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
        leaseMs: 30_000,
      })),
      recordClaimResult: jest.fn(),
      markIdle: jest.fn(async () => undefined),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => claimedJob),
      recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
      handleJobFailure: jest.fn(async () => ({ action: 'failed' as const })),
      markJobLeaseLost: jest.fn(async () => undefined),
      markJobCompleted: jest.fn(async () => undefined),
      flushSnapshotPipeline: jest.fn(async () => undefined),
    };

    await expect(runWorkerConsumerSlot(
      {
        slotIndex: 0,
        slotNumber: 1,
        workerId: 'worker-test-slot-1',
        statsWorkerId: 'worker-test-stats',
        isInspectorSlot: true,
      },
      {
        pollMs: 1,
        idleBackoffMs: 1,
        concurrency: 1,
        baseWorkerId: 'worker-test',
        statsWorkerId: 'worker-test-stats',
      },
      autonomyService as never,
      undefined,
      partitionSyncExecutor
    )).rejects.toBe(stopAfterOneIteration);

    expect(partitionSyncExecutor).toHaveBeenCalledTimes(1);
    expect(executorSignal?.aborted).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(String(queryMock.mock.calls[0]?.[0])).toMatch(
      /^SELECT \* FROM job_data/u
    );
    expect(autonomyService.markJobLeaseLost).toHaveBeenCalledWith(
      claimedJob.id,
      'Queue job lease lost before terminal persistence.'
    );
    expect(autonomyService.markJobCompleted).not.toHaveBeenCalled();
    expect(autonomyService.handleJobFailure).not.toHaveBeenCalled();
    expect(getOpenAIAdapterMock).not.toHaveBeenCalled();
    expect(probeOpenAIProviderHealthMock).not.toHaveBeenCalled();
    expect(syncOpenAIProviderRuntimeMock).not.toHaveBeenCalled();
    expect(runWorkerTrinityPromptMock).not.toHaveBeenCalled();
    expect(routeGptRequestMock).not.toHaveBeenCalled();
  });

  it('claims protected Booker work once and persists only its sealed terminal result', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    claimNextMock.mockReset();
    queryMock.mockReset();
    routeGptRequestMock.mockReset();
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6a).toString('base64');
    const privatePrompt = 'private-claimed-booker-prompt-sentinel';
    const privateResult = 'private-claimed-booker-result-sentinel';
    const privatePartial = 'PRIVATE-FIRST-PARTIAL-WORKER-SENTINEL';
    const jobId = '11111111-1111-4111-8111-111111111111';
    const queuedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      prompt: privatePrompt,
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-claimed-booker',
      traceId: 'trace-claimed-booker',
      correlationId: 'trace-claimed-booker',
      executionModeReason: 'backstage_action_policy_heavy',
    });
    const claimedJob = {
      id: jobId,
      worker_id: 'queue',
      job_type: 'gpt',
      status: 'running',
      claim_generation: '9',
      input: queuedInput,
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2026-08-23T12:01:00.000Z'),
      correlation_id: 'trace-claimed-booker',
      cancel_requested_at: null,
      cancel_reason: null,
      created_at: new Date('2026-08-23T11:59:59.000Z'),
      updated_at: new Date('2026-08-23T12:00:00.000Z'),
      request_fingerprint_hash: 'a'.repeat(64),
      idempotency_key_hash: 'b'.repeat(64),
      idempotency_scope_hash: 'c'.repeat(64),
      idempotency_origin: 'client',
    };
    let terminalParams: unknown[] = [];
    let terminalRow: Record<string, unknown> | null = null;
    let terminalReadStarted!: () => void;
    const terminalReadStartedPromise = new Promise<void>(resolve => {
      terminalReadStarted = resolve;
    });
    let releaseTerminalRead!: () => void;
    const terminalReadGate = new Promise<void>(resolve => {
      releaseTerminalRead = resolve;
    });

    claimNextMock.mockResolvedValueOnce({ job: claimedJob });
    const retryEvents: string[] = [];
    const providerAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error(privatePartial), {
        code: 'OPENAI_COMPLETION_INCOMPLETE',
        finishReason: 'length',
        incompleteReason: 'max_output_tokens',
        outputText: privatePartial,
      }))
      .mockResolvedValueOnce(privateResult);
    routeGptRequestMock.mockImplementationOnce(async () => {
      const recovered = await runBackstageBookerCompactOutputAttempts(
        providerAttempt,
        () => true,
        event => retryEvents.push(event)
      );
      return {
        ok: true,
        result: recovered.result,
        _route: {
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage-booker',
          traceId: 'trace-claimed-booker',
        },
      };
    });
    queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
      const normalizedSql = String(sql);
      if (normalizedSql.startsWith('SELECT * FROM job_data')) {
        terminalReadStarted();
        await terminalReadGate;
        return { rows: [claimedJob] };
      }
      if (normalizedSql.includes('UPDATE job_data')) {
        terminalParams = params;
        terminalRow = {
          ...claimedJob,
          status: 'completed',
          output: JSON.parse(String(params[1])),
          last_heartbeat_at: null,
          lease_expires_at: null,
          completed_at: new Date('2026-08-23T12:00:00.100Z'),
        };
        return {
          rows: [terminalRow],
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
        leaseMs: 30_000,
      })),
      recordClaimResult: jest.fn(),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => claimedJob),
      recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
      markJobLeaseLost: jest.fn(async () => undefined),
      markJobCompleted: jest.fn(async () => undefined),
      flushSnapshotPipeline: jest.fn(async () => undefined),
    };

    try {
      const workerPromise = runWorkerConsumerSlot(
        {
          slotIndex: 0,
          slotNumber: 1,
          workerId: 'worker-test-slot-1',
          statsWorkerId: 'worker-test-stats',
          isInspectorSlot: true,
        },
        {
          pollMs: 1,
          idleBackoffMs: 1,
          concurrency: 1,
          baseWorkerId: 'worker-test',
          statsWorkerId: 'worker-test-stats',
        },
        autonomyService as never
      );
      const workerStopped = expect(workerPromise).rejects.toBe(
        stopAfterOneIteration
      );
      await terminalReadStartedPromise;
      await jest.advanceTimersByTimeAsync(35_001);
      expect(autonomyService.recordHeartbeat).toHaveBeenCalledTimes(4);
      releaseTerminalRead();
      await workerStopped;

      expect(claimNextMock).toHaveBeenCalledTimes(1);
      expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
      expect(providerAttempt.mock.calls).toEqual([[false], [true]]);
      expect(retryEvents).toEqual([
        'initial_length_exhaustion',
        'compact_retry_started',
        'compact_retry_provider_completed',
      ]);
      expect(routeGptRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        gptId: 'backstage-booker',
        body: expect.objectContaining({
          action: 'generateBooking',
          payload: expect.objectContaining({ prompt: privatePrompt }),
        }),
        requestId: 'request-claimed-booker',
        traceId: 'trace-claimed-booker',
        runtimeExecutionMode: 'background',
      }));
      expect(terminalParams[0]).toBe('completed');
      expect(terminalParams[9]).toBe(jobId);
      expect(terminalParams[10]).toBe('worker-test-slot-1');
      expect(terminalParams[11]).toBe('9');
      const persistedOutput = JSON.parse(String(terminalParams[1]));
      expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
      expect(JSON.stringify(persistedOutput)).not.toContain(privateResult);
      expect(unprotectBackstageQueuedGptJobOutput({
        jobId,
        rawInput: queuedInput,
        output: persistedOutput,
      })).toMatchObject({ ok: true, result: privateResult });
      expect(terminalRow).toMatchObject({
        id: jobId,
        request_fingerprint_hash: claimedJob.request_fingerprint_hash,
        idempotency_key_hash: claimedJob.idempotency_key_hash,
        idempotency_scope_hash: claimedJob.idempotency_scope_hash,
        idempotency_origin: claimedJob.idempotency_origin,
      });
      const repositorySql = queryMock.mock.calls.map(call => String(call[0]));
      expect(repositorySql.filter(sql => /INSERT\s+INTO\s+job_data/iu.test(sql)))
        .toHaveLength(0);
      expect(repositorySql.filter(sql => sql.includes('UPDATE job_data')))
        .toHaveLength(1);
      expect(JSON.stringify([
        terminalParams,
        terminalRow,
        recordJobEventMock.mock.calls,
        retryEvents,
        consoleLog.mock.calls,
        consoleWarn.mock.calls,
      ])).not.toContain(privatePartial);
      expect(autonomyService.markJobCompleted).toHaveBeenCalledWith(jobId);
      expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('persists a protected worker deadline as one sealed fenced terminal failure', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    claimNextMock.mockReset();
    queryMock.mockReset();
    routeGptRequestMock.mockReset();
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6b).toString('base64');
    process.env.BOOKER_WORKER_JOB_TIMEOUT_MS = '120000';
    const privatePrompt = 'private-timeout-booker-prompt-sentinel';
    const jobId = '22222222-2222-4222-8222-222222222222';
    const queuedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      prompt: privatePrompt,
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-timeout-booker',
      traceId: 'trace-timeout-booker',
      correlationId: 'trace-timeout-booker',
      executionModeReason: 'backstage_action_policy_heavy',
    });
    const claimedJob = {
      id: jobId,
      worker_id: 'queue',
      job_type: 'gpt',
      status: 'running',
      claim_generation: '10',
      input: queuedInput,
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2026-08-23T12:03:00.000Z'),
      correlation_id: 'trace-timeout-booker',
      cancel_requested_at: null,
      cancel_reason: null,
      started_at: new Date('2026-08-23T12:00:00.000Z'),
      created_at: new Date('2026-08-23T11:59:59.000Z'),
      updated_at: new Date('2026-08-23T12:00:00.000Z'),
    };
    let terminalParams: unknown[] = [];
    let providerStarted!: () => void;
    let releaseLateProvider!: () => void;
    let activeProviderSignal: AbortSignal | undefined;
    let terminalWriteCount = 0;
    const providerStartedPromise = new Promise<void>(resolve => {
      providerStarted = resolve;
    });

    claimNextMock.mockResolvedValueOnce({ job: claimedJob });
    routeGptRequestMock.mockImplementationOnce((input: {
      parentAbortSignal?: AbortSignal;
    }) => {
      activeProviderSignal = input.parentAbortSignal;
      providerStarted();
      return new Promise(resolve => {
        releaseLateProvider = () => resolve({
          ok: true,
          result: 'late provider output must not replace the terminal timeout',
          _route: {
            gptId: 'backstage-booker',
            module: 'BACKSTAGE:BOOKER',
            action: 'generateBooking',
          },
        });
      });
    });
    queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
      const normalizedSql = String(sql);
      if (normalizedSql.startsWith('SELECT * FROM job_data')) {
        return { rows: [claimedJob] };
      }
      if (normalizedSql.includes('UPDATE job_data')) {
        terminalWriteCount += 1;
        terminalParams = params;
        return {
          rows: [{
            ...claimedJob,
            status: 'failed',
            output: JSON.parse(String(params[1])),
            error_message: params[2],
            last_heartbeat_at: null,
            lease_expires_at: null,
            completed_at: new Date(),
          }],
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
        leaseMs: 30_000,
      })),
      recordClaimResult: jest.fn(),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => claimedJob),
      recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
      markJobLeaseLost: jest.fn(async () => undefined),
      markJobCompleted: jest.fn(async () => undefined),
      handleJobFailure: jest.fn(async (
        job: typeof claimedJob,
        errorMessage: string,
        _retryable: boolean,
        output: unknown
      ) => {
        const terminalJob = await updateClaimedJobTerminal(
          job.id,
          'failed',
          {
            fence: createClaimedJobFence(
              'worker-test-slot-1',
              job.claim_generation
            ),
            output,
            errorMessage,
          }
        );
        return { action: terminalJob ? 'failed' : 'lease_lost' };
      }),
      flushSnapshotPipeline: jest.fn(async () => undefined),
    };

    try {
      const workerPromise = runWorkerConsumerSlot(
        {
          slotIndex: 0,
          slotNumber: 1,
          workerId: 'worker-test-slot-1',
          statsWorkerId: 'worker-test-stats',
          isInspectorSlot: true,
        },
        {
          pollMs: 1,
          idleBackoffMs: 1,
          concurrency: 1,
          baseWorkerId: 'worker-test',
          statsWorkerId: 'worker-test-stats',
        },
        autonomyService as never
      );
      const workerStopped = expect(workerPromise).rejects.toBe(
        stopAfterOneIteration
      );
      await providerStartedPromise;
      await jest.advanceTimersByTimeAsync(110_001);
      expect(activeProviderSignal?.aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(2_000);
      await workerStopped;

      expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
      expect(terminalParams[0]).toBe('failed');
      expect(terminalParams[2]).toBe(
        'BACKSTAGE_ASYNC_TIMEOUT: Protected Backstage generation reached its worker deadline.'
      );
      expect(terminalParams[10]).toBe('worker-test-slot-1');
      expect(terminalParams[11]).toBe('10');
      const persistedOutput = JSON.parse(String(terminalParams[1]));
      expect(JSON.stringify(persistedOutput)).not.toContain(privatePrompt);
      expect(unprotectBackstageQueuedGptJobOutput({
        jobId,
        rawInput: queuedInput,
        output: persistedOutput,
      })).toMatchObject({
        ok: false,
        error: { code: 'BACKSTAGE_ASYNC_TIMEOUT' },
      });
      expect(autonomyService.handleJobFailure).toHaveBeenCalledWith(
        claimedJob,
        'BACKSTAGE_ASYNC_TIMEOUT: Protected Backstage generation reached its worker deadline.',
        false,
        expect.anything()
      );
      expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
      expect(terminalWriteCount).toBe(1);
      const heartbeatCountAfterTerminal =
        autonomyService.recordHeartbeat.mock.calls.length;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(autonomyService.recordHeartbeat)
        .toHaveBeenCalledTimes(heartbeatCountAfterTerminal);
      releaseLateProvider();
      await Promise.resolve();
      expect(terminalWriteCount).toBe(1);
      expect(terminalParams[0]).toBe('failed');
    } finally {
      releaseLateProvider?.();
      delete process.env.BOOKER_WORKER_JOB_TIMEOUT_MS;
      jest.useRealTimers();
    }
  });

  it('revalidates the claim fence before scheduling a start snapshot or provider execution', async () => {
    claimNextMock.mockReset();
    queryMock.mockReset();
    routeGptRequestMock.mockReset();
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6c).toString('base64');
    const queuedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'private-delayed-start-booking-sentinel',
        },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: false,
    });
    const claimedJob = {
      id: '33333333-3333-4333-8333-333333333333',
      worker_id: 'queue',
      job_type: 'gpt',
      status: 'running',
      claim_generation: '11',
      input: queuedInput,
      last_worker_id: 'worker-test-slot-1',
      lease_expires_at: new Date('2026-08-23T12:00:15.000Z'),
      correlation_id: 'trace-delayed-start-booker',
      cancel_requested_at: null,
      cancel_reason: null,
      created_at: new Date('2026-08-23T11:59:59.000Z'),
      updated_at: new Date('2026-08-23T12:00:00.000Z'),
    };
    claimNextMock
      .mockResolvedValueOnce({ job: claimedJob })
      .mockResolvedValueOnce({ job: null });
    const autonomyService = {
      markDispatcherStarted: jest.fn(async () => undefined),
      getHeartbeatIntervalMs: jest.fn(() => 30_000),
      getRecommendedWorkerHeartbeatDelayMs: jest.fn(() => 30_000),
      recordWorkerHeartbeat: jest.fn(async () => undefined),
      evaluateBudgetsBeforeClaim: jest.fn(async () => ({ allowed: true })),
      recordClaimAttempt: jest.fn(),
      getClaimOptions: jest.fn(() => ({
        workerId: 'worker-test-slot-1',
        leaseMs: 15_000,
      })),
      recordClaimResult: jest.fn(),
      markJobStarted: jest.fn(async () => undefined),
      recordHeartbeat: jest.fn(async () => null),
      markJobLeaseLost: jest.fn(async () => undefined),
      markIdle: jest.fn(async () => undefined),
      flushSnapshotPipeline: jest.fn(async () => undefined),
    };

    const workerPromise = runWorkerConsumerSlot(
      {
        slotIndex: 0,
        slotNumber: 1,
        workerId: 'worker-test-slot-1',
        statsWorkerId: 'worker-test-stats',
        isInspectorSlot: true,
      },
      {
        pollMs: 1,
        idleBackoffMs: 1,
        concurrency: 1,
        baseWorkerId: 'worker-test',
        statsWorkerId: 'worker-test-stats',
      },
      autonomyService as never
    );
    await expect(workerPromise).rejects.toBe(stopAfterOneIteration);

    expect(autonomyService.recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(autonomyService.recordHeartbeat).toHaveBeenCalledWith(
      claimedJob,
      {
        source: 'job-start-heartbeat',
        shouldApplyResult: expect.any(Function),
      }
    );
    expect(autonomyService.markJobStarted).not.toHaveBeenCalled();
    expect(routeGptRequestMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(autonomyService.markJobLeaseLost).toHaveBeenCalledWith(
      claimedJob.id,
      'Initial heartbeat fence was lost before provider initialization.'
    );
  });

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

  it.each([
    {
      label: 'completed canon receipt',
      admittedCanon: true,
      legacyBackstage: false,
      cancellationPath: 'late',
    },
    {
      label: 'ordinary GPT cancellation',
      admittedCanon: false,
      legacyBackstage: false,
      cancellationPath: 'late',
    },
    {
      label: 'redacted legacy Backstage late cancellation',
      admittedCanon: false,
      legacyBackstage: true,
      cancellationPath: 'late',
    },
    {
      label: 'redacted legacy Backstage completion-CAS cancellation',
      admittedCanon: false,
      legacyBackstage: true,
      cancellationPath: 'cas',
    },
    {
      label: 'redacted legacy Backstage caught-failure cancellation',
      admittedCanon: false,
      legacyBackstage: true,
      cancellationPath: 'catch',
    },
    {
      label: 'redacted markerless preliminary non-Booker late cancellation',
      admittedCanon: false,
      legacyBackstage: false,
      markerlessCandidate: true,
      cancellationPath: 'late',
    },
    {
      label: 'redacted markerless preliminary non-Booker completion-CAS cancellation',
      admittedCanon: false,
      legacyBackstage: false,
      markerlessCandidate: true,
      cancellationPath: 'cas',
    },
    {
      label: 'redacted malformed markerless late cancellation',
      admittedCanon: false,
      legacyBackstage: false,
      malformedMarkerless: true,
      cancellationPath: 'late',
    },
    {
      label: 'redacted malformed markerless failure-CAS cancellation',
      admittedCanon: false,
      legacyBackstage: false,
      malformedMarkerless: true,
      cancellationPath: 'cas',
    },
    {
      label: 'current-marker malformed generic cancellation',
      admittedCanon: false,
      legacyBackstage: false,
      currentMalformed: true,
      cancellationPath: 'late',
    },
  ] as const)(
    'persists a $label when cancellation arrives before terminal persistence',
    async ({
      admittedCanon,
      legacyBackstage,
      cancellationPath,
      markerlessCandidate = false,
      malformedMarkerless = false,
      currentMalformed = false,
    }) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
      claimNextMock.mockReset();
      queryMock.mockReset();
      runWorkerTrinityPromptMock.mockReset();
      routeGptRequestMock.mockReset();
      getGptModuleMapMock.mockReset();
      getGptModuleMapMock.mockResolvedValue({
        'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
        'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      });

      const mutationId = '8d64dad3-f080-4bac-88ec-994005dc7152';
      const privateMarkerlessCancellation =
        legacyBackstage || markerlessCandidate || malformedMarkerless;
      const jobId = admittedCanon
        ? 'gpt-canon-cancellation-race'
        : privateMarkerlessCancellation
          ? 'gpt-legacy-backstage-cancellation-race'
          : 'gpt-ordinary-cancellation-race';
      const requestId = admittedCanon
        ? 'req-gpt-canon-cancellation-race'
        : privateMarkerlessCancellation
          ? 'req-gpt-legacy-backstage-cancellation-race'
          : 'req-gpt-ordinary-cancellation-race';
      const claimedJob = {
        id: jobId,
        worker_id: 'queue',
        job_type: 'gpt',
        status: 'running',
        claim_generation: '9',
        input: malformedMarkerless
          ? 'private-malformed-markerless-input-sentinel'
          : currentMalformed
            ? {
                producerContract: {
                  version: 1,
                  source: 'queued-gpt-runtime',
                },
              }
          : admittedCanon
          ? {
              gptId: 'backstage',
              body: {
                action: 'upsertStoryline',
                payload: { mutationId },
              },
              requestId,
              backstageMutationAdmission: {
                version: 1,
                source: 'control-plane-http',
                module: 'BACKSTAGE:BOOKER',
                action: 'upsertStoryline',
                scope: 'mcp:invoke',
                principalId: 'operator:worker-cancellation-race',
              },
            }
          : privateMarkerlessCancellation
            ? {
                gptId: markerlessCandidate
                  ? 'retired-markerless-routing-alias'
                  : 'configured-legacy-booker-alias',
                body: {
                  ...(markerlessCandidate
                    ? { action: 'query', prompt: 'Private markerless prompt.' }
                    : {
                        action: 'generateBooking',
                        payload: {
                          universeId: 'phase-two',
                          prompt: 'Private legacy generation prompt.',
                        },
                      }),
                },
                requestId,
              }
            : {
              gptId: 'arcanos-build',
              body: { prompt: 'Ordinary provider work.' },
              requestId,
              producerContract: {
                version: 1,
                source: 'queued-gpt-runtime',
              },
            },
        output: null,
        error_message: null,
        autonomy_state: privateMarkerlessCancellation
          ? {
              cancellation: {
                requested: true,
                requestedAt: '2026-08-14T12:00:00.100Z',
                reason: 'private-autonomy-legacy-cancellation-sentinel',
                callerDetails: 'private-autonomy-legacy-cancellation-sentinel',
              },
              safeRecoveryState: { attempt: 1 },
            }
          : {},
        last_worker_id: 'worker-test-slot-1',
        lease_expires_at: new Date('2026-08-14T12:01:00.000Z'),
        cancel_requested_at: null,
        cancel_reason: null,
        correlation_id: requestId,
        created_at: new Date('2026-08-14T11:59:59.000Z'),
        updated_at: new Date('2026-08-14T12:00:00.000Z'),
      };
      const cancellationReason = admittedCanon
        ? 'Cancellation arrived after the canon mutation committed'
        : privateMarkerlessCancellation
          ? 'private-legacy-late-cancellation-sentinel'
          : 'Cancel ordinary GPT work after provider completion';
      const cancellationRow = {
        ...claimedJob,
        cancel_requested_at: new Date('2026-08-14T12:00:00.100Z'),
        cancel_reason: cancellationReason,
      };
      const result = admittedCanon
        ? {
            universeId: 'phase-two',
            mutationId,
            applied: null,
            universeRevision: null,
            storyline: null,
            persistence: {
              status: 'unknown',
              durable: null,
              backend: 'postgresql',
              degraded: true,
              reason: 'commit_outcome_unknown',
            },
          }
        : { text: 'provider completed' };
      const routeEnvelope = {
        ok: true,
        result,
        _route: admittedCanon
          ? { module: 'BACKSTAGE:BOOKER', route: 'backstage' }
          : legacyBackstage
            ? {
                module: 'BACKSTAGE:BOOKER',
                action: 'generateBooking',
                route: 'backstage-booker',
              }
            : markerlessCandidate
              ? {
                  module: 'ARCANOS:CORE',
                  action: 'query',
                  route: 'arcanos-core',
                }
              : { module: 'ARCANOS:BUILD', route: 'arcanos-build' },
      };
      let jobReadCount = 0;
      let terminalWriteCount = 0;
      let terminalSql = '';
      let terminalParams: unknown[] = [];
      let terminalMergedAutonomyState: Record<string, unknown> = {};
      const parseFailure = malformedMarkerless || currentMalformed;
      const caughtExecutionFailure = new Error(
        'temporary legacy execution setup failure'
      );

      claimNextMock
        .mockResolvedValueOnce({ job: claimedJob })
        .mockResolvedValue({ job: null });
      routeGptRequestMock.mockResolvedValueOnce(routeEnvelope);
      if (privateMarkerlessCancellation && !malformedMarkerless) {
        getGptModuleMapMock
          .mockReset()
          .mockResolvedValueOnce(markerlessCandidate
            ? {
                'arcanos-core': {
                  route: 'arcanos-core',
                  module: 'ARCANOS:CORE',
                },
              }
            : {
                'configured-legacy-booker-alias': {
                  route: 'backstage-booker',
                  module: 'BACKSTAGE:BOOKER',
                },
              })
          .mockResolvedValue({
            'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
            'backstage-booker': {
              route: 'backstage-booker',
              module: 'BACKSTAGE:BOOKER',
            },
          });
      }
      queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
        const normalizedSql = String(sql);
        if (normalizedSql.startsWith('SELECT * FROM job_data')) {
          if (cancellationPath === 'catch' && jobReadCount === 0) {
            jobReadCount += 1;
            throw caughtExecutionFailure;
          }
          const row = cancellationPath === 'cas'
            ? jobReadCount < (parseFailure ? 1 : 2)
              ? claimedJob
              : cancellationRow
            : cancellationPath === 'catch'
              ? cancellationRow
              : !parseFailure && jobReadCount === 0
                ? claimedJob
                : cancellationRow;
          jobReadCount += 1;
          return { rows: [row] };
        }
        if (normalizedSql.includes('UPDATE job_data')) {
          terminalWriteCount += 1;
          if (
            cancellationPath === 'cas'
            && !parseFailure
            && terminalWriteCount === 1
          ) {
            return { rows: [] };
          }
          terminalSql = normalizedSql;
          terminalParams = params;
          terminalMergedAutonomyState = {
            ...(cancellationRow.autonomy_state as Record<string, unknown>),
            ...(JSON.parse(String(params[3])) as Record<string, unknown>),
          };
          return {
            rows: [{
              ...cancellationRow,
              status: String(params[0]),
              output: JSON.parse(String(params[1])),
              autonomy_state: terminalMergedAutonomyState,
              completed_at: new Date('2026-08-14T12:00:00.200Z'),
              lease_expires_at: null,
            }],
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
          leaseMs: 30_000,
        })),
        recordClaimResult: jest.fn(),
        markIdle: jest.fn(async () => undefined),
        markJobStarted: jest.fn(async () => undefined),
        recordHeartbeat: jest.fn(async () => claimedJob),
        recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
        handleJobFailure: jest.fn(async () => ({ action: 'lease_lost' })),
        markJobLeaseLost: jest.fn(async () => undefined),
        markJobCompleted: jest.fn(async () => undefined),
        markJobCancelled: jest.fn(async () => undefined),
        flushSnapshotPipeline: jest.fn(async () => undefined),
      };

      try {
        await expect(runWorkerConsumerSlot(
          {
            slotIndex: 0,
            slotNumber: 1,
            workerId: 'worker-test-slot-1',
            statsWorkerId: 'worker-test-stats',
            isInspectorSlot: true,
          },
          {
            pollMs: 1,
            idleBackoffMs: 1,
            concurrency: 1,
            baseWorkerId: 'worker-test',
            statsWorkerId: 'worker-test-stats',
          },
          autonomyService as never
        )).rejects.toBe(stopAfterOneIteration);

        expect(routeGptRequestMock).toHaveBeenCalledTimes(
          cancellationPath === 'catch' || malformedMarkerless || currentMalformed
            ? 0
            : 1
        );
        expect(terminalSql).toContain("$1::varchar(50) = 'completed'::varchar(50)");
        expect(terminalSql).toContain('AND $16::boolean');
        expect(terminalWriteCount).toBe(
          cancellationPath === 'cas' && !parseFailure ? 2 : 1
        );
        expect(terminalParams[0]).toBe(admittedCanon ? 'completed' : 'cancelled');
        expect(terminalParams[15]).toBe(admittedCanon);
        if (admittedCanon) {
          expect(JSON.parse(String(terminalParams[1]))).toEqual(routeEnvelope);
          expect(JSON.parse(String(terminalParams[3]))).toMatchObject({
            gptResultReuse: {
              reusable: false,
              reason: 'backstage_canon_commit_outcome_unknown',
            },
          });
          expect(autonomyService.markJobCompleted).toHaveBeenCalledWith(jobId);
          expect(autonomyService.markJobCancelled).not.toHaveBeenCalled();
        } else {
          expect(JSON.parse(String(terminalParams[1]))).toBeNull();
          expect(terminalParams[2]).toBe(
            privateMarkerlessCancellation
              ? 'Legacy Backstage generation cancellation requested during compatibility drain.'
              : cancellationReason
          );
          if (privateMarkerlessCancellation) {
            expect(JSON.stringify(terminalParams)).not.toContain(cancellationReason);
            expect(JSON.stringify(terminalMergedAutonomyState)).not.toContain(
              'private-autonomy-legacy-cancellation-sentinel'
            );
            expect(terminalMergedAutonomyState).toMatchObject({
              cancellation: {
                requested: true,
                requestedAt: '2026-08-14T12:00:00.100Z',
                reason:
                  'Legacy Backstage generation cancellation requested during compatibility drain.',
              },
              safeRecoveryState: { attempt: 1 },
            });
            expect(getGptModuleMapMock).toHaveBeenCalledTimes(
              malformedMarkerless ? 0 : 1
            );
          }
          expect(autonomyService.markJobCancelled).toHaveBeenCalledWith(jobId);
          expect(autonomyService.markJobCompleted).not.toHaveBeenCalled();
        }
        expect(autonomyService.handleJobFailure).toHaveBeenCalledTimes(
          cancellationPath === 'catch' || (cancellationPath === 'cas' && parseFailure)
            ? 1
            : 0
        );
        expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    }
  );
});
