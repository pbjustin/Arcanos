import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
  DEFAULT_JOB_WORKER_RECOVERY_BATCH_SIZE,
  DEFAULT_JOB_WORKER_STALE_AFTER_MS,
  MAX_JOB_WORKER_RECOVERY_BATCH_SIZE,
  recoverStalledJobsForWorkers,
  recoverStaleJobs,
  requestJobCancellation,
  resolveJobWorkerRecoveryBatchSize,
  resolveJobWorkerStaleAfterMs
} = await import('../src/core/db/repositories/jobRepository.js');

const originalRecoveryBatchSize = process.env.JOB_WORKER_RECOVERY_BATCH_SIZE;
const LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE =
  'Legacy queued GPT cancellation requested during compatibility drain.';

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
    delete process.env.JOB_WORKER_RECOVERY_BATCH_SIZE;
    isDatabaseConnectedMock.mockReturnValue(true);
    poolConnectMock.mockResolvedValue({
      query: clientQueryMock,
      release: clientReleaseMock
    });
    getPoolMock.mockReturnValue({
      connect: poolConnectMock
    });
  });

  afterAll(() => {
    if (originalRecoveryBatchSize === undefined) {
      delete process.env.JOB_WORKER_RECOVERY_BATCH_SIZE;
    } else {
      process.env.JOB_WORKER_RECOVERY_BATCH_SIZE = originalRecoveryBatchSize;
    }
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

  it('normalizes the shared recovery batch limit deterministically', () => {
    expect(DEFAULT_JOB_WORKER_RECOVERY_BATCH_SIZE).toBe(100);
    expect(MAX_JOB_WORKER_RECOVERY_BATCH_SIZE).toBe(1_000);
    expect(resolveJobWorkerRecoveryBatchSize(undefined)).toBe(100);
    expect(resolveJobWorkerRecoveryBatchSize('invalid')).toBe(100);
    expect(resolveJobWorkerRecoveryBatchSize(0)).toBe(100);
    expect(resolveJobWorkerRecoveryBatchSize('17.9')).toBe(17);
    expect(resolveJobWorkerRecoveryBatchSize(2_000)).toBe(1_000);
  });

  it('bounds and deterministically orders both stale selectors with skip-locked claims', async () => {
    clientQueryMock.mockResolvedValue({ rows: [] });

    await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2,
      batchSize: 7
    });
    const staleSelector = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('FROM job_data') && sql.includes('FOR UPDATE')
    );
    expect(staleSelector?.[0]).toContain('ORDER BY updated_at ASC NULLS FIRST, id ASC');
    expect(staleSelector?.[0]).toContain('job_type, input');
    expect(staleSelector?.[0]).toContain('LIMIT $2::int');
    expect(staleSelector?.[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(staleSelector?.[1]).toEqual([60_000, 7]);

    clientQueryMock.mockClear();
    clientQueryMock.mockResolvedValue({ rows: [] });
    process.env.JOB_WORKER_RECOVERY_BATCH_SIZE = '19.9';
    await recoverStalledJobsForWorkers({
      workerIds: ['worker-b'],
      staleAfterMs: 60_000,
      maxRetries: 2,
      stalledJobAction: 'requeue'
    });
    const stalledSelector = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('last_worker_id = ANY')
    );
    expect(stalledSelector?.[0]).toContain('ORDER BY updated_at ASC NULLS FIRST, id ASC');
    expect(stalledSelector?.[0]).toMatch(/job_type,\s+input/u);
    expect(stalledSelector?.[0]).toContain('LIMIT $3::int');
    expect(stalledSelector?.[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(stalledSelector?.[1]).toEqual([['worker-b'], 60_000, 19]);
  });

  it('applies the default batch bound when callers omit an override', async () => {
    clientQueryMock.mockResolvedValue({ rows: [] });

    await recoverStaleJobs({ staleAfterMs: 60_000 });
    const staleSelector = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('FROM job_data') && sql.includes('FOR UPDATE')
    );
    expect(staleSelector?.[1]).toEqual([60_000, 100]);

    clientQueryMock.mockClear();
    clientQueryMock.mockResolvedValue({ rows: [] });
    await recoverStalledJobsForWorkers({
      workerIds: ['worker-default'],
      staleAfterMs: 60_000
    });
    const stalledSelector = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('last_worker_id = ANY')
    );
    expect(stalledSelector?.[1]).toEqual([['worker-default'], 60_000, 100]);
  });

  it('leaves local-agent expiry and lease recovery to the device protocol', async () => {
    clientQueryMock.mockResolvedValue({ rows: [] });

    await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2
    });
    const staleSelector = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string'
      && sql.includes('FROM job_data')
      && sql.includes("status = 'running'")
    )?.[0];
    expect(staleSelector).toContain("job_type <> 'local-agent'");

    clientQueryMock.mockClear();
    clientQueryMock.mockResolvedValue({ rows: [] });
    await recoverStalledJobsForWorkers({
      workerIds: ['worker-local-agent'],
      staleAfterMs: 60_000,
      maxRetries: 2,
      stalledJobAction: 'requeue'
    });
    const stalledSelector = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string'
      && sql.includes('FROM job_data')
      && sql.includes('last_worker_id = ANY')
    )?.[0];
    expect(stalledSelector).toContain("job_type <> 'local-agent'");
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
    expect(getJobUpdateSql()).not.toMatch(/claim_generation\s*=/u);
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
        autonomy_state: {
          cancellation: {
            requestedAt: '2026-04-29T10:00:00.000Z',
            reason: LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
          },
        },
        cancel_requested_at: new Date('2026-04-29T10:00:00.000Z'),
        cancel_reason: LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
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
    const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    ) as [string, unknown[]] | undefined;
    expect(updateCall?.[1]?.[0]).toBe(LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE);
    expect(updateCall?.[1]?.[1]).toBe(LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE);
    expect(updateCall?.[1]?.[2]).toBe(true);
    const autonomyState = updateCall?.[1]?.[3];
    expect(typeof autonomyState === 'string' ? JSON.parse(autonomyState) : autonomyState)
      .toMatchObject({
        cancellation: {
          reason: LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
        },
      });
  });

  it('scrubs marker-absent stale GPT cancellation fields while preserving current producer behavior', async () => {
    const privateSentinel = 'private-stale-gpt-cancellation-sentinel';
    const currentReason = 'current generic GPT cancellation';
    mockStaleRows([
      {
        id: 'legacy-stale-private-cancel',
        worker_id: 'queue',
        last_worker_id: 'worker-stale-private',
        correlation_id: null,
        claim_generation: '1',
        job_type: 'gpt',
        input: {
          gptId: 'backstage-booker',
          body: { action: 'generateBooking' },
        },
        status: 'running',
        retry_count: 0,
        max_retries: 2,
        error_message: privateSentinel,
        autonomy_state: {
          cancellation: {
            requestedAt: '2026-08-24T10:00:00.000Z',
            reason: privateSentinel,
            callerDetails: privateSentinel,
          },
          safeSibling: { attempt: 1 },
        },
        cancel_requested_at: new Date('2026-08-24T10:00:00.000Z'),
        cancel_reason: privateSentinel,
      },
      {
        id: 'current-stale-generic-cancel',
        worker_id: 'queue',
        last_worker_id: 'worker-stale-current',
        correlation_id: null,
        claim_generation: '1',
        job_type: 'gpt',
        input: {
          gptId: 'arcanos-core',
          body: { action: 'query' },
          producerContract: {
            version: 1,
            source: 'queued-gpt-runtime',
          },
        },
        status: 'running',
        retry_count: 0,
        max_retries: 2,
        autonomy_state: {
          cancellation: {
            requestedAt: '2026-08-24T10:00:00.000Z',
            reason: currentReason,
          },
          safeSibling: { attempt: 2 },
        },
        cancel_requested_at: new Date('2026-08-24T10:00:00.000Z'),
        cancel_reason: currentReason,
      },
    ]);

    const result = await recoverStaleJobs({
      staleAfterMs: 60_000,
      maxRetries: 2,
    });

    expect(result.cancelledJobs).toEqual([
      'legacy-stale-private-cancel',
      'current-stale-generic-cancel',
    ]);
    const updateCalls = clientQueryMock.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    ) as Array<[string, unknown[]]>;
    const privateUpdate = updateCalls.find(([, params]) =>
      params[7] === 'legacy-stale-private-cancel'
    );
    const currentUpdate = updateCalls.find(([, params]) =>
      params[7] === 'current-stale-generic-cancel'
    );

    expect(privateUpdate?.[0]).toContain('WHEN $3::boolean THEN $1');
    expect(privateUpdate?.[0]).toContain('WHEN $3::boolean THEN $2');
    expect(privateUpdate?.[1]?.slice(0, 3)).toEqual([
      LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
      LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
      true,
    ]);
    const privateAutonomyState = JSON.parse(String(privateUpdate?.[1]?.[3]));
    expect(privateAutonomyState).toMatchObject({
      cancellation: {
        requested: true,
        requestedAt: '2026-08-24T10:00:00.000Z',
        reason: LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
      },
      safeSibling: { attempt: 1 },
    });
    expect(JSON.stringify(privateUpdate)).not.toContain(privateSentinel);

    expect(currentUpdate?.[1]?.slice(0, 3)).toEqual([
      currentReason,
      currentReason,
      false,
    ]);
    expect(JSON.parse(String(currentUpdate?.[1]?.[3]))).toMatchObject({
      cancellation: { reason: currentReason },
      safeSibling: { attempt: 2 },
    });
  });

  it('scrubs fail-closed stalled GPT cancellation fields while preserving current producer behavior', async () => {
    const privateSentinel = 'private-stalled-gpt-cancellation-sentinel';
    const currentReason = 'current stalled generic GPT cancellation';
    mockStaleRows([
      {
        id: 'legacy-stalled-private-cancel',
        worker_id: 'queue',
        last_worker_id: 'worker-stalled-private',
        correlation_id: null,
        claim_generation: '1',
        job_type: 'gpt',
        input: null,
        status: 'running',
        retry_count: 0,
        max_retries: 2,
        error_message: privateSentinel,
        autonomy_state: {
          cancellation: {
            requestedAt: '2026-08-24T11:00:00.000Z',
            reason: privateSentinel,
            callerDetails: privateSentinel,
          },
          safeSibling: { attempt: 3 },
        },
        cancel_requested_at: new Date('2026-08-24T11:00:00.000Z'),
        cancel_reason: privateSentinel,
      },
      {
        id: 'current-stalled-generic-cancel',
        worker_id: 'queue',
        last_worker_id: 'worker-stalled-current',
        correlation_id: null,
        claim_generation: '1',
        job_type: 'gpt',
        input: {
          producerContract: {
            version: 1,
            source: 'queued-gpt-runtime',
          },
        },
        status: 'running',
        retry_count: 0,
        max_retries: 2,
        autonomy_state: {
          cancellation: {
            requestedAt: '2026-08-24T11:00:00.000Z',
            reason: currentReason,
          },
          safeSibling: { attempt: 4 },
        },
        cancel_requested_at: new Date('2026-08-24T11:00:00.000Z'),
        cancel_reason: currentReason,
      },
    ]);

    const result = await recoverStalledJobsForWorkers({
      workerIds: ['worker-stalled-private', 'worker-stalled-current'],
      staleAfterMs: 60_000,
      maxRetries: 2,
    });

    expect(result.cancelledJobIds).toEqual([
      'legacy-stalled-private-cancel',
      'current-stalled-generic-cancel',
    ]);
    const updateCalls = clientQueryMock.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE job_data')
    ) as Array<[string, unknown[]]>;
    const privateUpdate = updateCalls.find(([, params]) =>
      params[7] === 'legacy-stalled-private-cancel'
    );
    const currentUpdate = updateCalls.find(([, params]) =>
      params[7] === 'current-stalled-generic-cancel'
    );

    expect(privateUpdate?.[0]).toContain('WHEN $3::boolean THEN $1');
    expect(privateUpdate?.[0]).toContain('WHEN $3::boolean THEN $2');
    expect(privateUpdate?.[1]?.slice(0, 3)).toEqual([
      LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
      LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
      true,
    ]);
    const privateAutonomyState = JSON.parse(String(privateUpdate?.[1]?.[3]));
    expect(privateAutonomyState).toMatchObject({
      cancellation: {
        requested: true,
        requestedAt: '2026-08-24T11:00:00.000Z',
        reason: LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
      },
      safeSibling: { attempt: 3 },
      lastRecoveryAction: 'cancelled',
    });
    expect(JSON.stringify(privateUpdate)).not.toContain(privateSentinel);

    expect(currentUpdate?.[1]?.slice(0, 3)).toEqual([
      currentReason,
      currentReason,
      false,
    ]);
    expect(JSON.parse(String(currentUpdate?.[1]?.[3]))).toMatchObject({
      cancellation: { reason: currentReason },
      safeSibling: { attempt: 4 },
      lastRecoveryAction: 'cancelled',
    });
  });

  it.each(['pending', 'running'] as const)(
    'persists only the supplied bounded cancellation reason for a %s GPT job',
    async (status) => {
      clientQueryMock.mockImplementation(async (sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM job_data')) {
          return {
            rows: [{
              id: `legacy-gpt-${status}-cancel`,
              job_type: 'gpt',
              status,
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
          return {
            rows: [{
              id: `legacy-gpt-${status}-cancel`,
              job_type: 'gpt',
              status: status === 'pending' ? 'cancelled' : 'running',
            }],
          };
        }
        return { rows: [] };
      });

      await expect(requestJobCancellation(
        `legacy-gpt-${status}-cancel`,
        LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE
      )).resolves.toEqual(expect.objectContaining({
        outcome: status === 'pending' ? 'cancelled' : 'cancellation_requested',
      }));

      const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('UPDATE job_data')
      ) as [string, unknown[]] | undefined;
      expect(updateCall?.[1]?.[0]).toBe(LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE);
      if (status === 'pending') {
        expect(updateCall?.[1]?.[1]).toBe(LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE);
      } else {
        const autonomyState = updateCall?.[1]?.[1];
        expect(typeof autonomyState === 'string' ? JSON.parse(autonomyState) : autonomyState)
          .toMatchObject({
            cancellation: {
              reason: LEGACY_QUEUED_GPT_CANCELLATION_MESSAGE,
            },
          });
      }
    }
  );

  it('stamps ask retention when pending cancellation becomes terminal', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT * FROM job_data')) {
        return {
          rows: [{
            id: 'ask-pending-cancel',
            job_type: 'ask',
            status: 'pending'
          }]
        };
      }
      if (typeof sql === 'string' && sql.includes('UPDATE job_data')) {
        return {
          rows: [{
            id: 'ask-pending-cancel',
            job_type: 'ask',
            status: 'cancelled'
          }]
        };
      }
      return { rows: [] };
    });

    try {
      await expect(requestJobCancellation('ask-pending-cancel')).resolves.toEqual(
        expect.objectContaining({ outcome: 'cancelled' })
      );
      const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('UPDATE job_data')
      ) as [string, unknown[]] | undefined;
      expect(updateCall?.[0]).toContain(
        "THEN NOW() + ($5::bigint * INTERVAL '1 millisecond')"
      );
      expect(updateCall?.[1]?.[3]).toBeNull();
      expect(updateCall?.[1]?.[4]).toBe(24 * 60 * 60 * 1_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stamps ask retention when stale recovery finalizes cancellation', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    mockStaleRows([{
      id: 'ask-stale-cancel',
      worker_id: 'queue',
      last_worker_id: 'worker-1',
      correlation_id: null,
      claim_generation: '1',
      job_type: 'ask',
      status: 'running',
      retry_count: 0,
      max_retries: 2,
      autonomy_state: {},
      cancel_requested_at: new Date('2026-08-01T11:59:00.000Z'),
      cancel_reason: 'cancelled'
    }]);

    try {
      await recoverStaleJobs({ staleAfterMs: 60_000, maxRetries: 2 });
      const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('UPDATE job_data')
      ) as [string, unknown[]] | undefined;
      expect(updateCall?.[0]).toContain(
        "THEN NOW() + ($7::bigint * INTERVAL '1 millisecond')"
      );
      expect(updateCall?.[1]?.[5]).toBeNull();
      expect(updateCall?.[1]?.[6]).toBe(24 * 60 * 60 * 1_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stamps DAG-node retention when stalled-worker recovery finalizes cancellation', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (
        typeof sql === 'string' &&
        sql.includes('FROM job_data') &&
        sql.includes('last_worker_id = ANY')
      ) {
        return {
          rows: [{
            id: 'dag-stalled-cancel',
            worker_id: 'queue',
            last_worker_id: 'worker-2',
            correlation_id: null,
            claim_generation: '2',
            job_type: 'dag-node',
            status: 'running',
            retry_count: 0,
            max_retries: 2,
            autonomy_state: {},
            cancel_requested_at: new Date('2026-08-01T11:59:00.000Z'),
            cancel_reason: 'cancelled'
          }]
        };
      }
      return { rows: [] };
    });

    try {
      await recoverStalledJobsForWorkers({
        workerIds: ['worker-2'],
        staleAfterMs: 60_000,
        maxRetries: 2
      });
      const updateCall = clientQueryMock.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('UPDATE job_data')
      ) as [string, unknown[]] | undefined;
      expect(updateCall?.[0]).toContain(
        "THEN NOW() + ($7::bigint * INTERVAL '1 millisecond')"
      );
      expect(updateCall?.[1]?.[5]).toBeNull();
      expect(updateCall?.[1]?.[6]).toBe(60 * 60 * 1_000);
    } finally {
      jest.useRealTimers();
    }
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

  it('flushes stalled-worker recovery events once after commit succeeds', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (
        typeof sql === 'string' &&
        sql.includes('FROM job_data') &&
        sql.includes('last_worker_id = ANY')
      ) {
        return {
          rows: [
            {
              id: 'job-stalled-post-commit',
              worker_id: 'worker-2',
              last_worker_id: 'worker-2',
              correlation_id: 'trace-2',
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

      return { rows: [] };
    });

    const result = await recoverStalledJobsForWorkers({
      workerIds: ['worker-2'],
      staleAfterMs: 60_000,
      maxRetries: 2,
      stalledJobAction: 'requeue'
    });

    const commitOrder = clientQueryMock.mock.invocationCallOrder[
      clientQueryMock.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
    ];
    const firstEventOrder = queryMock.mock.invocationCallOrder[0];

    expect(result).toEqual({
      staleWorkerIds: ['worker-2'],
      stalledJobIds: ['job-stalled-post-commit'],
      requeuedJobIds: ['job-stalled-post-commit'],
      deadLetterJobIds: [],
      cancelledJobIds: []
    });
    expect(commitOrder).toBeLessThan(firstEventOrder);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('does not emit stalled-worker recovery events when the transaction rolls back', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (
        typeof sql === 'string' &&
        sql.includes('FROM job_data') &&
        sql.includes('last_worker_id = ANY')
      ) {
        return {
          rows: [
            {
              id: 'job-stalled-rollback',
              worker_id: 'worker-3',
              last_worker_id: 'worker-3',
              correlation_id: 'trace-3',
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

    await expect(recoverStalledJobsForWorkers({
      workerIds: ['worker-3'],
      staleAfterMs: 60_000,
      maxRetries: 2,
      stalledJobAction: 'requeue'
    })).rejects.toThrow('commit failed');

    expect(queryMock).not.toHaveBeenCalled();
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('does not duplicate stalled-worker recovery events across concurrent recovery attempts', async () => {
    const firstClientQueryMock = jest.fn(async (sql: unknown) => {
      if (
        typeof sql === 'string' &&
        sql.includes('FROM job_data') &&
        sql.includes('last_worker_id = ANY')
      ) {
        return {
          rows: [
            {
              id: 'job-stalled-concurrent',
              worker_id: 'worker-4',
              last_worker_id: 'worker-4',
              correlation_id: 'trace-4',
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

      return { rows: [] };
    });
    const secondClientQueryMock = jest.fn(async () => ({ rows: [] }));

    poolConnectMock
      .mockResolvedValueOnce({
        query: firstClientQueryMock,
        release: clientReleaseMock
      })
      .mockResolvedValueOnce({
        query: secondClientQueryMock,
        release: clientReleaseMock
      });

    const [firstResult, secondResult] = await Promise.all([
      recoverStalledJobsForWorkers({
        workerIds: ['worker-4'],
        staleAfterMs: 60_000,
        maxRetries: 2,
        stalledJobAction: 'requeue'
      }),
      recoverStalledJobsForWorkers({
        workerIds: ['worker-4'],
        staleAfterMs: 60_000,
        maxRetries: 2,
        stalledJobAction: 'requeue'
      })
    ]);

    expect(firstResult.stalledJobIds).toEqual(['job-stalled-concurrent']);
    expect(secondResult.stalledJobIds).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('does not roll back stalled-worker recovery when job event insert fails', async () => {
    queryMock.mockRejectedValue(new Error('job event insert failed'));
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (
        typeof sql === 'string' &&
        sql.includes('FROM job_data') &&
        sql.includes('last_worker_id = ANY')
      ) {
        return {
          rows: [
            {
              id: 'job-stalled-telemetry-failure',
              worker_id: 'worker-5',
              last_worker_id: 'worker-5',
              correlation_id: 'trace-5',
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

      return { rows: [] };
    });

    const result = await recoverStalledJobsForWorkers({
      workerIds: ['worker-5'],
      staleAfterMs: 60_000,
      maxRetries: 2,
      stalledJobAction: 'requeue'
    });

    expect(result.requeuedJobIds).toEqual(['job-stalled-telemetry-failure']);
    expect(clientQueryMock).toHaveBeenCalledWith('COMMIT');
    expect(clientQueryMock).not.toHaveBeenCalledWith('ROLLBACK');
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
