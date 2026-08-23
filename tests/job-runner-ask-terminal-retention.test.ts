import { afterAll, describe, expect, it, jest } from '@jest/globals';

const queryMock = jest.fn();
const isDatabaseConnectedMock = jest.fn(() => true);
const recordJobEventMock = jest.fn(async () => undefined);
const claimNextMock = jest.fn();
const runWorkerTrinityPromptMock = jest.fn();
const routeGptRequestMock = jest.fn();
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
const originalBackstagePayloadKey =
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;

process.env.OPENAI_API_KEY = 'provider-free-worker-test-key';

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  initializeDatabase: jest.fn(),
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: jest.fn(async () => ({
    'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
    'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' }
  }))
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
  assertValidResponsesCreateParams: jest.fn(),
  normalizeResponsesCreateParams: jest.fn((value: unknown) => value),
  getOpenAIAdapter: jest.fn(() => ({
    getClient: () => fakeOpenAIClient
  }))
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: jest.fn(() => providerRuntime),
  getOpenAIProviderRuntimeStatus: jest.fn(() => providerRuntime),
  probeOpenAIProviderHealth: jest.fn(async () => ({
    ok: true,
    runtime: providerRuntime
  })),
  syncOpenAIProviderRuntime: jest.fn(() => ({
    runtime: providerRuntime
  }))
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null)
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
  if (originalBackstagePayloadKey === undefined) {
    delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  } else {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      originalBackstagePayloadKey;
  }
});

describe('job runner terminal persistence', () => {
  it('claims protected Booker work once and persists only its sealed terminal result', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    claimNextMock.mockReset();
    queryMock.mockReset();
    routeGptRequestMock.mockReset();
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6a).toString('base64');
    const privatePrompt = 'private-claimed-booker-prompt-sentinel';
    const privateResult = 'private-claimed-booker-result-sentinel';
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
    };
    let terminalParams: unknown[] = [];

    claimNextMock.mockResolvedValueOnce({ job: claimedJob });
    routeGptRequestMock.mockResolvedValueOnce({
      ok: true,
      result: privateResult,
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        traceId: 'trace-claimed-booker',
      },
    });
    queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
      const normalizedSql = String(sql);
      if (normalizedSql.startsWith('SELECT * FROM job_data')) {
        return { rows: [claimedJob] };
      }
      if (normalizedSql.includes('UPDATE job_data')) {
        terminalParams = params;
        return {
          rows: [{
            ...claimedJob,
            status: 'completed',
            output: JSON.parse(String(params[1])),
            last_heartbeat_at: null,
            lease_expires_at: null,
            completed_at: new Date('2026-08-23T12:00:00.100Z'),
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

      expect(claimNextMock).toHaveBeenCalledTimes(1);
      expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
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
      const persistedOutput = JSON.parse(String(terminalParams[1]));
      expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
      expect(JSON.stringify(persistedOutput)).not.toContain(privateResult);
      expect(unprotectBackstageQueuedGptJobOutput({
        jobId,
        rawInput: queuedInput,
        output: persistedOutput,
      })).toMatchObject({ ok: true, result: privateResult });
      expect(autonomyService.markJobCompleted).toHaveBeenCalledWith(jobId);
      expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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
    },
    {
      label: 'ordinary GPT cancellation',
      admittedCanon: false,
    },
  ])(
    'persists a $label when cancellation arrives before terminal persistence',
    async ({ admittedCanon }) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
      claimNextMock.mockReset();
      queryMock.mockReset();
      runWorkerTrinityPromptMock.mockReset();
      routeGptRequestMock.mockReset();

      const mutationId = '8d64dad3-f080-4bac-88ec-994005dc7152';
      const jobId = admittedCanon
        ? 'gpt-canon-cancellation-race'
        : 'gpt-ordinary-cancellation-race';
      const requestId = admittedCanon
        ? 'req-gpt-canon-cancellation-race'
        : 'req-gpt-ordinary-cancellation-race';
      const claimedJob = {
        id: jobId,
        worker_id: 'queue',
        job_type: 'gpt',
        status: 'running',
        claim_generation: '9',
        input: admittedCanon
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
          : {
              gptId: 'arcanos-build',
              body: { prompt: 'Ordinary provider work.' },
              requestId,
            },
        output: null,
        error_message: null,
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
          : { module: 'ARCANOS:BUILD', route: 'arcanos-build' },
      };
      let jobReadCount = 0;
      let terminalSql = '';
      let terminalParams: unknown[] = [];

      claimNextMock.mockResolvedValueOnce({ job: claimedJob });
      routeGptRequestMock.mockResolvedValueOnce(routeEnvelope);
      queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
        const normalizedSql = String(sql);
        if (normalizedSql.startsWith('SELECT * FROM job_data')) {
          const row = jobReadCount === 0 ? claimedJob : cancellationRow;
          jobReadCount += 1;
          return { rows: [row] };
        }
        if (normalizedSql.includes('UPDATE job_data')) {
          terminalSql = normalizedSql;
          terminalParams = params;
          return {
            rows: [{
              ...cancellationRow,
              status: String(params[0]),
              output: JSON.parse(String(params[1])),
              autonomy_state: JSON.parse(String(params[3])),
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
        markJobStarted: jest.fn(async () => undefined),
        recordHeartbeat: jest.fn(async () => claimedJob),
        recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
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

        expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
        expect(terminalSql).toContain("$1::varchar(50) = 'completed'::varchar(50)");
        expect(terminalSql).toContain('AND $15::boolean');
        expect(terminalParams[0]).toBe(admittedCanon ? 'completed' : 'cancelled');
        expect(terminalParams[14]).toBe(admittedCanon);
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
          expect(terminalParams[2]).toBe(cancellationReason);
          expect(autonomyService.markJobCancelled).toHaveBeenCalledWith(jobId);
          expect(autonomyService.markJobCompleted).not.toHaveBeenCalled();
        }
        expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    }
  );
});
