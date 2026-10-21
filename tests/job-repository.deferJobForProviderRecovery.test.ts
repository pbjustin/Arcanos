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
  recordJobEvent: recordJobEventMock,
  recordJobEventWithClient: jest.fn()
}));

const { beginBackstageAuthorityGeneration, deferJobForProviderRecovery } = await import('../src/core/db/repositories/jobRepository.js');

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

  it('atomically persists authority waiting while releasing the lease and resetting generation time', async () => {
    const state = { version: 1, startedAt: 1_000, deadlineAt: 721_000, pollCount: 1 };
    await deferJobForProviderRecovery('job-provider', {
      fence: { workerId: 'async-queue-slot-1', claimGeneration: '4' },
      delayMs: 15_000,
      errorMessage: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
      deferralKind: 'backstage_notion_authority',
      autonomyState: { backstageAuthorityWait: state },
    });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('started_at = NULL');
    expect(sql).toContain('lease_expires_at = NULL');
    expect(sql).toContain('last_heartbeat_at = NULL');
    expect(sql).toContain('AND cancel_requested_at IS NULL');
    expect(sql).toContain('AND claim_generation = $6::bigint');
    expect(sql).not.toContain('retry_count =');
    expect(JSON.parse(String(params[2]))).toEqual({ backstageAuthorityWait: state });
    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ backstageAuthorityDeferral: true, providerDeferral: false }),
    }));
  });

  it('fences the fresh execution clock and records the one generation allowed to execute', async () => {
    await beginBackstageAuthorityGeneration('job-provider', { fence: { workerId: 'slot-1', claimGeneration: '4' } });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('locked_claim AS MATERIALIZED');
    expect(sql).toContain('SELECT id, clock_timestamp() AS admitted_at FROM locked_claim');
    expect(sql).toContain('SET started_at = execution_clock.admitted_at');
    expect(sql).toContain('executionClaimGeneration');
    expect(sql).toContain("AND NOT (autonomy_state->'backstageAuthorityWait' ? 'executionClaimGeneration')");
    expect(sql).toContain('AND claim_generation = $3::bigint');
    expect(sql).toContain('AND lease_expires_at >= execution_clock.admitted_at');
    expect(sql).toContain('AND cancel_requested_at IS NULL');
    expect(sql).toContain("deadlineAt}')::bigint > EXTRACT(EPOCH FROM execution_clock.admitted_at)");
    expect(params).toEqual(['job-provider', 'slot-1', '4']);
  });
});
