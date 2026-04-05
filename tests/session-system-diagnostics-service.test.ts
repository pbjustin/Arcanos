import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetJobQueueSummary = jest.fn();
const mockGetLatestJob = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  getJobQueueSummary: mockGetJobQueueSummary,
  getLatestJob: mockGetLatestJob
}));

const { getQueueDiagnostics } = await import('../src/services/sessionSystemDiagnosticsService.js');

describe('sessionSystemDiagnosticsService.getQueueDiagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the rolling terminal-job window for failureRate while preserving historicalFailureRate', async () => {
    mockGetJobQueueSummary.mockResolvedValue({
      pending: 0,
      running: 0,
      completed: 266,
      failed: 142,
      total: 408,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0,
      failureBreakdown: {
        retryable: 86,
        permanent: 56,
        retryScheduled: 0,
        retryExhausted: 56,
        authentication: 2,
        network: 0,
        provider: 0,
        rateLimited: 0,
        timeout: 98,
        validation: 6,
        unknown: 36
      },
      recentFailureReasons: [],
      recentTerminalWindowMs: 3600000,
      recentCompleted: 2,
      recentFailed: 0,
      recentTotalTerminal: 2,
      lastUpdatedAt: '2026-04-05T00:51:45.711Z'
    });
    mockGetLatestJob.mockResolvedValue({
      id: 'job-live',
      status: 'completed',
      completed_at: '2026-04-05T00:51:45.711Z'
    });

    const result = await getQueueDiagnostics();

    expect(result.status).toBe('live');
    expect(result.failureRate).toBe(0);
    expect(result.historicalFailureRate).toBe(0.348);
    expect(result.failureRateWindowMs).toBe(3600000);
    expect(result.windowCompletedJobs).toBe(2);
    expect(result.windowFailedJobs).toBe(0);
    expect(result.windowTerminalJobs).toBe(2);
  });

  it('degrades when the rolling failure window exceeds the health threshold', async () => {
    mockGetJobQueueSummary.mockResolvedValue({
      pending: 0,
      running: 0,
      completed: 12,
      failed: 2,
      total: 14,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0,
      failureBreakdown: {
        retryable: 1,
        permanent: 1,
        retryScheduled: 0,
        retryExhausted: 1,
        authentication: 0,
        network: 0,
        provider: 0,
        rateLimited: 0,
        timeout: 2,
        validation: 0,
        unknown: 0
      },
      recentFailureReasons: [],
      recentTerminalWindowMs: 3600000,
      recentCompleted: 9,
      recentFailed: 1,
      recentTotalTerminal: 10
    });
    mockGetLatestJob.mockResolvedValue({
      id: 'job-degraded',
      status: 'failed',
      completed_at: '2026-04-05T00:51:45.711Z'
    });

    const result = await getQueueDiagnostics();

    expect(result.status).toBe('degraded');
    expect(result.failureRate).toBe(0.1);
    expect(result.historicalFailureRate).toBe(0.1429);
  });
});
