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

const { updateJob } = await import('../src/core/db/repositories/jobRepository.js');

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
  });
});
