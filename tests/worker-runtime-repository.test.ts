import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const initializeDatabaseMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const initializeTablesMock = jest.fn();
const queryMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  initializeDatabase: initializeDatabaseMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('@core/db/schema.js', () => ({
  initializeTables: initializeTablesMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    debug: loggerDebugMock,
    warn: loggerWarnMock
  }
}));

const {
  listWorkerRuntimeStateSnapshots,
  listWorkerLiveness,
  recordWorkerLiveness,
  upsertWorkerRuntimeState,
  upsertWorkerRuntimeSnapshot
} = await import('../src/core/db/repositories/workerRuntimeRepository.js');

function buildSnapshotRecord() {
  return {
    workerId: 'async-queue-1',
    workerType: 'async_queue',
    healthStatus: 'healthy',
    currentJobId: null,
    lastError: null,
    startedAt: '2026-04-23T01:00:00.000Z',
    lastHeartbeatAt: '2026-04-23T01:00:10.000Z',
    lastInspectorRunAt: '2026-04-23T01:00:20.000Z',
    updatedAt: '2026-04-23T01:00:30.000Z',
    snapshot: {
      lastPersistSource: 'worker-heartbeat'
    }
  };
}

describe('workerRuntimeRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('initializes worker runtime tables once even when the database is already connected', async () => {
    await recordWorkerLiveness({
      workerId: 'async-queue-1',
      healthStatus: 'healthy',
      lastSeenAt: '2026-04-23T01:00:30.000Z'
    });

    expect(initializeDatabaseMock).not.toHaveBeenCalled();
    expect(initializeTablesMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('worker_liveness'),
      [
        'async-queue-1',
        '2026-04-23T01:00:30.000Z',
        'healthy'
      ],
      1,
      false,
      expect.objectContaining({
        queryName: 'worker_liveness_upsert',
        workerId: 'async-queue-1'
      })
    );
  });

  it('logs runtime snapshot upsert failures with a failed event name', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection timeout'));

    await expect(
      upsertWorkerRuntimeSnapshot(
        buildSnapshotRecord(),
        { source: 'worker-heartbeat' }
      )
    ).rejects.toThrow('connection timeout');

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.runtime_snapshot.upsert.failed',
      expect.objectContaining({
        module: 'worker-runtime',
        workerId: 'async-queue-1',
        source: 'worker-heartbeat',
        outcome: 'error',
        durationMs: expect.any(Number),
        snapshotBytes: expect.any(Number)
      })
    );
  });

  it('labels slow liveness upserts as repository wall-clock timing', async () => {
    const timestamps = [1_000, 1_010, 1_010, 1_310, 1_310, 1_310];
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => timestamps.shift() ?? 1_310);

    try {
      await recordWorkerLiveness({
        workerId: 'async-queue-1',
        healthStatus: 'healthy',
        lastSeenAt: '2026-04-23T01:00:30.000Z'
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.liveness.upsert.app_slow',
      expect.objectContaining({
        module: 'worker-runtime',
        workerId: 'async-queue-1',
        healthStatus: 'healthy',
        durationKind: 'repository_wall_clock',
        measurementKind: 'repository_wall_clock',
        slowThresholdMs: 250,
        totalWallMs: expect.any(Number),
        persistenceReadyMs: expect.any(Number),
        queryCallWallMs: expect.any(Number),
        dbQueryName: 'worker_liveness_upsert'
      })
    );
    expect(loggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('sql');
    expect(loggerWarnMock.mock.calls[0]?.[1]).not.toHaveProperty('params');
  });

  it('measures failed liveness query duration from query start', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection timeout'));
    const timestamps = [2_000, 2_010, 2_010, 2_060, 2_060];
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => timestamps.shift() ?? 2_060);

    try {
      await expect(recordWorkerLiveness({
        workerId: 'async-queue-1',
        healthStatus: 'healthy',
        lastSeenAt: '2026-04-23T01:00:30.000Z'
      })).rejects.toThrow('connection timeout');
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.liveness.upsert.failed',
      expect.objectContaining({
        outcome: 'error',
        totalWallMs: 60,
        persistenceReadyMs: 10,
        queryCallWallMs: 50,
        dbQueryName: 'worker_liveness_upsert'
      })
    );
  });

  it('persists V2 state and legacy compatibility snapshot atomically in one query', async () => {
    await upsertWorkerRuntimeState(
      buildSnapshotRecord(),
      {
        source: 'worker-idle',
        stateHash: 'state-hash-1',
        preserveLegacySnapshot: true
      }
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('WITH state_upsert AS'),
      expect.any(Array),
      1,
      false,
      expect.objectContaining({
        queryName: 'worker_runtime_state_with_legacy_upsert',
        workerId: 'async-queue-1',
        source: 'worker-idle'
      })
    );
    expect(queryMock.mock.calls[0][0]).toContain('worker_runtime_state');
    expect(queryMock.mock.calls[0][0]).toContain('worker_runtime_snapshots');
  });

  it('can persist only V2 state when legacy compatibility preservation is disabled', async () => {
    await upsertWorkerRuntimeState(
      buildSnapshotRecord(),
      {
        source: 'worker-idle',
        stateHash: 'state-hash-1',
        preserveLegacySnapshot: false
      }
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('worker_runtime_state');
    expect(queryMock.mock.calls[0][0]).not.toContain('worker_runtime_snapshots');
  });

  it('degrades liveness reads to empty when the V2 table is not migrated yet', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('relation "worker_liveness" does not exist'), {
      code: '42P01'
    }));

    await expect(listWorkerLiveness()).resolves.toEqual([]);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      'worker.liveness.list.unavailable',
      expect.objectContaining({
        module: 'worker-runtime',
        reason: 'missing_table'
      })
    );
  });

  it('degrades V2 state reads to empty when the V2 table is not migrated yet', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('relation "worker_runtime_state" does not exist'), {
      code: '42P01'
    }));

    await expect(listWorkerRuntimeStateSnapshots()).resolves.toEqual([]);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      'worker.runtime_state.list.unavailable',
      expect.objectContaining({
        module: 'worker-runtime',
        reason: 'missing_table'
      })
    );
  });

});
