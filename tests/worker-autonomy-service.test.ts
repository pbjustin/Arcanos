import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobQueueSummaryMock = jest.fn();
const getJobExecutionStatsSinceMock = jest.fn();
const recordJobHeartbeatMock = jest.fn();
const recoverStalledJobsForWorkersMock = jest.fn();
const recoverStaleJobsMock = jest.fn();
const scheduleJobRetryMock = jest.fn();
const deferJobForProviderRecoveryMock = jest.fn();
const updateJobMock = jest.fn();
const cleanupExpiredGptJobsMock = jest.fn();
const listWorkerLivenessMock = jest.fn();
const listWorkerRuntimeStateSnapshotsMock = jest.fn();
const listWorkerRuntimeSnapshotsMock = jest.fn();
const upsertWorkerRuntimeSnapshotMock = jest.fn();
const recordWorkerLivenessMock = jest.fn();
const upsertWorkerRuntimeStateMock = jest.fn();
const appendWorkerRuntimeHistoryMock = jest.fn();
const runFailedJobCleanupMock = jest.fn();
const fetchMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const resolveJobWorkerStaleAfterMsMock = jest.fn((env: NodeJS.ProcessEnv = process.env) => {
  const rawValue = env.JOB_WORKER_STALE_AFTER_MS;
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 45_000;
  }

  return Math.max(1_000, Math.trunc(parsedValue));
});

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  getJobQueueSummary: getJobQueueSummaryMock,
  getJobExecutionStatsSince: getJobExecutionStatsSinceMock,
  recordJobHeartbeat: recordJobHeartbeatMock,
  recoverStalledJobsForWorkers: recoverStalledJobsForWorkersMock,
  recoverStaleJobs: recoverStaleJobsMock,
  resolveJobWorkerStaleAfterMs: resolveJobWorkerStaleAfterMsMock,
  scheduleJobRetry: scheduleJobRetryMock,
  deferJobForProviderRecovery: deferJobForProviderRecoveryMock,
  updateJob: updateJobMock,
  cleanupExpiredGptJobs: cleanupExpiredGptJobsMock
}));

jest.unstable_mockModule('@core/db/repositories/workerRuntimeRepository.js', () => ({
  listWorkerLiveness: listWorkerLivenessMock,
  listWorkerRuntimeStateSnapshots: listWorkerRuntimeStateSnapshotsMock,
  listWorkerRuntimeSnapshots: listWorkerRuntimeSnapshotsMock,
  upsertWorkerRuntimeSnapshot: upsertWorkerRuntimeSnapshotMock,
  recordWorkerLiveness: recordWorkerLivenessMock,
  upsertWorkerRuntimeState: upsertWorkerRuntimeStateMock,
  appendWorkerRuntimeHistory: appendWorkerRuntimeHistoryMock
}));

jest.unstable_mockModule('../src/queue/cleanup.js', () => ({
  runFailedJobCleanup: runFailedJobCleanupMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  },
  default: {
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock
  },
  logger: {
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock
  }
}));

const {
  WorkerAutonomyService,
  classifyWorkerExecutionError,
  getWorkerAutonomyHealthReport,
  getWorkerAutonomySettings,
  planAutonomousWorkerJob
} = await import('../src/services/workerAutonomyService.js');

const workerTimingEnvKeys = [
  'JOB_WORKER_HEARTBEAT_MS',
  'JOB_WORKER_STALE_AFTER_MS',
  'JOB_WORKER_WATCHDOG_MS',
  'JOB_WORKER_WATCHDOG_IDLE_MS'
] as const;

function withWorkerTimingEnv<T>(
  values: Partial<Record<(typeof workerTimingEnvKeys)[number], string>>,
  callback: () => T
): T {
  const previousValues = new Map<(typeof workerTimingEnvKeys)[number], string | undefined>();

  for (const key of workerTimingEnvKeys) {
    previousValues.set(key, process.env[key]);

    if (Object.prototype.hasOwnProperty.call(values, key)) {
      process.env[key] = values[key];
    } else {
      delete process.env[key];
    }
  }

  try {
    return callback();
  } finally {
    for (const key of workerTimingEnvKeys) {
      const previousValue = previousValues.get(key);

      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

describe('workerAutonomyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200
    });
    (globalThis as typeof globalThis & { fetch: typeof fetchMock }).fetch = fetchMock as any;
    getJobQueueSummaryMock.mockResolvedValue({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0,
      lastUpdatedAt: '2026-03-07T12:00:00.000Z'
    });
    getJobExecutionStatsSinceMock.mockResolvedValue({
      completed: 1,
      failed: 0,
      running: 0,
      totalTerminal: 1,
      aiCalls: 1
    });
    recordJobHeartbeatMock.mockResolvedValue(null);
    recoverStalledJobsForWorkersMock.mockResolvedValue({
      staleWorkerIds: [],
      stalledJobIds: [],
      requeuedJobIds: [],
      deadLetterJobIds: [],
      cancelledJobIds: []
    });
    recoverStaleJobsMock.mockResolvedValue({
      recoveredJobs: [],
      failedJobs: []
    });
    cleanupExpiredGptJobsMock.mockResolvedValue({
      expiredPending: 0,
      expiredTerminal: 0,
      deletedExpired: 0
    });
    runFailedJobCleanupMock.mockResolvedValue({
      enabled: true,
      skipped: false,
      keep: 50,
      minAgeMs: 86_400_000,
      deletedFailed: 0,
      retainedFailed: 0,
      deletedJobIds: []
    });
    scheduleJobRetryMock.mockResolvedValue({
      id: 'job-1'
    });
    deferJobForProviderRecoveryMock.mockResolvedValue({
      id: 'job-1'
    });
    updateJobMock.mockResolvedValue({
      id: 'job-1'
    });
    listWorkerLivenessMock.mockResolvedValue([]);
    listWorkerRuntimeStateSnapshotsMock.mockResolvedValue([]);
    listWorkerRuntimeSnapshotsMock.mockResolvedValue([]);
    upsertWorkerRuntimeSnapshotMock.mockResolvedValue(undefined);
    recordWorkerLivenessMock.mockResolvedValue(undefined);
    upsertWorkerRuntimeStateMock.mockResolvedValue(undefined);
    appendWorkerRuntimeHistoryMock.mockResolvedValue(undefined);
    process.env.WORKER_SNAPSHOT_PIPELINE_V2 = 'false';
    delete process.env.WORKER_SNAPSHOT_PRESERVE_LEGACY_TABLE;
    for (const key of workerTimingEnvKeys) {
      delete process.env[key];
    }
    getWorkerAutonomySettings({}, { refreshEnv: true });
  });

  it('uses quieter worker timing defaults when env is unset', () => {
    withWorkerTimingEnv({}, () => {
      const settings = getWorkerAutonomySettings({}, { refreshEnv: true });

      expect(settings.heartbeatIntervalMs).toBe(5_000);
      expect(settings.staleAfterMs).toBe(45_000);
      expect(settings.staleAfterMs).not.toBe(10_000);
      expect(settings.watchdogIntervalMs).toBe(10_000);
      expect(settings.watchdogIntervalMs).not.toBe(5_000);
      expect(settings.watchdogIdleMs).toBe(120_000);
    });
  });

  it('honors worker timing env overrides', () => {
    withWorkerTimingEnv(
      {
        JOB_WORKER_HEARTBEAT_MS: '7000',
        JOB_WORKER_STALE_AFTER_MS: '70000.9',
        JOB_WORKER_WATCHDOG_MS: '15000',
        JOB_WORKER_WATCHDOG_IDLE_MS: '180000'
      },
      () => {
        const settings = getWorkerAutonomySettings({}, { refreshEnv: true });

        expect(settings.heartbeatIntervalMs).toBe(7_000);
        expect(settings.staleAfterMs).toBe(70_000);
        expect(settings.watchdogIntervalMs).toBe(15_000);
        expect(settings.watchdogIdleMs).toBe(180_000);
      }
    );
  });

  it('caches worker timing defaults until env refresh is requested', () => {
    withWorkerTimingEnv(
      {
        JOB_WORKER_STALE_AFTER_MS: '70000',
        JOB_WORKER_WATCHDOG_MS: '15000'
      },
      () => {
        expect(getWorkerAutonomySettings({}, { refreshEnv: true })).toEqual(
          expect.objectContaining({
            staleAfterMs: 70_000,
            watchdogIntervalMs: 15_000
          })
        );

        process.env.JOB_WORKER_STALE_AFTER_MS = '90000';
        process.env.JOB_WORKER_WATCHDOG_MS = '30000';

        expect(getWorkerAutonomySettings()).toEqual(
          expect.objectContaining({
            staleAfterMs: 70_000,
            watchdogIntervalMs: 15_000
          })
        );
        expect(getWorkerAutonomySettings({}, { refreshEnv: true })).toEqual(
          expect.objectContaining({
            staleAfterMs: 90_000,
            watchdogIntervalMs: 30_000
          })
        );
      }
    );
  });

  it('defers low-priority jobs when queue pressure is high', async () => {
    getJobQueueSummaryMock.mockResolvedValue({
      pending: 30,
      running: 2,
      completed: 10,
      failed: 0,
      total: 42,
      delayed: 3,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 5_000,
      lastUpdatedAt: '2026-03-07T12:00:00.000Z'
    });

    const plannedJob = await planAutonomousWorkerJob(
      'ask',
      { prompt: 'Explain the deployment issue.', endpointName: 'ask' },
      {},
      {
        workerId: 'async-queue',
        workerType: 'async_queue',
        heartbeatIntervalMs: 10_000,
        leaseMs: 30_000,
        inspectorIntervalMs: 30_000,
        staleAfterMs: 60_000,
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      }
    );

    expect(plannedJob.priority).toBe(110);
    expect(plannedJob.nextRunAt).toBeInstanceOf(Date);
    expect(plannedJob.planningReasons).toContain('queue_depth_deferred');
  });

  it('plans priority GPT jobs ahead of normal queue work and caps retries', async () => {
    const originalMaxRetries = process.env.GPT_JOB_MAX_RETRIES;
    process.env.GPT_JOB_MAX_RETRIES = '1';

    try {
      const plannedJob = await planAutonomousWorkerJob('gpt', {
        gptId: 'arcanos-build',
        body: {
          prompt: 'Inspect current latency.'
        }
      });

      expect(plannedJob.priority).toBe(0);
      expect(plannedJob.maxRetries).toBe(1);
    } finally {
      if (originalMaxRetries === undefined) {
        delete process.env.GPT_JOB_MAX_RETRIES;
      } else {
        process.env.GPT_JOB_MAX_RETRIES = originalMaxRetries;
      }
    }
  });

  it('classifies transient and terminal failures separately', () => {
    expect(classifyWorkerExecutionError(new Error('OpenAI rate limit timeout')).retryable).toBe(true);
    expect(classifyWorkerExecutionError(new Error('OpenAI internal error')).retryable).toBe(true);
    expect(classifyWorkerExecutionError(new Error('Request was aborted.')).retryable).toBe(true);
    expect(classifyWorkerExecutionError(new Error('Invalid job.input: schema mismatch')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('401 Incorrect API key provided')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('API key expired')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('openai_call_aborted_due_to_budget')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('insufficient_quota')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('runtime_budget_exhausted')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('budgetexceeded')).retryable).toBe(false);
    expect(classifyWorkerExecutionError(new Error('watchdog aborted execution due to budget exhaustion')).retryable).toBe(false);
  });

  it('records aligned categories for terminal auth and budget failures', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 0,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const baseJob = {
      job_type: 'ask',
      worker_id: 'async-queue',
      status: 'running',
      input: { prompt: 'test' },
      retry_count: 0,
      max_retries: 0,
      created_at: new Date(),
      updated_at: new Date()
    } as const;

    const categoryCases = [
      { id: 'job-auth', message: 'API key expired', category: 'authentication' },
      { id: 'job-quota', message: 'insufficient_quota', category: 'rate_limited' },
      { id: 'job-budget', message: 'runtime_budget_exhausted', category: 'timeout' },
      { id: 'job-prompt', message: 'prompt too long', category: 'validation' }
    ] as const;

    for (const testCase of categoryCases) {
      updateJobMock.mockClear();

      await service.handleJobFailure(
        {
          ...baseJob,
          id: testCase.id
        } as any,
        testCase.message,
        false
      );

      expect(updateJobMock).toHaveBeenCalledWith(
        testCase.id,
        'failed',
        null,
        testCase.message,
        expect.objectContaining({
          lastFailure: expect.objectContaining({
            category: testCase.category,
            retryable: false,
            retryExhausted: false
          })
        }),
        expect.anything()
      );
    }
  });

  it('reports unhealthy worker health when stalled jobs or unhealthy snapshots exist', async () => {
    getJobQueueSummaryMock.mockResolvedValue({
      pending: 30,
      running: 2,
      completed: 10,
      failed: 1,
      total: 43,
      delayed: 1,
      stalledRunning: 1,
      oldestPendingJobAgeMs: 90_000,
      lastUpdatedAt: '2026-03-07T12:00:00.000Z'
    });
    listWorkerRuntimeSnapshotsMock.mockResolvedValue([
      {
        workerId: 'async-queue',
        workerType: 'async_queue',
        healthStatus: 'unhealthy',
        currentJobId: 'job-1',
        lastError: 'Worker stalled',
        startedAt: '2026-03-07T11:00:00.000Z',
        lastHeartbeatAt: '2026-03-07T11:59:00.000Z',
        lastInspectorRunAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:00.000Z',
        snapshot: {}
      }
    ]);

    const report = await getWorkerAutonomyHealthReport();

    expect(report.overallStatus).toBe('unhealthy');
    expect(report.alerts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('stalled'),
        expect.stringContaining('Queue pressure')
      ])
    );
  });

  it('keeps idle workers healthy when inactivity exceeds the watchdog threshold without pending work', async () => {
    listWorkerRuntimeSnapshotsMock.mockResolvedValue([
      {
        workerId: 'async-queue',
        workerType: 'async_queue',
        healthStatus: 'healthy',
        currentJobId: null,
        lastError: null,
        startedAt: '2026-03-07T11:55:00.000Z',
        lastHeartbeatAt: null,
        lastInspectorRunAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:00.000Z',
        snapshot: {
          lastActivityAt: '2026-03-07T11:56:00.000Z',
          lastProcessedJobAt: null,
          watchdog: {
            triggered: false,
            reason: null,
            inactivityMs: 240000,
            lastActivityAt: '2026-03-07T11:56:00.000Z',
            lastProcessedJobAt: null,
            idleThresholdMs: 120000,
            restartRecommended: false
          }
        }
      }
    ]);

    const report = await getWorkerAutonomyHealthReport();

    expect(report.overallStatus).toBe('healthy');
    expect(report.alerts).toEqual([]);
  });

  it('keeps bootstrap healthy when only informational notes are present', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const result = await service.bootstrap([
      'Worker bootstrap completed with 4 consumer slot(s).'
    ]);

    expect(result.healthStatus).toBe('healthy');
  });

  it('ignores legacy aggregate worker snapshots when slot snapshots are present', async () => {
    listWorkerRuntimeSnapshotsMock.mockResolvedValue([
      {
        workerId: 'async-queue',
        workerType: 'async_queue',
        healthStatus: 'healthy',
        currentJobId: null,
        lastError: null,
        startedAt: '2026-03-07T11:00:00.000Z',
        lastHeartbeatAt: null,
        lastInspectorRunAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:00.000Z',
        snapshot: {
          watchdog: {
            triggered: false,
            reason: 'No worker receipts or processed jobs observed for 240000ms after startup.',
            inactivityMs: 240000,
            lastActivityAt: null,
            lastProcessedJobAt: null,
            idleThresholdMs: 120000,
            restartRecommended: true
          }
        }
      },
      {
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        healthStatus: 'healthy',
        currentJobId: null,
        lastError: null,
        startedAt: '2026-03-07T11:58:00.000Z',
        lastHeartbeatAt: '2026-03-07T12:00:00.000Z',
        lastInspectorRunAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:00.000Z',
        snapshot: {
          lastActivityAt: '2026-03-07T12:00:00.000Z',
          lastProcessedJobAt: '2026-03-07T12:00:00.000Z',
          watchdog: {
            triggered: false,
            reason: null,
            inactivityMs: 0,
            lastActivityAt: '2026-03-07T12:00:00.000Z',
            lastProcessedJobAt: '2026-03-07T12:00:00.000Z',
            idleThresholdMs: 120000,
            restartRecommended: false
          }
        }
      }
    ]);

    const report = await getWorkerAutonomyHealthReport();

    expect(report.overallStatus).toBe('healthy');
    expect(report.workers.map((worker) => worker.workerId)).toEqual(['async-queue-slot-1']);
    expect(report.alerts).toEqual([]);
  });

  it('reads V2 runtime state for health reports when legacy preservation is disabled', async () => {
    process.env.WORKER_SNAPSHOT_PIPELINE_V2 = 'true';
    process.env.WORKER_SNAPSHOT_PRESERVE_LEGACY_TABLE = 'false';
    listWorkerRuntimeSnapshotsMock.mockResolvedValue([
      {
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        healthStatus: 'unhealthy',
        currentJobId: 'stale-job',
        lastError: 'stale legacy row',
        startedAt: '2026-03-07T11:00:00.000Z',
        lastHeartbeatAt: '2026-03-07T11:00:00.000Z',
        lastInspectorRunAt: '2026-03-07T11:00:00.000Z',
        updatedAt: '2026-03-07T11:00:00.000Z',
        snapshot: {}
      }
    ]);
    listWorkerRuntimeStateSnapshotsMock.mockResolvedValue([
      {
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        healthStatus: 'healthy',
        currentJobId: null,
        lastError: null,
        startedAt: '2026-03-07T11:58:00.000Z',
        lastHeartbeatAt: '2026-03-07T12:00:00.000Z',
        lastInspectorRunAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:00.000Z',
        snapshot: {}
      }
    ]);

    const report = await getWorkerAutonomyHealthReport();

    expect(listWorkerRuntimeStateSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(listWorkerRuntimeSnapshotsMock).not.toHaveBeenCalled();
    expect(report.overallStatus).toBe('healthy');
    expect(report.workers).toEqual([
      expect.objectContaining({
        workerId: 'async-queue-slot-1',
        healthStatus: 'healthy',
        currentJobId: null
      })
    ]);
  });

  it('schedules retries for transient failures before exhausting the retry budget', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const result = await service.handleJobFailure(
      {
        id: 'job-1',
        job_type: 'ask',
        worker_id: 'async-queue',
        status: 'running',
        input: { prompt: 'test' },
        retry_count: 0,
        max_retries: 2,
        created_at: new Date(),
        updated_at: new Date()
      } as any,
      'OpenAI rate limit timeout',
      true
    );

    expect(result).toEqual({
      action: 'retried',
      delayMs: 2000
    });
    expect(scheduleJobRetryMock).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        delayMs: 2000,
        workerId: 'async-queue'
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'worker.job.retry_scheduled',
      expect.objectContaining({
        module: 'worker-autonomy',
        workerId: 'async-queue',
        jobId: 'job-1',
        delayMs: 2000
      })
    );
    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          scheduledRetries: 1,
          recoveryActions: 1,
          lastRecoveryEvent: expect.objectContaining({
            action: 'retry_scheduled',
            jobIds: ['job-1']
          })
        })
      }),
      { source: 'job-retry' }
    );
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it('does not report a retry as scheduled when the running job lease was already lost', async () => {
    scheduleJobRetryMock.mockResolvedValueOnce(null);
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const result = await service.handleJobFailure(
      {
        id: 'job-lost-lease',
        job_type: 'ask',
        worker_id: 'async-queue',
        status: 'running',
        input: { prompt: 'test' },
        retry_count: 0,
        max_retries: 2,
        created_at: new Date(),
        updated_at: new Date()
      } as any,
      'OpenAI rate limit timeout',
      true
    );

    expect(result).toEqual({ action: 'failed' });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.job.retry_schedule.skipped',
      expect.objectContaining({
        module: 'worker-autonomy',
        workerId: 'async-queue',
        jobId: 'job-lost-lease'
      })
    );
    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          scheduledRetries: 0,
          recoveryActions: 0,
          lastRecoveryEvent: null,
          alerts: ['Retry scheduling skipped for job job-lost-lease; live lease was no longer owned by this worker.']
        })
      }),
      { source: 'job-retry-skipped' }
    );
  });

  it('defers provider-unavailable jobs without consuming retry budget', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const result = await service.deferJobForProviderRecovery(
      {
        id: 'job-provider',
        job_type: 'ask',
        worker_id: 'async-queue',
        status: 'running',
        input: { prompt: 'test' },
        retry_count: 2,
        max_retries: 2,
        created_at: new Date(),
        updated_at: new Date()
      } as any,
      {
        delayMs: 60_000,
        errorMessage: 'OpenAI provider unavailable before job execution; job deferred until provider recovery.',
        providerNextRetryAt: '2026-03-07T12:01:00.000Z',
        providerFailureCategory: 'circuit_open'
      }
    );

    expect(result).toEqual({
      action: 'deferred',
      delayMs: 60_000
    });
    expect(deferJobForProviderRecoveryMock).toHaveBeenCalledWith(
      'job-provider',
      expect.objectContaining({
        delayMs: 60_000,
        workerId: 'async-queue',
        autonomyState: expect.objectContaining({
          providerDeferral: expect.objectContaining({
            retryBudgetConsumed: false,
            failureCategory: 'circuit_open'
          })
        })
      })
    );
    expect(scheduleJobRetryMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          recoveryActions: 1,
          lastRecoveryEvent: expect.objectContaining({
            action: 'provider_deferred',
            jobIds: ['job-provider']
          })
        })
      }),
      { source: 'provider-deferred' }
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'worker.circuit_breaker.cooldown.defer',
      expect.objectContaining({
        jobId: 'job-provider',
        providerFailureCategory: 'circuit_open'
      })
    );
  });

  it('skips provider deferral when the claimed job is no longer running', async () => {
    deferJobForProviderRecoveryMock.mockResolvedValueOnce(null);
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const result = await service.deferJobForProviderRecovery(
      {
        id: 'job-provider',
        job_type: 'ask',
        worker_id: 'async-queue',
        status: 'completed',
        input: { prompt: 'test' },
        retry_count: 2,
        max_retries: 2,
        created_at: new Date(),
        updated_at: new Date()
      } as any,
      {
        delayMs: 60_000,
        errorMessage: 'OpenAI provider unavailable before job execution; job deferred until provider recovery.',
        providerFailureCategory: 'circuit_open'
      }
    );

    expect(result).toEqual({
      action: 'skipped',
      delayMs: 60_000
    });
    expect(scheduleJobRetryMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workerId: 'async-queue',
        healthStatus: 'degraded',
        snapshot: expect.objectContaining({
          alerts: ['Provider deferral skipped for job job-provider; job was no longer running.']
        })
      }),
      { source: 'provider-deferred-skipped' }
    );
  });

  it('records circuit breaker reset as an observable recovery action', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    await service.recordProviderCircuitBreakerReset({
      providerFailureCategory: 'circuit_open',
      providerNextRetryAt: '2026-03-07T12:01:00.000Z',
      source: 'job-runner'
    });

    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        healthStatus: 'healthy',
        snapshot: expect.objectContaining({
          recoveryActions: 1,
          lastRecoveryEvent: expect.objectContaining({
            action: 'circuit_breaker_reset',
            source: 'job-runner'
          }),
          alerts: ['Provider circuit breaker reset; worker execution can resume.']
        })
      }),
      { source: 'circuit-breaker-reset' }
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'worker.circuit_breaker.reset',
      expect.objectContaining({
        providerFailureCategory: 'circuit_open'
      })
    );
  });

  it('persists dispatcher diagnostics for startup and empty-queue polling', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue-slot-1',
      statsWorkerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    await service.markDispatcherStarted(2);
    service.recordClaimAttempt();
    service.recordClaimResult('no_job_available');
    await service.markIdle();

    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workerId: 'async-queue-slot-1',
        snapshot: expect.objectContaining({
          dispatcherStarted: true,
          activeListeners: 2,
          lastPollAt: expect.any(String),
          lastClaimAttemptAt: expect.any(String),
          lastClaimResult: 'no_job_available',
          disabledReason: null
        })
      }),
      { source: 'worker-idle' }
    );
  });

  it('preserves a zero active-listener dispatcher diagnostic', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue-slot-1',
      statsWorkerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    await service.markDispatcherStarted(0);

    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workerId: 'async-queue-slot-1',
        snapshot: expect.objectContaining({
          dispatcherStarted: true,
          activeListeners: 0
        })
      }),
      { source: 'dispatcher-started' }
    );
  });

  it('marks retry-exhausted transient failures as dead-lettered', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    const result = await service.handleJobFailure(
      {
        id: 'job-dead-letter',
        job_type: 'ask',
        worker_id: 'async-queue',
        status: 'running',
        input: { prompt: 'test' },
        retry_count: 2,
        max_retries: 2,
        created_at: new Date(),
        updated_at: new Date()
      } as any,
      'OpenAI upstream timeout',
      true
    );

    expect(result).toEqual({ action: 'failed' });
    expect(scheduleJobRetryMock).not.toHaveBeenCalled();
    expect(updateJobMock).toHaveBeenCalledWith(
      'job-dead-letter',
      'failed',
      null,
      'OpenAI upstream timeout',
      expect.objectContaining({
        lastFailure: expect.objectContaining({
          retryable: true,
          retryExhausted: true,
          deadLetter: true
        })
      }),
      expect.anything()
    );
  });

  it('recovers idle slot health after a retryable failure is handed off for retry', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

      const service = new WorkerAutonomyService({
        workerId: 'async-queue',
        workerType: 'async_queue',
        heartbeatIntervalMs: 10_000,
        leaseMs: 30_000,
        inspectorIntervalMs: 30_000,
        staleAfterMs: 60_000,
        watchdogIdleMs: 120_000,
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      await service.handleJobFailure(
        {
          id: 'job-retry',
          job_type: 'ask',
          worker_id: 'async-queue',
          status: 'running',
          input: { prompt: 'test' },
          retry_count: 0,
          max_retries: 2,
          created_at: new Date(),
          updated_at: new Date()
        } as any,
        'OpenAI rate limit timeout',
        true
      );

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          healthStatus: 'degraded',
          lastError: 'OpenAI rate limit timeout',
          snapshot: expect.objectContaining({
            alerts: ['Scheduled retry for job job-retry in 2000ms.']
          })
        }),
        { source: 'job-retry' }
      );

      jest.advanceTimersByTime(30_000);
      await service.markIdle();

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(2);
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          healthStatus: 'healthy',
          lastError: null,
          snapshot: expect.objectContaining({
            alerts: [],
            watchdog: expect.objectContaining({
              triggered: false,
              reason: null,
              restartRecommended: false
            })
          })
        }),
        { source: 'worker-idle' }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends a failure webhook immediately for terminal job failures', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 0,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: 'https://example.test/webhook',
      failureWebhookThreshold: 1,
      failureWebhookCooldownMs: 1
    });

    await service.handleJobFailure(
      {
        id: 'job-terminal',
        job_type: 'ask',
        worker_id: 'async-queue',
        status: 'running',
        input: { prompt: 'test' },
        retry_count: 0,
        max_retries: 0,
        created_at: new Date(),
        updated_at: new Date()
      } as any,
      'Unsupported job_type: unsupported-webhook-test',
      false
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      })
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"reason":"job-failure"');
  });

  it('does not resend failure webhooks on scheduled inspections for a historical failed job only', async () => {
    getJobExecutionStatsSinceMock.mockResolvedValue({
      completed: 1,
      failed: 1,
      running: 0,
      totalTerminal: 2,
      aiCalls: 1
    });

    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: 'https://example.test/webhook',
      failureWebhookThreshold: 1,
      failureWebhookCooldownMs: 1
    });

    await service.inspect('scheduled');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers idle slot health after a terminal failure when the queue is idle', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

      const service = new WorkerAutonomyService({
        workerId: 'async-queue',
        workerType: 'async_queue',
        heartbeatIntervalMs: 10_000,
        leaseMs: 30_000,
        inspectorIntervalMs: 30_000,
        staleAfterMs: 60_000,
        watchdogIdleMs: 120_000,
        defaultMaxRetries: 0,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      await service.handleJobFailure(
        {
          id: 'job-terminal',
          job_type: 'ask',
          worker_id: 'async-queue',
          status: 'running',
          input: { prompt: 'test' },
          retry_count: 0,
          max_retries: 0,
          created_at: new Date(),
          updated_at: new Date()
        } as any,
        'OpenAI upstream timeout',
        false
      );

      jest.advanceTimersByTime(30_000);
      await service.markIdle();

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          healthStatus: 'healthy',
          lastError: 'OpenAI upstream timeout',
          snapshot: expect.objectContaining({
            alerts: [],
            watchdog: expect.objectContaining({
              triggered: false,
              restartRecommended: false
            })
          })
        }),
        { source: 'worker-idle' }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('still alerts on scheduled inspections when stale jobs are recovered', async () => {
    getJobExecutionStatsSinceMock.mockResolvedValue({
      completed: 0,
      failed: 0,
      running: 0,
      totalTerminal: 0,
      aiCalls: 0
    });
    recoverStaleJobsMock.mockResolvedValue({
      recoveredJobs: ['job-stale-1'],
      failedJobs: []
    });

    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: 'https://example.test/webhook',
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 1
    });

    await service.inspect('scheduled');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"reason":"scheduled"');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('Recovered 1 stale job');
  });

  it('caps recovered job ids persisted in recovery events', async () => {
    const recoveredJobIds = Array.from({ length: 25 }, (_, index) => `job-stale-${index + 1}`);
    recoverStaleJobsMock.mockResolvedValue({
      recoveredJobs: recoveredJobIds,
      failedJobs: []
    });

    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 1
    });

    await service.inspect('scheduled');

    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          lastRecoveryEvent: expect.objectContaining({
            jobIds: recoveredJobIds.slice(0, 20),
            jobIdsTotal: 25,
            jobIdsTruncated: true,
            workerIds: [],
            workerIdsTotal: 0,
            workerIdsTruncated: false
          })
        })
      }),
      { source: 'inspector' }
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'worker.recovery.action',
      expect.objectContaining({
        jobIds: recoveredJobIds.slice(0, 20),
        jobIdsTotal: 25,
        jobIdsTruncated: true
      })
    );
  });

  it('treats missing stale recovery result arrays as empty', async () => {
    recoverStaleJobsMock.mockResolvedValue({} as any);

    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 1
    });

    await expect(service.inspect('scheduled')).resolves.toBeDefined();
    expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          recoveredJobs: 0,
          deadLetterJobs: 0,
          cancelledJobs: 0,
          recoveryActions: 0
        })
      }),
      { source: 'inspector' }
    );
  });

  it('uses the shared stats worker id for slot-level budget evaluation', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue-slot-2',
      statsWorkerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    await service.evaluateBudgetsBeforeClaim();

    expect(getJobExecutionStatsSinceMock).toHaveBeenCalledWith(
      expect.any(Date),
      'async-queue'
    );
  });

  it('throttles healthy snapshot writes but preserves forced state transitions', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      recordJobHeartbeatMock.mockResolvedValue({
        id: 'job-1',
        status: 'running'
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue',
        workerType: 'async_queue',
        heartbeatIntervalMs: 10_000,
        leaseMs: 30_000,
        inspectorIntervalMs: 30_000,
        staleAfterMs: 60_000,
        watchdogIdleMs: 120_000,
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      await service.recordHeartbeat('job-1');
      await service.recordHeartbeat('job-1');
      await service.markIdle();

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(2);

      await service.markJobStarted({
        id: 'job-1',
        job_type: 'gpt',
        worker_id: 'async-queue',
        status: 'running',
        input: {},
        created_at: new Date('2026-03-07T11:59:00.000Z'),
        updated_at: new Date('2026-03-07T12:00:00.000Z')
      } as any);

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(3);

      jest.advanceTimersByTime(30_000);
      await service.markIdle();

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('requeues stalled jobs assigned to stale workers during the watchdog cycle', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-2',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: 'job-stalled',
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:45.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:45.000Z',
          snapshot: {
            activeJobs: ['job-stalled'],
            lastActivityAt: '2026-03-07T11:59:45.000Z'
          }
        }
      ]);
      recoverStalledJobsForWorkersMock.mockResolvedValue({
        staleWorkerIds: ['async-queue-slot-2'],
        stalledJobIds: ['job-stalled'],
        requeuedJobIds: ['job-stalled'],
        deadLetterJobIds: [],
        cancelledJobIds: []
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(recoverStalledJobsForWorkersMock).toHaveBeenCalledWith({
        workerIds: ['async-queue-slot-2'],
        staleAfterMs: 10_000,
        maxRetries: 2,
        stalledJobAction: 'requeue'
      });
      expect(result).toEqual({
        staleWorkers: 1,
        stalledJobs: 1,
        requeuedJobs: 1,
        deadLetterJobs: 0,
        cancelledJobs: 0
      });
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces stale worker restart recommendations even when no stalled job rows are recovered', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-stale',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: 'job-already-reclaimed',
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:45.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:45.000Z',
          snapshot: {
            activeJobs: ['job-already-reclaimed'],
            lastActivityAt: '2026-03-07T11:59:45.000Z'
          }
        }
      ]);
      recoverStalledJobsForWorkersMock.mockResolvedValueOnce({
        staleWorkerIds: [],
        stalledJobIds: [],
        requeuedJobIds: [],
        deadLetterJobIds: [],
        cancelledJobIds: []
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(result).toEqual({
        staleWorkers: 1,
        stalledJobs: 0,
        requeuedJobs: 0,
        deadLetterJobs: 0,
        cancelledJobs: 0
      });
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            staleWorkersDetected: 1,
            recoveryActions: 0,
            lastRecoveryEvent: null,
            lastWatchdogEvent: expect.objectContaining({
              reason: 'stale worker restart recommended',
              staleWorkerIds: ['async-queue-slot-stale'],
              restartRecommended: true
            })
          })
        }),
        { source: 'watchdog' }
      );
      expect(loggerWarnMock).toHaveBeenCalledWith(
        'worker.watchdog.triggered',
        expect.objectContaining({
          staleWorkerIds: ['async-queue-slot-stale'],
          restartRecommended: true
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('caps watchdog event id arrays in snapshots and logs', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      const staleWorkerIds = Array.from({ length: 25 }, (_, index) => `async-queue-slot-${index + 1}`);
      const stalledJobIds = Array.from({ length: 25 }, (_, index) => `job-stalled-${index + 1}`);
      listWorkerRuntimeSnapshotsMock.mockResolvedValue(
        staleWorkerIds.map((workerId, index) => ({
          workerId,
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: stalledJobIds[index],
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:45.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:45.000Z',
          snapshot: {
            activeJobs: [stalledJobIds[index]],
            lastActivityAt: '2026-03-07T11:59:45.000Z'
          }
        }))
      );
      recoverStalledJobsForWorkersMock.mockResolvedValue({
        staleWorkerIds,
        stalledJobIds,
        requeuedJobIds: stalledJobIds,
        deadLetterJobIds: [],
        cancelledJobIds: []
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      await service.runWatchdogCycle('watchdog');

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            lastWatchdogEvent: expect.objectContaining({
              staleWorkerIds: staleWorkerIds.slice(0, 20),
              staleWorkerIdsTotal: 25,
              staleWorkerIdsTruncated: true,
              stalledJobIds: stalledJobIds.slice(0, 20),
              stalledJobIdsTotal: 25,
              stalledJobIdsTruncated: true,
              requeuedJobIds: stalledJobIds.slice(0, 20),
              requeuedJobIdsTotal: 25,
              requeuedJobIdsTruncated: true
            })
          })
        }),
        { source: 'watchdog' }
      );
      expect(loggerWarnMock).toHaveBeenCalledWith(
        'worker.watchdog.triggered',
        expect.objectContaining({
          staleWorkerIds: staleWorkerIds.slice(0, 20),
          staleWorkerIdsTotal: 25,
          staleWorkerIdsTruncated: true,
          stalledJobIds: stalledJobIds.slice(0, 20),
          stalledJobIdsTotal: 25,
          stalledJobIdsTruncated: true,
          requeuedJobIds: stalledJobIds.slice(0, 20),
          requeuedJobIdsTotal: 25,
          requeuedJobIdsTruncated: true
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses fresh liveness records to avoid false stale-worker recovery in V2', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-2',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: 'job-running',
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:00.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:00.000Z',
          snapshot: {
            activeJobs: ['job-running'],
            lastActivityAt: '2026-03-07T11:59:00.000Z'
          }
        }
      ]);
      listWorkerLivenessMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-2',
          healthStatus: 'healthy',
          lastSeenAt: '2026-03-07T11:59:55.000Z'
        }
      ]);

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(recoverStalledJobsForWorkersMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        staleWorkers: 0,
        stalledJobs: 0,
        requeuedJobs: 0,
        deadLetterJobs: 0,
        cancelledJobs: 0
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses V2 runtime state during watchdog recovery when legacy preservation is disabled', async () => {
    jest.useFakeTimers();

    try {
      process.env.WORKER_SNAPSHOT_PIPELINE_V2 = 'true';
      process.env.WORKER_SNAPSHOT_PRESERVE_LEGACY_TABLE = 'false';
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeStateSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-2',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: 'job-running',
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:00.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:00.000Z',
          snapshot: {
            activeJobs: ['job-running'],
            lastActivityAt: '2026-03-07T11:59:00.000Z'
          }
        }
      ]);
      listWorkerLivenessMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-2',
          healthStatus: 'healthy',
          lastSeenAt: '2026-03-07T11:59:55.000Z'
        }
      ]);

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(listWorkerRuntimeStateSnapshotsMock).toHaveBeenCalledTimes(1);
      expect(listWorkerRuntimeSnapshotsMock).not.toHaveBeenCalled();
      expect(recoverStalledJobsForWorkersMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        staleWorkers: 0,
        stalledJobs: 0,
        requeuedJobs: 0,
        deadLetterJobs: 0,
        cancelledJobs: 0
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports stale workers for restart recommendation even when no job row is reclaimed', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      getJobQueueSummaryMock.mockResolvedValue({
        pending: 0,
        running: 1,
        completed: 0,
        failed: 0,
        total: 1,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        lastUpdatedAt: '2026-03-07T12:00:00.000Z'
      });
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-stale',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: null,
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:58:00.000Z',
          lastInspectorRunAt: '2026-03-07T11:58:00.000Z',
          updatedAt: '2026-03-07T11:58:00.000Z',
          snapshot: {
            activeJobs: [],
            lastActivityAt: '2026-03-07T11:58:00.000Z'
          }
        }
      ]);
      recoverStalledJobsForWorkersMock.mockResolvedValue({
        staleWorkerIds: [],
        stalledJobIds: [],
        requeuedJobIds: [],
        deadLetterJobIds: [],
        cancelledJobIds: []
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(recoverStalledJobsForWorkersMock).toHaveBeenCalledWith({
        workerIds: ['async-queue-slot-stale'],
        staleAfterMs: 10_000,
        maxRetries: 2,
        stalledJobAction: 'requeue'
      });
      expect(result).toEqual({
        staleWorkers: 1,
        stalledJobs: 0,
        requeuedJobs: 0,
        deadLetterJobs: 0,
        cancelledJobs: 0
      });
      expect(loggerWarnMock).toHaveBeenCalledWith(
        'worker.watchdog.stale_worker_detected',
        expect.objectContaining({
          module: 'worker-autonomy',
          workerId: 'async-queue-slot-1',
          staleWorkers: 1,
          stalledJobs: 0,
          recoveryActions: 0,
          restartRecommended: true
        })
      );
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledWith(
        expect.objectContaining({
          healthStatus: 'degraded',
          snapshot: expect.objectContaining({
            staleWorkersDetected: 1,
            recoveryActions: 0,
            alerts: ['Detected 1 stale worker(s); restart recommended.']
          })
        }),
        { source: 'watchdog' }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not recover stale idle workers when the queue has no running work', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-idle',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: null,
          lastError: null,
          startedAt: '2026-03-07T11:00:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:55:00.000Z',
          lastInspectorRunAt: null,
          updatedAt: '2026-03-07T11:55:00.000Z',
          snapshot: {
            activeJobs: [],
            lastActivityAt: '2026-03-07T11:55:00.000Z'
          }
        }
      ]);

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(recoverStalledJobsForWorkersMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        staleWorkers: 0,
        stalledJobs: 0,
        requeuedJobs: 0,
        deadLetterJobs: 0,
        cancelledJobs: 0
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('dead-letters stalled jobs when watchdog recovery is configured to stop retrying', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-3',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: 'job-dead-letter',
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:45.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:45.000Z',
          snapshot: {
            activeJobs: ['job-dead-letter'],
            lastActivityAt: '2026-03-07T11:59:45.000Z'
          }
        }
      ]);
      recoverStalledJobsForWorkersMock.mockResolvedValue({
        staleWorkerIds: ['async-queue-slot-3'],
        stalledJobIds: ['job-dead-letter'],
        requeuedJobIds: [],
        deadLetterJobIds: ['job-dead-letter'],
        cancelledJobIds: []
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'dead_letter',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(recoverStalledJobsForWorkersMock).toHaveBeenCalledWith({
        workerIds: ['async-queue-slot-3'],
        staleAfterMs: 10_000,
        maxRetries: 2,
        stalledJobAction: 'dead_letter'
      });
      expect(result).toEqual({
        staleWorkers: 1,
        stalledJobs: 1,
        requeuedJobs: 0,
        deadLetterJobs: 1,
        cancelledJobs: 0
      });
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts cancelled stalled jobs in watchdog snapshots', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      listWorkerRuntimeSnapshotsMock.mockResolvedValue([
        {
          workerId: 'async-queue-slot-4',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          currentJobId: 'job-cancelled-stalled',
          lastError: null,
          startedAt: '2026-03-07T11:55:00.000Z',
          lastHeartbeatAt: '2026-03-07T11:59:45.000Z',
          lastInspectorRunAt: '2026-03-07T11:59:45.000Z',
          updatedAt: '2026-03-07T11:59:45.000Z',
          snapshot: {
            activeJobs: ['job-cancelled-stalled'],
            lastActivityAt: '2026-03-07T11:59:45.000Z'
          }
        }
      ]);
      recoverStalledJobsForWorkersMock.mockResolvedValue({
        staleWorkerIds: ['async-queue-slot-4'],
        stalledJobIds: ['job-cancelled-stalled'],
        requeuedJobIds: [],
        deadLetterJobIds: [],
        cancelledJobIds: ['job-cancelled-stalled']
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue-slot-1',
        workerType: 'async_queue',
        heartbeatIntervalMs: 5_000,
        leaseMs: 15_000,
        inspectorIntervalMs: 30_000,
        watchdogIntervalMs: 5_000,
        staleAfterMs: 10_000,
        watchdogIdleMs: 120_000,
        stalledJobAction: 'requeue',
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      const result = await service.runWatchdogCycle('watchdog');

      expect(result).toEqual({
        staleWorkers: 1,
        stalledJobs: 1,
        requeuedJobs: 0,
        deadLetterJobs: 0,
        cancelledJobs: 1
      });
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            cancelledJobs: 1,
            recoveryActions: 1,
            alerts: expect.arrayContaining(['Cancelled 1 stalled job(s) during recovery.'])
          })
        }),
        { source: 'watchdog' }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not force idle watchdog-only snapshots when no work is pending', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

      const service = new WorkerAutonomyService({
        workerId: 'async-queue',
        workerType: 'async_queue',
        heartbeatIntervalMs: 10_000,
        leaseMs: 30_000,
        inspectorIntervalMs: 30_000,
        staleAfterMs: 60_000,
        watchdogIdleMs: 120_000,
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      jest.advanceTimersByTime(121_000);
      await service.markIdle();
      await service.markIdle();

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          healthStatus: 'healthy',
          snapshot: expect.objectContaining({
            alerts: [],
            watchdog: expect.objectContaining({
              triggered: false,
              reason: null,
              restartRecommended: false
            })
          })
        }),
        { source: 'worker-idle' }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('backs off idle worker heartbeats while keeping active job heartbeats frequent', async () => {
    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 5_000,
      leaseMs: 15_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 10_000,
      watchdogIdleMs: 120_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    expect(service.getRecommendedWorkerHeartbeatDelayMs()).toBe(8_000);

    await service.markJobStarted({
      id: 'job-active',
      job_type: 'ask',
      worker_id: 'async-queue',
      status: 'running',
      input: { prompt: 'test' },
      retry_count: 0,
      max_retries: 2,
      created_at: new Date(),
      updated_at: new Date()
    } as any);

    expect(service.getRecommendedWorkerHeartbeatDelayMs()).toBe(5_000);
  });

  it('marks blocked queue work as degraded when inactivity exceeds the watchdog threshold', async () => {
    jest.useFakeTimers();

    try {
      jest.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
      getJobQueueSummaryMock.mockResolvedValue({
        pending: 1,
        running: 0,
        completed: 0,
        failed: 0,
        total: 1,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 60_000,
        lastUpdatedAt: '2026-03-07T12:00:00.000Z'
      });

      const service = new WorkerAutonomyService({
        workerId: 'async-queue',
        workerType: 'async_queue',
        heartbeatIntervalMs: 10_000,
        leaseMs: 30_000,
        inspectorIntervalMs: 30_000,
        staleAfterMs: 60_000,
        watchdogIdleMs: 120_000,
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 60_000,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2_048,
        queueDepthDeferralThreshold: 25,
        queueDepthDeferralMs: 5_000,
        failureWebhookUrl: null,
        failureWebhookThreshold: 3,
        failureWebhookCooldownMs: 300_000
      });

      jest.advanceTimersByTime(121_000);
      await service.markIdle();

      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenCalledTimes(1);
      expect(upsertWorkerRuntimeSnapshotMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          healthStatus: 'degraded',
          snapshot: expect.objectContaining({
            alerts: [expect.stringContaining('queue work remained pending')],
            watchdog: expect.objectContaining({
              triggered: true,
              reason: expect.stringContaining('queue work remained pending'),
              restartRecommended: true
            })
          })
        }),
        { source: 'worker-idle' }
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs snapshot persistence failures with structured context', async () => {
    upsertWorkerRuntimeSnapshotMock.mockRejectedValueOnce(new Error('database write timeout'));

    const service = new WorkerAutonomyService({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 60_000,
      watchdogIdleMs: 120_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    await service.inspect('scheduled', [], { source: 'inspector' });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.runtime_snapshot.persist.failed',
      expect.objectContaining({
        module: 'worker-autonomy',
        workerId: 'async-queue',
        source: 'inspector',
        healthStatus: 'healthy',
        durationMs: expect.any(Number),
        error: 'database write timeout'
      })
    );
  });

  it('routes worker heartbeat through V2 liveness by default when the env flag is unset', async () => {
    delete process.env.WORKER_SNAPSHOT_PIPELINE_V2;

    const service = new WorkerAutonomyService({
      workerId: 'async-queue-slot-1',
      workerType: 'async_queue',
      heartbeatIntervalMs: 30_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 90_000,
      watchdogIdleMs: 120_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    });

    await service.recordWorkerHeartbeat({ source: 'worker-heartbeat' });

    expect(recordWorkerLivenessMock).toHaveBeenCalledWith({
      workerId: 'async-queue-slot-1',
      healthStatus: 'healthy',
      lastSeenAt: expect.any(String)
    });
    expect(upsertWorkerRuntimeSnapshotMock).not.toHaveBeenCalled();

    await service.flushSnapshotPipeline('test-cleanup');
  });

  it('routes worker heartbeat through V2 liveness without forcing rich snapshot persistence', async () => {
    const snapshotPipeline = {
      recordLiveness: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      recordSnapshotIntent: jest.fn(),
      flushWorker: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    };
    const service = new WorkerAutonomyService({
      workerId: 'async-queue-slot-1',
      workerType: 'async_queue',
      heartbeatIntervalMs: 30_000,
      leaseMs: 30_000,
      inspectorIntervalMs: 30_000,
      staleAfterMs: 90_000,
      watchdogIdleMs: 120_000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2_048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5_000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300_000
    }, snapshotPipeline);

    await service.recordWorkerHeartbeat({ source: 'worker-heartbeat' });

    expect(snapshotPipeline.recordLiveness).toHaveBeenCalledWith(
      'async-queue-slot-1',
      'healthy',
      expect.any(String)
    );
    expect(snapshotPipeline.recordSnapshotIntent).toHaveBeenCalledWith(
      'async-queue-slot-1',
      'worker-heartbeat',
      expect.objectContaining({
        workerId: 'async-queue-slot-1',
        healthStatus: 'healthy'
      })
    );
    expect(snapshotPipeline.flushWorker).not.toHaveBeenCalled();
    expect(upsertWorkerRuntimeSnapshotMock).not.toHaveBeenCalled();
  });
});
