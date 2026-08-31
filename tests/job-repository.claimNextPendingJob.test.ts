import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();
const poolConnectMock = jest.fn();
const recordJobEventMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('../src/core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock,
  recordJobEventWithClient: jest.fn()
}));

const {
  claimNextPendingJob,
  claimNextPendingJobWithAdmission,
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
    expect(updateCall?.[0]).not.toContain('$4');
    expect(updateCall?.[0]).toContain("job_type <> 'local-agent'");
    expect(updateCall?.[0]).toContain('claim_generation = claim_generation + 1');
    expect(updateCall?.[0]).toContain('last_worker_id = $2');
    expect(updateCall?.[0]).toContain('stats_worker_id = $3');
    expect(updateCall?.[1]).toEqual([12_000, 'worker-1', 'worker-1']);
  });

  it('persists the exact shared stats worker id independently of the lease worker id', async () => {
    const claimOptions = {
      workerId: 'async-queue-slot-2',
      statsWorkerId: 'async-queue',
      leaseMs: 12_000,
      priorityQueueEnabled: false
    };

    await claimNextPendingJob(claimOptions);

    const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    );

    expect(updateCall).toBeDefined();
    expect(updateCall?.[0]).toContain('last_worker_id = $2');
    expect(updateCall?.[0]).toContain('stats_worker_id = $3');
    expect(updateCall?.[1]).toEqual([12_000, 'async-queue-slot-2', 'async-queue']);
  });

  it.each([undefined, '', '   '])(
    'rejects an unusable worker id before touching the database: %p',
    async (workerId) => {
      await expect(claimNextPendingJob({
        workerId: workerId as string,
        leaseMs: 12_000
      })).rejects.toThrow('requires a non-empty workerId');

      expect(getPoolMock).not.toHaveBeenCalled();
      expect(clientQueryMock).not.toHaveBeenCalled();
    }
  );

  it('rejects a missing claim options object before touching the database', async () => {
    await expect(claimNextPendingJob(undefined as never)).rejects.toThrow(
      'requires a non-empty workerId'
    );
    expect(getPoolMock).not.toHaveBeenCalled();
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
    expect(updateCalls[0]?.[0]).not.toContain('$4');
  });

  it('uses the configured priority lane threshold when claiming the normal lane', async () => {
    let updateQueryCount = 0;
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
        updateQueryCount += 1;
        return updateQueryCount === 1
          ? { rows: [{ id: 'priority-job', job_type: 'gpt', priority: 0, claim_generation: '1' }] }
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
    expect(updateCalls[0]?.[0]).toContain('$4');
    expect(updateCalls[0]?.[1]).toEqual([12_000, 'worker-1', 'worker-1', 3]);
    expect(updateCalls[1]?.[0]).not.toContain('$4');
    expect(updateCalls[1]?.[1]).toEqual([12_000, 'worker-1', 'worker-1']);
    expect(recordJobEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'job.claimed',
      metadata: expect.objectContaining({
        claimGeneration: '1'
      })
    }));
  });

  it('claims five priority jobs before one normal job when both lanes have backlog', async () => {
    const laneClaims: string[] = [];
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
        const lane = sql.includes('$4') ? 'normal' : 'priority';
        laneClaims.push(lane);
        return {
          rows: [{
            id: `${lane}-job-${laneClaims.length}`,
            job_type: lane === 'priority' ? 'gpt' : 'task',
            priority: lane === 'priority' ? 0 : 85,
            claim_generation: String(laneClaims.length)
          }]
        };
      }

      return { rows: [] };
    });

    const claimedJobs = [];
    for (let index = 0; index < 6; index += 1) {
      claimedJobs.push(await claimNextPendingJob({
        workerId: `worker-${index}`,
        leaseMs: 12_000,
        priorityQueueEnabled: true,
        priorityQueueWeight: 5
      }));
    }

    expect(laneClaims).toEqual([
      'priority',
      'priority',
      'priority',
      'priority',
      'priority',
      'normal'
    ]);
    expect(claimedJobs.map(job => job?.id)).toEqual([
      'priority-job-1',
      'priority-job-2',
      'priority-job-3',
      'priority-job-4',
      'priority-job-5',
      'normal-job-6'
    ]);
  });

  it('serializes database claims while updating priority fairness state', async () => {
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
          return {
            rows: [{ id: 'priority-job', job_type: 'gpt', priority: 0, claim_generation: '1' }]
          };
        }

        if (updateQueryCount === 2) {
          return {
            rows: [{ id: 'normal-job', job_type: 'task', priority: 85, claim_generation: '1' }]
          };
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

    expect(poolConnectMock).toHaveBeenCalledTimes(1);
    expect(updateQueryCount).toBe(1);

    resolveFirstUpdate();
    await Promise.all([firstClaim, secondClaim]);

    expect(updateQueryCount).toBe(2);
  });

  it('atomically reserves a job claim after both shared budgets admit one production database-clock instant', async () => {
    const evaluatedAt = new Date('2026-08-30T14:00:00.000Z');
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql !== 'string') {
        return { rows: [] };
      }
      if (sql.includes('SELECT COALESCE')) {
        return { rows: [{ evaluated_at: evaluatedAt }] };
      }
      if (sql.includes('COUNT(*)::int AS used_count')) {
        return { rows: [{ used_count: 0, recovery_reservation_at: null }] };
      }
      if (sql.includes('UPDATE job_data')) {
        return {
          rows: [{
            id: '10000000-0000-4000-8000-000000000001',
            job_type: 'ask',
            priority: 100,
            claim_generation: '4'
          }]
        };
      }
      return { rows: [] };
    });

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(claimNextPendingJobWithAdmission({
        workerId: 'async-queue-slot-1',
        statsWorkerId: 'async-queue',
        leaseMs: 12_000,
        priorityQueueEnabled: false,
        maxJobsPerHour: 2,
        maxAiCallsPerHour: 3
      })).resolves.toMatchObject({
        job: { claim_generation: '4' },
        budgetAdmission: {
          kind: 'job_claim',
          allowed: true,
          used: 1,
          limit: 2,
          remaining: 1,
          evaluatedAt: evaluatedAt.toISOString()
        }
      });
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }

    const calls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(calls.filter(sql => sql.includes('SELECT COALESCE'))).toHaveLength(1);
    const beginIndex = calls.findIndex(sql => sql === 'BEGIN ISOLATION LEVEL READ COMMITTED');
    const timeoutBoundsIndex = calls.findIndex(sql => sql.includes("set_config('lock_timeout'"));
    const jobLockIndex = calls.findIndex(sql => sql.includes('pg_advisory_xact_lock') &&
      clientQueryMock.mock.calls[calls.indexOf(sql)]?.[1]?.[0] === 'job_claim');
    const aiLockIndex = clientQueryMock.mock.calls.findIndex(([, params]) =>
      Array.isArray(params) && params[0] === 'ai_provider_attempt'
    );
    const updateIndex = calls.findIndex(sql => sql.includes('UPDATE job_data'));
    const reservationIndex = calls.findIndex(sql => sql.includes('INSERT INTO job_events'));
    const commitIndex = calls.findIndex(sql => sql === 'COMMIT');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(timeoutBoundsIndex).toBeGreaterThan(beginIndex);
    expect(jobLockIndex).toBeGreaterThan(timeoutBoundsIndex);
    expect(aiLockIndex).toBeGreaterThan(jobLockIndex);
    expect(updateIndex).toBeGreaterThan(aiLockIndex);
    expect(reservationIndex).toBeGreaterThan(updateIndex);
    expect(commitIndex).toBeGreaterThan(reservationIndex);
    expect(clientQueryMock.mock.calls[timeoutBoundsIndex]?.[1]).toEqual([
      1_000,
      5_000,
      6_000
    ]);
    const updateCall = clientQueryMock.mock.calls[updateIndex];
    expect(updateCall?.[0]).toContain('$4::timestamptz');
    expect(updateCall?.[1]).toEqual([
      12_000,
      'async-queue-slot-1',
      'async-queue',
      evaluatedAt.toISOString()
    ]);
    const reservationCall = clientQueryMock.mock.calls[reservationIndex];
    expect(reservationCall?.[1]).toEqual(expect.arrayContaining([
      '10000000-0000-4000-8000-000000000001',
      'worker.budget.job_claim',
      'async-queue-slot-1',
      'async-queue',
      '4',
      evaluatedAt.toISOString()
    ]));
  });

  it('caps the whole claim transaction below the effective lease', async () => {
    await claimNextPendingJob({
      workerId: 'worker-1',
      leaseMs: 1_000,
      priorityQueueEnabled: false
    });

    const timeoutBoundsCall = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes("set_config('transaction_timeout'")
    );
    expect(timeoutBoundsCall?.[1]).toEqual([1_000, 5_000, 500]);
  });

  it('returns the recovery time when a final allowed claim fills the rolling window', async () => {
    const evaluatedAt = new Date('2026-08-30T14:00:00.000Z');
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql !== 'string') {
        return { rows: [] };
      }
      if (sql.includes('SELECT COALESCE')) {
        return { rows: [{ evaluated_at: evaluatedAt }] };
      }
      if (sql.includes('COUNT(*)::int AS used_count')) {
        return { rows: [{ used_count: 0, recovery_reservation_at: null }] };
      }
      if (sql.includes('UPDATE job_data')) {
        return {
          rows: [{
            id: '10000000-0000-4000-8000-000000000001',
            job_type: 'ask',
            claim_generation: '1'
          }]
        };
      }
      return { rows: [] };
    });

    await expect(claimNextPendingJobWithAdmission({
      workerId: 'async-queue-slot-1',
      statsWorkerId: 'async-queue',
      maxJobsPerHour: 1,
      maxAiCallsPerHour: 3,
      budgetNowForTesting: evaluatedAt
    })).resolves.toMatchObject({
      job: { id: '10000000-0000-4000-8000-000000000001' },
      budgetAdmission: {
        kind: 'job_claim',
        allowed: true,
        used: 1,
        limit: 1,
        remaining: 0,
        evaluatedAt: evaluatedAt.toISOString(),
        nextAvailableAt: '2026-08-30T15:00:00.000Z'
      }
    });
  });

  it('returns a structured pause at the exact claim threshold without touching a queue row', async () => {
    const evaluatedAt = new Date('2026-08-30T14:00:00.000Z');
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT COALESCE')) {
        return { rows: [{ evaluated_at: evaluatedAt }] };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)::int AS used_count')) {
        return {
          rows: [{
            used_count: 2,
            recovery_reservation_at: new Date('2026-08-30T13:30:00.000Z')
          }]
        };
      }
      return { rows: [] };
    });

    await expect(claimNextPendingJobWithAdmission({
      workerId: 'async-queue-slot-2',
      statsWorkerId: 'async-queue',
      maxJobsPerHour: 2,
      maxAiCallsPerHour: 3,
      budgetNowForTesting: evaluatedAt
    })).resolves.toEqual({
      job: null,
      budgetAdmission: expect.objectContaining({
        kind: 'job_claim',
        allowed: false,
        used: 2,
        remaining: 0,
        nextAvailableAt: '2026-08-30T14:30:00.000Z'
      })
    });
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE job_data'))).toBe(false);
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO job_events'))).toBe(false);
    expect(clientQueryMock).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back the claimed row when strict reservation persistence fails', async () => {
    const evaluatedAt = new Date('2026-08-30T14:00:00.000Z');
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql !== 'string') {
        return { rows: [] };
      }
      if (sql.includes('SELECT COALESCE')) {
        return { rows: [{ evaluated_at: evaluatedAt }] };
      }
      if (sql.includes('COUNT(*)::int AS used_count')) {
        return { rows: [{ used_count: 0, recovery_reservation_at: null }] };
      }
      if (sql.includes('UPDATE job_data')) {
        return {
          rows: [{
            id: '10000000-0000-4000-8000-000000000001',
            job_type: 'ask',
            claim_generation: '1'
          }]
        };
      }
      if (sql.includes('INSERT INTO job_events')) {
        throw new Error('reservation insert failed');
      }
      return { rows: [] };
    });

    await expect(claimNextPendingJobWithAdmission({
      workerId: 'async-queue-slot-1',
      statsWorkerId: 'async-queue',
      maxJobsPerHour: 2,
      maxAiCallsPerHour: 2,
      budgetNowForTesting: evaluatedAt
    })).rejects.toThrow('reservation insert failed');
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(clientQueryMock).not.toHaveBeenCalledWith('COMMIT');
    expect(clientReleaseMock).toHaveBeenCalledWith(undefined);
  });

  it('discards a claim client whose rollback fails while preserving the claim error', async () => {
    const claimError = Object.assign(
      new Error('canceling statement due to lock timeout'),
      { code: '55P03' }
    );
    const rollbackError = new Error('connection closed before rollback');
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (sql === 'ROLLBACK') {
        throw rollbackError;
      }
      if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
        throw claimError;
      }
      return { rows: [] };
    });

    await expect(claimNextPendingJob({
      workerId: 'worker-1',
      priorityQueueEnabled: false
    })).rejects.toBe(claimError);

    expect(clientReleaseMock).toHaveBeenCalledWith(rollbackError);
  });
});
