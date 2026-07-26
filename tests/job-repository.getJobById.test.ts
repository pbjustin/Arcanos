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
  getJobById,
  JobRepositoryUnavailableError,
  requestJobCancellation
} = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.getJobById', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('rejects with the typed repository error without querying when disconnected', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);
    const lookup = getJobById('job-disconnected');

    await expect(lookup).rejects.toEqual(
      expect.objectContaining({
        name: 'JobRepositoryUnavailableError',
        code: 'JOB_REPOSITORY_UNAVAILABLE'
      })
    );
    await expect(lookup).rejects.toBeInstanceOf(JobRepositoryUnavailableError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null only after a successful query finds no row', async () => {
    await expect(getJobById('job-missing')).resolves.toBeNull();

    expect(queryMock).toHaveBeenCalledWith(
      'SELECT * FROM job_data WHERE id = $1 LIMIT 1',
      ['job-missing']
    );
  });

  it('returns the matching row from a successful query', async () => {
    const job = {
      id: 'job-found',
      job_type: 'gpt',
      status: 'running'
    };
    queryMock.mockResolvedValue({ rows: [job] });

    await expect(getJobById('job-found')).resolves.toBe(job);
  });

  it('propagates query failures unchanged', async () => {
    const expectedError = new Error('query transport failed');
    queryMock.mockRejectedValue(expectedError);

    await expect(getJobById('job-query-error')).rejects.toBe(expectedError);
  });

  it('uses the typed repository error if cancellation loses its database pool', async () => {
    getPoolMock.mockReturnValue(null);

    await expect(requestJobCancellation('job-cancel')).rejects.toEqual(
      expect.objectContaining({
        name: 'JobRepositoryUnavailableError',
        code: 'JOB_REPOSITORY_UNAVAILABLE'
      })
    );
    expect(queryMock).not.toHaveBeenCalled();
  });
});
