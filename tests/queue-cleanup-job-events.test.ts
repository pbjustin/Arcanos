import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const cleanupRetainedFailedJobsMock = jest.fn();
const cleanupJobEventsMock = jest.fn();
const recordJobEventCleanupMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  cleanupRetainedFailedJobs: cleanupRetainedFailedJobsMock,
  DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS: 86_400_000,
  DEFAULT_FAILED_JOB_RETENTION_COUNT: 50,
  MAX_FAILED_JOB_CLEANUP_MIN_AGE_MS: 30 * 24 * 60 * 60 * 1_000,
  MAX_FAILED_JOB_RETENTION_COUNT: 1_000
}));

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  cleanupJobEvents: cleanupJobEventsMock,
  DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE: 1_000,
  DEFAULT_JOB_EVENT_RETENTION_DAYS: 30,
  MAX_JOB_EVENT_CLEANUP_BATCH_SIZE: 10_000,
  MAX_JOB_EVENT_RETENTION_DAYS: 365
}));

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordJobEventCleanup: recordJobEventCleanupMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock
  }
}));

const {
  resolveJobEventCleanupPolicy,
  runJobEventCleanup
} = await import('../src/queue/cleanup.js');

describe('queue job event cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cleanupJobEventsMock.mockResolvedValue({
      databaseAvailable: true,
      failed: false,
      dryRun: true,
      retentionDays: 30,
      batchSize: 1_000,
      cutoffBefore: '2026-04-07T12:00:00.000Z',
      matchedRows: 2,
      deletedRows: 0,
      eventIds: ['event-1', 'event-2']
    });
  });

  it('resolves bounded retention policy from environment', () => {
    expect(resolveJobEventCleanupPolicy({
      JOB_EVENT_CLEANUP_ENABLED: 'true',
      JOB_EVENT_CLEANUP_DRY_RUN: 'false',
      JOB_EVENT_RETENTION_DAYS: '999',
      JOB_EVENT_CLEANUP_BATCH_SIZE: '99999'
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      dryRun: false,
      retentionDays: 365,
      batchSize: 10_000
    });
  });

  it('runs cleanup in dry-run mode and records metrics', async () => {
    const result = await runJobEventCleanup('test');

    expect(result).toEqual(expect.objectContaining({
      enabled: true,
      skipped: false,
      failed: false,
      dryRun: true,
      matchedRows: 2,
      deletedRows: 0
    }));
    expect(cleanupJobEventsMock).toHaveBeenCalledWith({
      dryRun: true,
      retentionDays: 30,
      batchSize: 1_000
    });
    expect(recordJobEventCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'completed',
      dryRun: true,
      matchedRows: 2,
      deletedRows: 0
    }));
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'queue.job_events.cleanup.completed',
      expect.objectContaining({
        deletedEventIdSample: ['event-1', 'event-2']
      })
    );
  });

  it('does not throw when cleanup fails', async () => {
    cleanupJobEventsMock.mockRejectedValueOnce(new Error('unexpected cleanup failure'));

    await expect(runJobEventCleanup('test')).resolves.toEqual(expect.objectContaining({
      enabled: true,
      skipped: false,
      failed: true,
      matchedRows: 0,
      deletedRows: 0
    }));
    expect(recordJobEventCleanupMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      dryRun: true
    }));
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'queue.job_events.cleanup.failed',
      expect.not.objectContaining({
        errorMessage: expect.any(String)
      })
    );
  });
});
