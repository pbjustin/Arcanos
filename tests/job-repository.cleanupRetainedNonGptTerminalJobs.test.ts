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
  inspectLegacyNullNonGptTerminalJobs,
  resolveNonGptTerminalCleanupObservationWindowMs
} = await import('../src/core/db/repositories/jobRepository.js');

describe('jobRepository.cleanupRetainedNonGptTerminalJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [
        { id: 'ask-completed-old', job_type: 'ask', status: 'completed' },
        { id: 'dag-cancelled-old', job_type: 'dag-node', status: 'cancelled' },
        {
          id: 'partition-sync-completed-old',
          job_type: 'backstage-notion-partition-sync',
          status: 'completed'
        }
      ]
    });
  });

  it('deletes one deterministic bounded allowlisted batch', async () => {
    const result = await cleanupRetainedNonGptTerminalJobs({ batchSize: 3 });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain(
      "job_type IN ('ask', 'dag-node', 'backstage-notion-partition-sync')"
    );
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
      3,
      MIN_NON_GPT_TERMINAL_CLEANUP_OBSERVATION_WINDOW_MS
    ]);
    expect(result).toEqual({
      batchSize: 3,
      deletedTerminal: 3,
      deletedAsk: 1,
      deletedDagNode: 1,
      deletedBackstageNotionPartitionSync: 1,
      deletedCompleted: 2,
      deletedCancelled: 1,
      deletedJobIds: [
        'ask-completed-old',
        'dag-cancelled-old',
        'partition-sync-completed-old'
      ]
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

  it('inventories only a bounded aggregate sample of protected legacy-null rows', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { job_type: 'ask', status: 'completed', observed_count: 2 },
        { job_type: 'dag-node', status: 'cancelled', observed_count: 1 },
        { job_type: 'gpt', status: 'completed', observed_count: 99 },
        { job_type: 'ask', status: 'failed', observed_count: 99 },
        { job_type: 'ask', status: 'cancelled', observed_count: 'invalid' }
      ]
    });

    const result = await inspectLegacyNullNonGptTerminalJobs({ sampleLimit: 3 });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("job_type IN ('ask', 'dag-node')");
    expect(sql).toContain("status IN ('completed', 'cancelled')");
    expect(sql).toContain('retention_until IS NULL');
    expect(sql).not.toContain('SELECT id');
    expect(sql).not.toContain('DELETE FROM');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([3]);
    expect(result).toEqual({
      sampleLimit: 3,
      observedTerminal: 3,
      observedAsk: 2,
      observedDagNode: 1,
      observedCompleted: 2,
      observedCancelled: 1,
      sampleLimitReached: true
    });
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
      deletedBackstageNotionPartitionSync: 0,
      deletedCompleted: 0,
      deletedCancelled: 0,
      deletedJobIds: []
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns an empty protected-row inventory when the database is unavailable', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);

    await expect(
      inspectLegacyNullNonGptTerminalJobs({ sampleLimit: 20 })
    ).resolves.toEqual({
      sampleLimit: 20,
      observedTerminal: 0,
      observedAsk: 0,
      observedDagNode: 0,
      observedCompleted: 0,
      observedCancelled: 0,
      sampleLimitReached: false
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
