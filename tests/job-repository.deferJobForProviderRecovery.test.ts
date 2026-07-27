import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const recordJobEventMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('../src/core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock
}));

const { deferJobForProviderRecovery } = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.deferJobForProviderRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [{
        id: 'job-provider',
        status: 'pending',
        retry_count: 2,
        claim_generation: '4'
      }]
    });
  });

  it('re-pends a running job without incrementing retry_count', async () => {
    const result = await deferJobForProviderRecovery('job-provider', {
      fence: {
        workerId: 'async-queue-slot-1',
        claimGeneration: '4'
      },
      delayMs: 60_000,
      errorMessage: 'provider unavailable',
      autonomyState: {
        providerDeferral: {
          retryBudgetConsumed: false
        }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      id: 'job-provider',
      status: 'pending',
      retry_count: 2
    }));
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("AND status = 'running'");
    expect(sql).toContain('AND last_worker_id = $5::text');
    expect(sql).toContain('AND claim_generation = $6::bigint');
    expect(sql).toContain('AND lease_expires_at IS NOT NULL');
    expect(sql).toContain('AND lease_expires_at >= NOW()');
    expect(sql).toContain('AND cancel_requested_at IS NULL');
    expect(sql).toContain('next_run_at = NOW()');
    expect(sql).not.toContain('retry_count = retry_count + 1');
    expect(params).toEqual([
      'provider unavailable',
      60_000,
      expect.any(String),
      'job-provider',
      'async-queue-slot-1',
      '4'
    ]);
    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'job.retry.scheduled',
      metadata: expect.objectContaining({
        claimGeneration: '4',
        providerDeferral: true,
        retryBudgetConsumed: false
      })
    }));
  });

  it('returns null when the job is no longer running', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await deferJobForProviderRecovery('job-provider', {
      fence: {
        workerId: 'async-queue-slot-1',
        claimGeneration: '4'
      },
      delayMs: 60_000,
      errorMessage: 'provider unavailable'
    });

    expect(result).toBeNull();
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND status = 'running'");
  });
});
