import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const cleanupRetainedFailedJobsMock = jest.fn();
const cleanupRetainedNonGptTerminalJobsMock = jest.fn();
const inspectLegacyNullNonGptTerminalJobsMock = jest.fn();
const cleanupJobEventsMock = jest.fn();
const recordJobEventCleanupMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  cleanupRetainedFailedJobs: cleanupRetainedFailedJobsMock,
  cleanupRetainedNonGptTerminalJobs: cleanupRetainedNonGptTerminalJobsMock,
  inspectLegacyNullNonGptTerminalJobs: inspectLegacyNullNonGptTerminalJobsMock,
  DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS: 86_400_000,
  DEFAULT_FAILED_JOB_RETENTION_COUNT: 50,
  DEFAULT_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE: 100,
  MAX_FAILED_JOB_CLEANUP_MIN_AGE_MS: 30 * 24 * 60 * 60 * 1_000,
  MAX_FAILED_JOB_RETENTION_COUNT: 1_000,
  MAX_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE: 1_000
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
  resolveNonGptTerminalCleanupPolicy,
  resolveJobEventCleanupPolicy,
  runNonGptTerminalCleanup,
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
    cleanupRetainedNonGptTerminalJobsMock.mockResolvedValue({
      batchSize: 100,
      deletedTerminal: 2,
      deletedAsk: 1,
      deletedDagNode: 1,
      deletedBackstageNotionPartitionSync: 0,
      deletedCompleted: 1,
      deletedCancelled: 1,
      deletedJobIds: ['ask-old', 'dag-old']
    });
    inspectLegacyNullNonGptTerminalJobsMock.mockResolvedValue({
      sampleLimit: 100,
      observedTerminal: 3,
      observedAsk: 2,
      observedDagNode: 1,
      observedCompleted: 2,
      observedCancelled: 1,
      sampleLimitReached: false
    });
  });

  it('resolves a bounded non-GPT terminal cleanup policy', () => {
    expect(resolveNonGptTerminalCleanupPolicy({
      QUEUE_NON_GPT_TERMINAL_CLEANUP_ENABLED: 'false',
      QUEUE_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE: '99999'
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: false,
      batchSize: 1_000
    });

    expect(resolveNonGptTerminalCleanupPolicy({
      QUEUE_NON_GPT_TERMINAL_CLEANUP_ENABLED: 'maybe',
      QUEUE_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE: 'invalid'
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      batchSize: 100
    });
  });

  it('skips non-GPT terminal cleanup without a repository call when disabled', async () => {
    await expect(runNonGptTerminalCleanup('test', {
      enabled: false,
      batchSize: 20
    })).resolves.toEqual(expect.objectContaining({
      enabled: false,
      skipped: true,
      deletedTerminal: 0
    }));
    expect(cleanupRetainedNonGptTerminalJobsMock).not.toHaveBeenCalled();
    expect(inspectLegacyNullNonGptTerminalJobsMock).not.toHaveBeenCalled();
  });

  it('runs one bounded non-GPT terminal cleanup and logs aggregate counts only', async () => {
    await expect(runNonGptTerminalCleanup('test')).resolves.toEqual(
      expect.objectContaining({
        enabled: true,
        skipped: false,
        deletedTerminal: 2,
        deletedAsk: 1,
        deletedDagNode: 1,
        deletedBackstageNotionPartitionSync: 0
      })
    );
    expect(cleanupRetainedNonGptTerminalJobsMock).toHaveBeenCalledWith({
      batchSize: 100
    });
    expect(inspectLegacyNullNonGptTerminalJobsMock).toHaveBeenCalledWith({
      sampleLimit: 100
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'queue.non_gpt_terminal.cleanup.completed',
      expect.not.objectContaining({
        deletedJobIds: expect.anything(),
        deletedJobIdSample: expect.anything()
      })
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'queue.non_gpt_terminal.legacy_null.protected',
      expect.objectContaining({
        protectedTerminal: 3,
        protectedAsk: 2,
        protectedDagNode: 1,
        protectedCompleted: 2,
        protectedCancelled: 1,
        sampleLimitReached: false
      })
    );
    const warningCall = loggerWarnMock.mock.calls.find(
      ([eventName]) => eventName === 'queue.non_gpt_terminal.legacy_null.protected'
    );
    expect(warningCall?.[1]).not.toHaveProperty('id');
    expect(warningCall?.[1]).not.toHaveProperty('jobId');
    expect(warningCall?.[1]).not.toHaveProperty('jobIds');
    expect(warningCall?.[1]).not.toHaveProperty('payload');

    await runNonGptTerminalCleanup('test-repeat');
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it('resolves bounded retention policy from environment', () => {
    expect(resolveJobEventCleanupPolicy({
      JOB_EVENTS_CLEANUP_ENABLED: 'true',
      JOB_EVENTS_CLEANUP_DRY_RUN: 'false',
      JOB_EVENTS_RETENTION_DAYS: '999',
      JOB_EVENTS_CLEANUP_BATCH_SIZE: '99999'
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      dryRun: false,
      retentionDays: 365,
      batchSize: 10_000
    });
  });

  it('falls back safely for invalid plural cleanup config', () => {
    expect(resolveJobEventCleanupPolicy({
      JOB_EVENTS_CLEANUP_ENABLED: 'maybe',
      JOB_EVENTS_CLEANUP_DRY_RUN: 'maybe',
      JOB_EVENTS_RETENTION_DAYS: 'not-a-number',
      JOB_EVENTS_CLEANUP_BATCH_SIZE: 'not-a-number'
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      dryRun: true,
      retentionDays: 30,
      batchSize: 1_000
    });
  });

  it('supports legacy singular cleanup config names', () => {
    expect(resolveJobEventCleanupPolicy({
      JOB_EVENT_CLEANUP_ENABLED: 'false',
      JOB_EVENT_CLEANUP_DRY_RUN: 'false',
      JOB_EVENT_RETENTION_DAYS: '14',
      JOB_EVENT_CLEANUP_BATCH_SIZE: '25'
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: false,
      dryRun: false,
      retentionDays: 14,
      batchSize: 25
    });
  });

  it('skips cleanup when disabled', async () => {
    const result = await runJobEventCleanup('test', {
      enabled: false,
      dryRun: true,
      retentionDays: 30,
      batchSize: 1_000
    });

    expect(result).toEqual(expect.objectContaining({
      enabled: false,
      skipped: true,
      failed: false,
      matchedRows: 0,
      deletedRows: 0
    }));
    expect(cleanupJobEventsMock).not.toHaveBeenCalled();
    expect(recordJobEventCleanupMock).not.toHaveBeenCalled();
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
