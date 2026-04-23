import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobQueueSummaryMock = jest.fn();
const getJobExecutionStatsSinceMock = jest.fn();
const recordJobHeartbeatMock = jest.fn();
const recoverStalledJobsForWorkersMock = jest.fn();
const recoverStaleJobsMock = jest.fn();
const scheduleJobRetryMock = jest.fn();
const updateJobMock = jest.fn();
const cleanupExpiredGptJobsMock = jest.fn();
const listWorkerRuntimeSnapshotsMock = jest.fn();
const upsertWorkerRuntimeSnapshotMock = jest.fn();
const fetchMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  getJobQueueSummary: getJobQueueSummaryMock,
  getJobExecutionStatsSince: getJobExecutionStatsSinceMock,
  recordJobHeartbeat: recordJobHeartbeatMock,
  recoverStalledJobsForWorkers: recoverStalledJobsForWorkersMock,
  recoverStaleJobs: recoverStaleJobsMock,
  scheduleJobRetry: scheduleJobRetryMock,
  updateJob: updateJobMock,
  cleanupExpiredGptJobs: cleanupExpiredGptJobsMock
}));

jest.unstable_mockModule('@core/db/repositories/workerRuntimeRepository.js', () => ({
  listWorkerRuntimeSnapshots: listWorkerRuntimeSnapshotsMock,
  upsertWorkerRuntimeSnapshot: upsertWorkerRuntimeSnapshotMock
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
  planAutonomousWorkerJob
} = await import('../src/services/workerAutonomyService.js');

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
    scheduleJobRetryMock.mockResolvedValue({
      id: 'job-1'
    });
    updateJobMock.mockResolvedValue({
      id: 'job-1'
    });
    listWorkerRuntimeSnapshotsMock.mockResolvedValue([]);
    upsertWorkerRuntimeSnapshotMock.mockResolvedValue(undefined);
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
    expect(updateJobMock).not.toHaveBeenCalled();
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
        })
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
        })
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
        })
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
        })
      );
    } finally {
      jest.useRealTimers();
    }
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
        })
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
});
