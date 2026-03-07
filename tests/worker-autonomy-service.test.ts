import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobQueueSummaryMock = jest.fn();
const getJobExecutionStatsSinceMock = jest.fn();
const recordJobHeartbeatMock = jest.fn();
const recoverStaleJobsMock = jest.fn();
const scheduleJobRetryMock = jest.fn();
const updateJobMock = jest.fn();
const listWorkerRuntimeSnapshotsMock = jest.fn();
const upsertWorkerRuntimeSnapshotMock = jest.fn();
const fetchMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  getJobQueueSummary: getJobQueueSummaryMock,
  getJobExecutionStatsSince: getJobExecutionStatsSinceMock,
  recordJobHeartbeat: recordJobHeartbeatMock,
  recoverStaleJobs: recoverStaleJobsMock,
  scheduleJobRetry: scheduleJobRetryMock,
  updateJob: updateJobMock
}));

jest.unstable_mockModule('@core/db/repositories/workerRuntimeRepository.js', () => ({
  listWorkerRuntimeSnapshots: listWorkerRuntimeSnapshotsMock,
  upsertWorkerRuntimeSnapshot: upsertWorkerRuntimeSnapshotMock
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
    recoverStaleJobsMock.mockResolvedValue({
      recoveredJobs: [],
      failedJobs: []
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
    expect(classifyWorkerExecutionError(new Error('Invalid job.input: schema mismatch')).retryable).toBe(false);
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
});
