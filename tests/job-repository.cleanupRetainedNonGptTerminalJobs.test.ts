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
  DEFAULT_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE,
  MAX_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE,
  MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS,
  cleanupRetainedNonGptTerminalJobs,
  resolveNonGptTerminalCleanupObservationWindowMs
} = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.cleanupRetainedNonGptTerminalJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [
        { id: 'ask-completed-old', job_type: 'ask', status: 'completed' },
        { id: 'dag-cancelled-old', job_type: 'dag-node', status: 'cancelled' }
      ]
    });
  });

  it('deletes one deterministic bounded allowlisted batch', async () => {
    const result = await cleanupRetainedNonGptTerminalJobs({ batchSize: 2 });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("job_type IN ('ask', 'dag-node')");
    expect(sql).toContain("status IN ('completed', 'cancelled')");
    expect(sql).not.toContain("job_type <> 'gpt'");
    expect(sql).not.toContain("job_type <> 'local-agent'");
    expect(sql).toContain('retention_until IS NOT NULL');
    expect(sql).toContain('retention_until <= NOW()');
    expect(sql).toContain(
      "updated_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')"
    );
    expect(sql).toContain('idempotency_until IS NULL');
    expect(sql).toContain('idempotency_until <= NOW()');
    expect(sql).toContain(
      'ORDER BY retention_until ASC, completed_at ASC NULLS LAST, created_at ASC, id ASC'
    );
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([
      2,
      MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS
    ]);
    expect(result).toEqual({
      batchSize: 2,
      deletedTerminal: 2,
      deletedAsk: 1,
      deletedDagNode: 1,
      deletedCompleted: 1,
      deletedCancelled: 1,
      deletedJobIds: ['ask-completed-old', 'dag-cancelled-old']
    });
  });

  it('clamps invalid and oversized batches', async () => {
    await cleanupRetainedNonGptTerminalJobs({ batchSize: Number.NaN });
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      DEFAULT_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE,
      MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS
    ]);

    await cleanupRetainedNonGptTerminalJobs({ batchSize: 100_000 });
    expect(queryMock.mock.calls[1]?.[1]).toEqual([
      MAX_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE,
      MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS
    ]);
  });

  it('protects the worker-budget hour and any longer diagnostics window', () => {
    expect(resolveNonGptTerminalCleanupObservationWindowMs({
      QUEUE_DIAGNOSTICS_FAILURE_WINDOW_MS: '60000'
    } as NodeJS.ProcessEnv)).toBe(
      MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS
    );
    expect(resolveNonGptTerminalCleanupObservationWindowMs({
      QUEUE_DIAGNOSTICS_FAILURE_WINDOW_MS: String(6 * 60 * 60 * 1_000)
    } as NodeJS.ProcessEnv)).toBe(6 * 60 * 60 * 1_000);
  });

  it('protects every row when the database is unavailable', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);

    await expect(
      cleanupRetainedNonGptTerminalJobs({ batchSize: 20 })
    ).resolves.toEqual({
      batchSize: 20,
      deletedTerminal: 0,
      deletedAsk: 0,
      deletedDagNode: 0,
      deletedCompleted: 0,
      deletedCancelled: 0,
      deletedJobIds: []
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
