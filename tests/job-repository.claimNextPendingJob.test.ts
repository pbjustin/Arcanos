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

  it('does not run a redundant normal-lane fallback after an empty priority-lane claim', async () => {
    await claimNextPendingJob({
      workerId: 'worker-1',
      leaseMs: 12_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 5
    });

    const updateCalls = clientQueryMock.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.[0]).not.toContain('$3');
  });

  it('uses the configured priority lane threshold when claiming the normal lane', async () => {
    let updateQueryCount = 0;
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
        updateQueryCount += 1;
        return updateQueryCount === 1
          ? { rows: [{ id: 'priority-job', job_type: 'gpt', priority: 0 }] }
          : { rows: [] };
      }

      return { rows: [] };
    });

    await claimNextPendingJob({
      workerId: 'worker-1',
      leaseMs: 12_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 1,
      priorityLaneMaxPriority: 3
    });

    clientQueryMock.mockClear();

    await claimNextPendingJob({
      workerId: 'worker-1',
      leaseMs: 12_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 1,
      priorityLaneMaxPriority: 3
    });

    const updateCalls = clientQueryMock.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    );

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.[0]).toContain('$3');
    expect(updateCalls[0]?.[1]).toEqual([12_000, 'worker-1', 3]);
    expect(updateCalls[1]?.[0]).not.toContain('$3');
    expect(updateCalls[1]?.[1]).toEqual([12_000, 'worker-1']);
  });

  it('serializes priority queue claims until fairness state is updated', async () => {
    let updateQueryCount = 0;
    let resolveFirstUpdateStarted: () => void = () => {};
    let resolveFirstUpdate: () => void = () => {};
    const firstUpdateStarted = new Promise<void>(resolve => {
      resolveFirstUpdateStarted = resolve;
    });
    const firstUpdateAllowed = new Promise<void>(resolve => {
      resolveFirstUpdate = resolve;
    });

    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
        updateQueryCount += 1;

        if (updateQueryCount === 1) {
          resolveFirstUpdateStarted();
          await firstUpdateAllowed;
          return { rows: [{ id: 'priority-job', job_type: 'gpt', priority: 0 }] };
        }

        return { rows: [] };
      }

      return { rows: [] };
    });

    const firstClaim = claimNextPendingJob({
      workerId: 'worker-1',
      leaseMs: 12_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 1
    });
    await firstUpdateStarted;

    const secondClaim = claimNextPendingJob({
      workerId: 'worker-2',
      leaseMs: 12_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 1
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(updateQueryCount).toBe(1);

    resolveFirstUpdate();
    await Promise.all([firstClaim, secondClaim]);

    expect(updateQueryCount).toBe(3);
  });
});
