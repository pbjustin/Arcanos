import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const repositoryRecordLivenessMock = jest.fn();
const repositoryUpsertStateMock = jest.fn();
const repositoryAppendHistoryMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const recordWorkerLivenessWriteMock = jest.fn();
const recordWorkerRuntimeStateWriteMock = jest.fn();
const recordWorkerRuntimeHistoryWriteMock = jest.fn();
const recordWorkerRuntimeSnapshotSkippedMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/workerRuntimeRepository.js', () => ({
  recordWorkerLiveness: repositoryRecordLivenessMock,
  upsertWorkerRuntimeState: repositoryUpsertStateMock,
  appendWorkerRuntimeHistory: repositoryAppendHistoryMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock
  }
}));

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordWorkerLivenessWrite: recordWorkerLivenessWriteMock,
  recordWorkerRuntimeStateWrite: recordWorkerRuntimeStateWriteMock,
  recordWorkerRuntimeHistoryWrite: recordWorkerRuntimeHistoryWriteMock,
  recordWorkerRuntimeSnapshotSkipped: recordWorkerRuntimeSnapshotSkippedMock
}));

const {
  WorkerRuntimeSnapshotPipeline,
  buildWorkerRuntimeSnapshotStateHash
} = await import('../src/services/workerRuntimeSnapshotPipeline.js');

function buildSnapshot(overrides: Partial<{
  workerId: string;
  healthStatus: string;
  currentJobId: string | null;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  source: string;
  processedJobs: number;
}> = {}) {
  const source = overrides.source ?? 'worker-heartbeat';
  return {
    workerId: overrides.workerId ?? 'async-queue-slot-1',
    workerType: 'async_queue',
    healthStatus: overrides.healthStatus ?? 'healthy',
    currentJobId: overrides.currentJobId ?? null,
    lastError: overrides.lastError ?? null,
    startedAt: '2026-04-23T20:00:00.000Z',
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? '2026-04-23T20:00:30.000Z',
    lastInspectorRunAt: null,
    updatedAt: '2026-04-23T20:00:30.000Z',
    snapshot: {
      activeJobs: overrides.currentJobId ? [overrides.currentJobId] : [],
      queueSummary: {
        pending: 0,
        running: 0,
        lastUpdatedAt: '2026-04-23T20:00:30.000Z',
        oldestPendingJobAgeMs: 0
      },
      processedJobs: overrides.processedJobs ?? 0,
      watchdog: {
        triggered: false,
        inactivityMs: 30_000,
        lastHeartbeatAt: overrides.lastHeartbeatAt ?? '2026-04-23T20:00:30.000Z'
      },
      lastPersistSource: source,
      alerts: []
    }
  };
}

describe('WorkerRuntimeSnapshotPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repositoryRecordLivenessMock.mockResolvedValue(undefined);
    repositoryUpsertStateMock.mockResolvedValue(undefined);
    repositoryAppendHistoryMock.mockResolvedValue(undefined);
  });

  it('records heartbeat liveness without forcing rich snapshot persistence', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 0 });

    await pipeline.recordLiveness('async-queue-slot-1', 'healthy', '2026-04-23T20:00:30.000Z');

    expect(repositoryRecordLivenessMock).toHaveBeenCalledWith({
      workerId: 'async-queue-slot-1',
      healthStatus: 'healthy',
      lastSeenAt: '2026-04-23T20:00:30.000Z'
    });
    expect(repositoryUpsertStateMock).not.toHaveBeenCalled();
    expect(repositoryAppendHistoryMock).not.toHaveBeenCalled();
  });

  it('coalesces worker-heartbeat and worker-idle intents for the same state', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const heartbeatSnapshot = buildSnapshot({ source: 'worker-heartbeat' });
    const idleSnapshot = buildSnapshot({ source: 'worker-idle' });

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-heartbeat', heartbeatSnapshot);
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-idle', idleSnapshot);
    await pipeline.flushAll('test');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(1);
    expect(repositoryUpsertStateMock).toHaveBeenCalledWith(
      idleSnapshot,
      expect.objectContaining({
        source: 'worker-idle',
        preserveLegacySnapshot: true
      })
    );
  });

  it('skips no-op healthy snapshots after the first meaningful write', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const snapshot = buildSnapshot();

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-heartbeat', snapshot);
    await pipeline.flushAll('first');
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-heartbeat', buildSnapshot({
      source: 'worker-heartbeat',
      lastHeartbeatAt: '2026-04-23T20:01:00.000Z'
    }));
    await pipeline.flushAll('second');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(1);
    expect(recordWorkerRuntimeSnapshotSkippedMock).toHaveBeenCalledWith({
      source: 'worker-heartbeat',
      healthStatus: 'healthy'
    });
  });

  it('persists meaningful state changes', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-heartbeat', buildSnapshot());
    await pipeline.flushAll('first');
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'job-start', buildSnapshot({
      source: 'job-start',
      currentJobId: 'job-1'
    }));
    await pipeline.flushAll('second');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(2);
    expect(repositoryUpsertStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentJobId: 'job-1'
      }),
      expect.objectContaining({
        source: 'job-start'
      })
    );
  });

  it('writes history only for meaningful changes', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-heartbeat', buildSnapshot());
    await pipeline.flushAll('first');
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-heartbeat', buildSnapshot({
      lastHeartbeatAt: '2026-04-23T20:01:00.000Z'
    }));
    await pipeline.flushAll('noop');
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'job-completed', buildSnapshot({
      source: 'job-completed',
      processedJobs: 1
    }));
    await pipeline.flushAll('meaningful');

    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(2);
    expect(repositoryAppendHistoryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          processedJobs: 1
        })
      }),
      expect.objectContaining({
        source: 'job-completed'
      })
    );
  });

  it('flushes pending state safely on shutdown', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-idle', buildSnapshot({
      source: 'worker-idle'
    }));
    await pipeline.shutdown('test-shutdown');
    await pipeline.shutdown('test-shutdown-again');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(1);
  });

  it('builds stable hashes that ignore heartbeat-only fields', () => {
    const firstHash = buildWorkerRuntimeSnapshotStateHash(buildSnapshot({
      lastHeartbeatAt: '2026-04-23T20:00:30.000Z'
    }));
    const secondHash = buildWorkerRuntimeSnapshotStateHash(buildSnapshot({
      lastHeartbeatAt: '2026-04-23T20:01:00.000Z'
    }));
    const changedHash = buildWorkerRuntimeSnapshotStateHash(buildSnapshot({
      currentJobId: 'job-1'
    }));

    expect(firstHash).toBe(secondHash);
    expect(changedHash).not.toBe(firstHash);
  });
});
