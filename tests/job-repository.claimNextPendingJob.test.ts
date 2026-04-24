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
  claimNextPendingJob,
  resetPriorityQueueFairnessState
} = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.claimNextPendingJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPriorityQueueFairnessState();
    isDatabaseConnectedMock.mockReturnValue(true);
    clientQueryMock.mockResolvedValue({ rows: [] });
    poolConnectMock.mockResolvedValue({
      query: clientQueryMock,
      release: clientReleaseMock
    });
    getPoolMock.mockReturnValue({
      connect: poolConnectMock
    });
  });

  it('does not bind the priority lane threshold when the SQL does not reference it', async () => {
    await claimNextPendingJob({
      workerId: 'worker-1',
      leaseMs: 12_000,
      priorityQueueEnabled: false
    });

    const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    );

    expect(updateCall).toBeDefined();
    expect(updateCall?.[0]).not.toContain('$3');
    expect(updateCall?.[1]).toEqual([12_000, 'worker-1']);
  });
});
