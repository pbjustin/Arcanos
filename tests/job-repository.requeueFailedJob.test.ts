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

const { requeueFailedJob } = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.requeueFailedJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            status: 'failed',
            error_message: 'OpenAI upstream timeout',
            retry_count: 2
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', status: 'pending', error_message: null, retry_count: 0 }]
      });
  });

  it('resets a retained failed job to pending for explicit operator recovery', async () => {
    const result = await requeueFailedJob('job-1', {
      requestedBy: 'test-suite'
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [sql] = queryMock.mock.calls[1] as [string, unknown[]];

    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('retry_count = CASE');
    expect(sql).toContain("WHERE id = $4");
    expect(result).toEqual(expect.objectContaining({
      id: 'job-1',
      status: 'pending',
      error_message: null,
      retry_count: 0
    }));
  });
});
