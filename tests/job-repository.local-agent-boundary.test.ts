import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

const {
  getJobQueueSummary,
  getLatestJob,
  listFailedJobs
} = await import('../src/core/db/repositories/jobRepository.js');

describe('generic job repository local-agent boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('excludes local-agent jobs from the generic latest-job query', async () => {
    await getLatestJob();

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("job_type <> 'local-agent'");
    expect(params).toEqual([]);
  });

  it('excludes local-agent jobs from generic failed-job inspection', async () => {
    await listFailedJobs(5);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("job_type <> 'local-agent'");
    expect(params).toEqual([5]);
  });

  it('excludes local-agent state and failure reasons from generic queue summaries', async () => {
    await getJobQueueSummary();

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql.match(/job_type <> 'local-agent'/gu)).toHaveLength(2);
  });
});
