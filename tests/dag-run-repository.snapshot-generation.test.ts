import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const queryMock = jest.fn();
const pool = {};

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => pool,
  initializeDatabase: jest.fn(async () => true),
  isDatabaseConnected: () => true
}));

jest.unstable_mockModule('@core/db/schema.js', () => ({
  initializeTables: jest.fn(async () => true),
  isDatabaseSchemaReady: () => true
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

const {
  getDagRunSnapshotById,
  getLatestDagRunSnapshot,
  normalizeDagSnapshotGeneration,
  upsertDagRunSnapshot
} = await import(
  '../src/core/db/repositories/dagRunRepository.js'
);

function snapshotRecord(snapshotGeneration = '1') {
  return {
    runId: 'dag-run-1',
    sessionId: 'session-1',
    template: 'trinity-core',
    status: 'queued',
    snapshotGeneration,
    plannerNodeId: 'planner',
    rootNodeId: 'writer',
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    snapshot: {
      runId: 'dag-run-1',
      status: 'queued'
    }
  };
}

function persistedRow(snapshotGeneration: unknown = '7') {
  return {
    run_id: 'dag-run-1',
    session_id: 'session-1',
    template: 'trinity-core',
    status: 'running',
    snapshot_generation: snapshotGeneration,
    planner_node_id: 'planner',
    root_node_id: 'writer',
    created_at: '2026-07-27T12:00:00.000Z',
    updated_at: '2026-07-27T12:00:01.000Z',
    snapshot: {
      runId: 'dag-run-1',
      status: 'running'
    }
  };
}

describe('DAG snapshot generation repository fencing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts only canonical PostgreSQL BIGINT decimal strings', () => {
    expect(normalizeDagSnapshotGeneration('0')).toBe('0');
    expect(normalizeDagSnapshotGeneration('9223372036854775807')).toBe(
      '9223372036854775807'
    );

    for (const value of [
      1,
      '-1',
      '01',
      '1.0',
      '9223372036854775808',
      '9'.repeat(10_000)
    ]) {
      expect(() => normalizeDagSnapshotGeneration(value)).toThrow();
    }
  });

  it('applies only a higher generation and returns the RETURNING outcome', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ run_id: 'dag-run-1' }],
      rowCount: 1
    });

    await expect(upsertDagRunSnapshot(snapshotRecord('2'))).resolves.toBe(
      true
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('$7::bigint');
    expect(sql).toContain(
      'WHERE dag_runs.snapshot_generation < EXCLUDED.snapshot_generation'
    );
    expect(sql).toContain('RETURNING run_id');
    expect(values[6]).toBe('2');
    expect(values).toHaveLength(10);

    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(upsertDagRunSnapshot(snapshotRecord('2'))).resolves.toBe(
      false
    );
  });

  it('rejects invalid generations before issuing persistence SQL', async () => {
    await expect(
      upsertDagRunSnapshot(snapshotRecord('01'))
    ).rejects.toThrow('canonical non-negative decimal string');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns canonical generation strings from direct and latest reads', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [persistedRow('7')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [persistedRow('8')], rowCount: 1 });

    await expect(getDagRunSnapshotById('dag-run-1')).resolves.toEqual(
      expect.objectContaining({
        runId: 'dag-run-1',
        snapshotGeneration: '7'
      })
    );
    await expect(getLatestDagRunSnapshot()).resolves.toEqual(
      expect.objectContaining({
        runId: 'dag-run-1',
        snapshotGeneration: '8'
      })
    );

    expect(queryMock.mock.calls[0][0]).toContain(
      'snapshot_generation::text AS snapshot_generation'
    );
    expect(queryMock.mock.calls[1][0]).toContain(
      'snapshot_generation::text AS snapshot_generation'
    );
  });

  it('fails closed on a noncanonical persisted generation', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [persistedRow(7)],
      rowCount: 1
    });

    await expect(getDagRunSnapshotById('dag-run-1')).resolves.toBeNull();
  });
});
