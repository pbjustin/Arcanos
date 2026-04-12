import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobByIdMock = jest.fn();
const getLatestJobMock = jest.fn();
const listFailedJobsMock = jest.fn();
const requeueFailedJobMock = jest.fn();

const getWorkerAutonomyHealthReportMock = jest.fn();
const getWorkerAutonomySettingsMock = jest.fn(() => ({
  defaultMaxRetries: 2,
  retryBackoffBaseMs: 2000,
  retryBackoffMaxMs: 60000,
  staleAfterMs: 60000,
  watchdogIdleMs: 120000
}));

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: jest.fn(),
  getJobById: getJobByIdMock,
  getJobQueueSummary: jest.fn(),
  getLatestJob: getLatestJobMock,
  listFailedJobs: listFailedJobsMock,
  requeueFailedJob: requeueFailedJobMock
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  dispatchArcanosTask: jest.fn(),
  getWorkerRuntimeStatus: jest.fn(),
  startWorkers: jest.fn()
}));

jest.unstable_mockModule('@dispatcher/detectCognitiveDomain.js', () => ({
  detectCognitiveDomain: jest.fn(() => ({ domain: 'code', confidence: 0.9 }))
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getStatus: jest.fn(() => ({
    connected: true,
    hasPool: true,
    error: null
  }))
}));

jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  recordSelfHealEvent: jest.fn()
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  getWorkerAutonomyHealthReport: getWorkerAutonomyHealthReportMock,
  getWorkerAutonomySettings: getWorkerAutonomySettingsMock,
  planAutonomousWorkerJob: jest.fn()
}));

const {
  getWorkerControlHealth,
  requeueFailedWorkerJob
} = await import('../src/services/workerControlService.js');

describe('workerControlService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getLatestJobMock.mockResolvedValue(null);
    listFailedJobsMock.mockResolvedValue([
      {
        id: 'job-failed-1',
        worker_id: 'worker-helper',
        last_worker_id: 'async-queue-slot-1',
        job_type: 'ask',
        status: 'failed',
        error_message: 'OpenAI upstream timeout',
        retry_count: 2,
        max_retries: 2,
        created_at: '2026-04-01T09:55:00.000Z',
        updated_at: '2026-04-01T09:58:00.000Z',
        completed_at: '2026-04-01T09:58:00.000Z'
      }
    ]);
  });

  it('reports healthy operational status while preserving historical failure debt', async () => {
    getWorkerAutonomyHealthReportMock.mockResolvedValue({
      timestamp: '2026-04-11T22:29:00.637Z',
      overallStatus: 'degraded',
      alerts: [
        'Worker bootstrap completed with 4 consumer slot(s).',
        'Retry exhaustion is elevated (56 terminal failure(s)).'
      ],
      queueSummary: {
        pending: 0,
        running: 0,
        completed: 290,
        failed: 145,
        total: 435,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        failureBreakdown: {
          retryable: 0,
          permanent: 145,
          retryScheduled: 0,
          retryExhausted: 56,
          authentication: 0,
          network: 0,
          provider: 0,
          rateLimited: 0,
          timeout: 145,
          validation: 0,
          unknown: 0
        },
        recentFailureReasons: [
          {
            reason: 'OpenAI upstream timeout',
            category: 'timeout',
            retryable: false,
            count: 12,
            lastSeenAt: '2026-04-05T15:10:00.000Z'
          }
        ],
        recentTerminalWindowMs: 3600000,
        recentCompleted: 2,
        recentFailed: 0,
        recentTotalTerminal: 2,
        lastUpdatedAt: '2026-04-11T22:29:00.000Z'
      },
      workers: [
        {
          workerId: 'async-queue-slot-1',
          workerType: 'async_queue',
          healthStatus: 'degraded',
          currentJobId: null,
          lastError: 'OpenAI upstream timeout',
          startedAt: '2026-04-11T22:00:00.000Z',
          lastHeartbeatAt: '2026-04-11T21:45:00.000Z',
          lastInspectorRunAt: '2026-04-11T22:29:00.000Z',
          updatedAt: '2026-04-11T22:29:00.000Z',
          snapshot: {
            lastActivityAt: '2026-04-11T21:45:00.000Z',
            lastProcessedJobAt: '2026-04-11T21:45:00.000Z',
            watchdog: {
              triggered: false,
              reason: 'No worker receipts or processed jobs observed for 2640000ms.',
              inactivityMs: 2640000,
              lastActivityAt: '2026-04-11T21:45:00.000Z',
              lastProcessedJobAt: '2026-04-11T21:45:00.000Z',
              idleThresholdMs: 120000,
              restartRecommended: true
            }
          }
        }
      ],
      settings: {
        heartbeatIntervalMs: 10000,
        leaseMs: 30000,
        inspectorIntervalMs: 30000,
        staleAfterMs: 60000,
        watchdogIdleMs: 120000,
        defaultMaxRetries: 2,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2048
      }
    });

    const health = await getWorkerControlHealth();

    expect(health.overallStatus).toBe('healthy');
    expect(health.alerts).toEqual([]);
    expect(health.diagnosticAlerts).toEqual([
      'Worker bootstrap completed with 4 consumer slot(s).',
      'Retry exhaustion is elevated (56 terminal failure(s)).'
    ]);
    expect(health.operationalHealth).toEqual(expect.objectContaining({
      overallStatus: 'healthy',
      recentFailed: 0,
      stalledRunning: 0
    }));
    expect(health.historicalDebt).toEqual({
      retainedFailedJobs: 145,
      retryExhaustedJobs: 56,
      deadLetterJobs: 0,
      recentFailureReasons: [
        {
          reason: 'OpenAI upstream timeout',
          category: 'timeout',
          retryable: false,
          count: 12,
          lastSeenAt: '2026-04-05T15:10:00.000Z'
        }
      ],
      failureWindowMs: 3600000,
      inspectionEndpoint: '/worker-helper/jobs/failed',
      currentRiskExcluded: true
    });
    expect(health.workers).toEqual([
      expect.objectContaining({
        workerId: 'async-queue-slot-1',
        healthStatus: 'degraded',
        operationalStatus: 'healthy'
      })
    ]);
  });

  it('requeues retained failed jobs through the operator helper', async () => {
    getJobByIdMock.mockResolvedValueOnce({
      id: 'job-failed-1',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'failed',
      input: { prompt: 'test' },
      output: null,
      error_message: 'OpenAI upstream timeout',
      retry_count: 2,
      max_retries: 2,
      next_run_at: '2026-04-01T09:58:00.000Z',
      created_at: '2026-04-01T09:55:00.000Z',
      updated_at: '2026-04-01T09:58:00.000Z',
      completed_at: '2026-04-01T09:58:00.000Z'
    });
    requeueFailedJobMock.mockResolvedValue({
      id: 'job-failed-1',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'pending',
      input: { prompt: 'test' },
      output: null,
      error_message: null,
      retry_count: 0,
      max_retries: 2,
      next_run_at: '2026-04-11T22:45:00.000Z',
      created_at: '2026-04-01T09:55:00.000Z',
      updated_at: '2026-04-11T22:45:00.000Z',
      completed_at: null
    });

    const result = await requeueFailedWorkerJob('job-failed-1', {
      requestedBy: 'test-suite'
    });

    expect(requeueFailedJobMock).toHaveBeenCalledWith('job-failed-1', {
      requestedBy: 'test-suite'
    });
    expect(result).toEqual({
      outcome: 'requeued',
      job: expect.objectContaining({
        id: 'job-failed-1',
        status: 'pending',
        error_message: null
      })
    });
  });
});
