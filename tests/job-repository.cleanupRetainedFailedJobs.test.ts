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

const {
  createJob,
  cleanupRetainedFailedJobs
} = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.cleanupRetainedFailedJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [
        {
          deleted_job_ids: ['failed-old-1', 'failed-old-2'],
          deleted_failed: 2,
          retained_failed: 50
        }
      ]
    });
  });

  it('removes older failed jobs while retaining the configured newest failures', async () => {
    const result = await cleanupRetainedFailedJobs({
      keep: 50,
      minAgeMs: 86_400_000
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("WHERE status = 'failed'");
    expect(sql).toContain('retained_rank > $1');
    expect(sql).toContain('job_data.updated_at < NOW()');
    expect(sql).toContain("job_data.job_type <> 'gpt'");
    expect(params).toEqual([50, 86_400_000]);
    expect(result).toEqual({
      keep: 50,
      minAgeMs: 86_400_000,
      deletedFailed: 2,
      retainedFailed: 50,
      deletedJobIds: ['failed-old-1', 'failed-old-2']
    });
  });

  it('is a no-op when the database is unavailable', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);

    const result = await cleanupRetainedFailedJobs({ keep: 20, minAgeMs: 0 });

    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      keep: 20,
      minAgeMs: 0,
      deletedFailed: 0,
      retainedFailed: 0,
      deletedJobIds: []
    });
  });

  it('persists a correlation id from job input metadata', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-correlation', correlation_id: 'req-123' }]
    });

    await createJob(
      'worker-1',
      'ask',
      { prompt: 'test', clientContext: { requestId: 'req-123' } },
      'pending'
    );

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('correlation_id');
    expect(params[12]).toBe('req-123');
  });
});
