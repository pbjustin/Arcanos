import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();
const poolConnectMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

const {
  DEFAULT_JOB_WORKER_STALE_AFTER_MS,
  recoverStaleJobs,
  resolveJobWorkerStaleAfterMs
} = await import('../src/core/db/repositories/jobRepository.js');

function mockStaleRows(rows: Array<Record<string, unknown>>): void {
  clientQueryMock.mockImplementation(async (sql: unknown) => {
    if (
      typeof sql === 'string' &&
      sql.includes('FROM job_data') &&
      sql.includes('FOR UPDATE')
    ) {
      return { rows };
    }

    return { rows: [] };
  });
}

function getJobUpdateSql(): string {
  const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
    typeof sql === 'string' && sql.includes('UPDATE job_data')
  );

  if (!updateCall || typeof updateCall[0] !== 'string') {
    throw new Error('Expected a job_data update query.');
  }

  return updateCall[0];
}

describe('jobRepository lifecycle recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    poolConnectMock.mockResolvedValue({
      query: clientQueryMock,
      release: clientReleaseMock
    });
    getPoolMock.mockReturnValue({
      connect: poolConnectMock
    });
  });

  it('defaults worker stale recovery to the quieter env-backed threshold', () => {
    expect(DEFAULT_JOB_WORKER_STALE_AFTER_MS).toBe(45_000);
    expect(resolveJobWorkerStaleAfterMs({} as NodeJS.ProcessEnv)).toBe(45_000);
    expect(
      resolveJobWorkerStaleAfterMs({
        JOB_WORKER_STALE_AFTER_MS: '70000.9'
      } as NodeJS.ProcessEnv)
    ).toBe(70_000);
    expect(
      resolveJobWorkerStaleAfterMs({
        JOB_WORKER_STALE_AFTER_MS: '999.9'
      } as NodeJS.ProcessEnv)
    ).toBe(1_000);
  });

  it('dead-letters stale jobs with persisted max_retries=0 even when the global default allows retries', async () => {
    mockStaleRows([
      {
        id: 'job-max-zero',
        job_type: 'ask',
        retry_count: 0,
        max_retries: 0,
        autonomy_state: {},
        cancel_requested_at: null,
        cancel_reason: null
      }
    ]);

    const result = await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2
    });

    expect(result).toEqual({
      recoveredJobs: [],
      failedJobs: ['job-max-zero'],
      cancelledJobs: []
    });
    expect(getJobUpdateSql()).toContain("status = 'failed'");
  });

  it('requeues stale jobs with persisted max_retries=1 even when the global fallback is zero', async () => {
    mockStaleRows([
      {
        id: 'job-max-one',
        job_type: 'ask',
        retry_count: 0,
        max_retries: 1,
        autonomy_state: {},
        cancel_requested_at: null,
        cancel_reason: null
      }
    ]);

    const result = await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 0
    });

    expect(result).toEqual({
      recoveredJobs: ['job-max-one'],
      failedJobs: [],
      cancelledJobs: []
    });
    expect(getJobUpdateSql()).toContain("status = 'pending'");
    expect(getJobUpdateSql()).toContain('retry_count = retry_count + 1');
  });

  it('uses the global maxRetries fallback only when persisted max_retries is null', async () => {
    mockStaleRows([
      {
        id: 'job-null-max',
        job_type: 'ask',
        retry_count: 0,
        max_retries: null,
        autonomy_state: {},
        cancel_requested_at: null,
        cancel_reason: null
      }
    ]);

    const result = await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 0
    });

    expect(result).toEqual({
      recoveredJobs: [],
      failedJobs: ['job-null-max'],
      cancelledJobs: []
    });
    expect(getJobUpdateSql()).toContain("status = 'failed'");
  });

  it('reports cancellation-requested stale jobs separately from failed dead-letter jobs', async () => {
    mockStaleRows([
      {
        id: 'job-cancelled-stale',
        job_type: 'gpt',
        retry_count: 0,
        max_retries: 0,
        autonomy_state: {},
        cancel_requested_at: new Date('2026-04-29T10:00:00.000Z'),
        cancel_reason: 'Operator cancelled stale job'
      }
    ]);

    const result = await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2
    });

    expect(result).toEqual({
      recoveredJobs: [],
      failedJobs: [],
      cancelledJobs: ['job-cancelled-stale']
    });
    expect(getJobUpdateSql()).toContain("status = 'cancelled'");
  });

  it('does not emit stale recovery events when the transaction rolls back', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (
        typeof sql === 'string' &&
        sql.includes('FROM job_data') &&
        sql.includes('FOR UPDATE')
      ) {
        return {
          rows: [
            {
              id: 'job-rollback-stale',
              worker_id: 'worker-1',
              last_worker_id: 'worker-1',
              correlation_id: 'trace-1',
              job_type: 'ask',
              status: 'running',
              retry_count: 0,
              max_retries: 1,
              autonomy_state: {},
              cancel_requested_at: null,
              cancel_reason: null
            }
          ]
        };
      }
      if (sql === 'COMMIT') {
        throw new Error('commit failed');
      }

      return { rows: [] };
    });

    await expect(recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2
    })).rejects.toThrow('commit failed');

    expect(queryMock).not.toHaveBeenCalled();
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('flushes stale recovery events only after commit succeeds', async () => {
    mockStaleRows([
      {
        id: 'job-post-commit',
        worker_id: 'worker-1',
        last_worker_id: 'worker-1',
        correlation_id: 'trace-1',
        job_type: 'ask',
        status: 'running',
        retry_count: 0,
        max_retries: 1,
        autonomy_state: {},
        cancel_requested_at: null,
        cancel_reason: null
      }
    ]);

    await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2
    });

    const commitOrder = clientQueryMock.mock.invocationCallOrder[
      clientQueryMock.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
    ];
    const firstEventOrder = queryMock.mock.invocationCallOrder[0];

    expect(commitOrder).toBeLessThan(firstEventOrder);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('counts null-heartbeat stale running jobs in the queue summary predicate', async () => {
    const { getJobQueueSummary } = await import('../src/core/db/repositories/jobRepository.js');
    queryMock.mockResolvedValueOnce({
      rows: []
    });

    await getJobQueueSummary();

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'OR (last_heartbeat_at IS NULL AND started_at < NOW() - ($2::bigint * INTERVAL'
    );
  });
});
