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

const { recordJobHeartbeat, scheduleJobRetry, updateJob } = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.updateJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [{ id: 'job-1', status: 'cancelled' }]
    });
  });

  it('casts the status parameter consistently to avoid PostgreSQL type inference failures', async () => {
    await updateJob(
      'job-1',
      'cancelled',
      { ok: false },
      'Job cancellation requested by client.',
      undefined,
      { cancelRequestedAt: '2026-04-06T21:00:00.000Z' }
    );

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('status = $1::varchar(50)');
    expect(sql).toContain("WHEN $1::varchar(50) = 'expired'::varchar(50)");
    expect(sql).toContain("WHEN $1::varchar(50) = 'cancelled'::varchar(50)");
    expect(sql).toContain("status NOT IN ('completed', 'failed', 'cancelled', 'expired')");
  });

  it('clears stale started_at when scheduling a retry', async () => {
    await scheduleJobRetry('job-1', {
      delayMs: 500,
      errorMessage: 'retry this job',
      workerId: 'worker-1'
    });

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('started_at = NULL');
  });

  it('only heartbeats a job still owned by the supplied worker lease', async () => {
    await recordJobHeartbeat('job-1', {
      workerId: 'worker-1',
      leaseMs: 15_000
    });

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("AND status = 'running'");
    expect(sql).toContain('OR last_worker_id = $2::text');
    expect(sql).toContain('OR lease_expires_at >= NOW()');
  });

  it.each(['failed', 'cancelled', 'timed-out'])(
    'does not schedule retry after a terminal %s race',
    async () => {
      queryMock.mockResolvedValueOnce({
        rows: []
      });

      const result = await scheduleJobRetry('job-1', {
        delayMs: 500,
        errorMessage: 'retry this job',
        workerId: 'worker-1'
      });

      const [sql] = queryMock.mock.calls[0] as [string, unknown[]];

      expect(result).toBeNull();
      expect(sql).toContain("AND status = 'running'");
      expect(sql).toContain('OR last_worker_id = $3::text');
      expect(sql).not.toContain('OR last_worker_id IS NULL');
      expect(sql).toContain('OR lease_expires_at >= NOW()');
      expect(sql).not.toContain('OR lease_expires_at IS NULL');
    }
  );
});
