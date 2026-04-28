import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

const { deferJobForProviderRecovery } = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.deferJobForProviderRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [{ id: 'job-provider', status: 'pending', retry_count: 2 }]
    });
  });

  it('re-pends a running job without incrementing retry_count', async () => {
    const result = await deferJobForProviderRecovery('job-provider', {
      workerId: 'async-queue-slot-1',
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
    expect(sql).toContain('next_run_at = NOW()');
    expect(sql).not.toContain('retry_count = retry_count + 1');
    expect(params).toEqual([
      'provider unavailable',
      60_000,
      'async-queue-slot-1',
      expect.any(String),
      'job-provider'
    ]);
  });
});
