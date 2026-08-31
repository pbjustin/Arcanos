import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  isDatabaseConnected: isDatabaseConnectedMock
}));
jest.unstable_mockModule('@core/db/query.js', () => ({ query: queryMock }));

const { getJobExecutionStatsSince } = await import(
  '../src/core/db/repositories/jobRepository.js'
);

describe('jobRepository worker budget identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [{
        completed_count: 2,
        failed_count: 1,
        running_count: 1,
        total_terminal_count: 3,
        job_claim_count: 4,
        ai_call_count: 3
      }]
    });
  });

  it('queries only the exact persisted stats worker identity', async () => {
    const since = new Date('2026-08-01T12:00:00.000Z');

    await expect(getJobExecutionStatsSince(since, '  production-ai-budget  ')).resolves.toEqual({
      completed: 2,
      failed: 1,
      running: 1,
      totalTerminal: 3,
      jobClaims: 4,
      aiCalls: 3
    });

    const [sql, params] = queryMock.mock.calls[0] ?? [];
    expect(sql).toContain('stats_worker_id = $2');
    expect(sql).not.toContain('last_worker_id = $2');
    expect(sql).not.toMatch(/\bOR\s+worker_id\s*=\s*\$2/u);
    expect(params).toEqual([since.toISOString(), 'production-ai-budget']);
  });

  it('retains explicit deployment-wide aggregation when no stats id is supplied', async () => {
    const since = new Date('2026-08-01T12:00:00.000Z');

    await getJobExecutionStatsSince(since);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('$2::text IS NULL'),
      [since.toISOString(), null]
    );
  });

  it.each([
    ['an empty', ''],
    ['a whitespace-only', '  \t  ']
  ])('treats %s stats id as deployment-wide aggregation', async (_label, statsWorkerId) => {
    const since = new Date('2026-08-01T12:00:00.000Z');

    await getJobExecutionStatsSince(since, statsWorkerId);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('$2::text IS NULL'),
      [since.toISOString(), null]
    );
  });

  it('returns zero counters without querying when the database is disconnected', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);

    await expect(
      getJobExecutionStatsSince(new Date('2026-08-01T12:00:00.000Z'), 'production-ai-budget')
    ).resolves.toEqual({
      completed: 0,
      failed: 0,
      running: 0,
      totalTerminal: 0,
      jobClaims: 0,
      aiCalls: 0
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
