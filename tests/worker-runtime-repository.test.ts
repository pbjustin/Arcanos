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
  listWorkerLiveness,
  upsertWorkerRuntimeSnapshot
} = await import('../src/core/db/repositories/workerRuntimeRepository.js');

describe('workerRuntimeRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('logs runtime snapshot upsert failures with a failed event name', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection timeout'));

    await expect(
      upsertWorkerRuntimeSnapshot(
        {
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
        },
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
});
