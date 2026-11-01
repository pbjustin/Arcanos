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
  buildWorkerRuntimeSnapshotStateHash,
  isWorkerSnapshotPipelineV2Enabled,
  normalizeWorkerRuntimeSnapshotForHash
} = await import('../src/services/workerRuntimeSnapshotPipeline.js');

function buildSnapshot(overrides: Partial<{
  workerId: string;
  healthStatus: string;
  currentJobId: string | null;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  lastPollAt: string | null;
  lastClaimAttemptAt: string | null;
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
      lastPollAt: overrides.lastPollAt ?? null,
      lastClaimAttemptAt: overrides.lastClaimAttemptAt ?? null,
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

  it('defaults the V2 pipeline on unless explicitly disabled', () => {
    expect(isWorkerSnapshotPipelineV2Enabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isWorkerSnapshotPipelineV2Enabled({
      WORKER_SNAPSHOT_PIPELINE_V2: 'false'
    } as NodeJS.ProcessEnv)).toBe(false);
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

  it('ignores poll and claim timestamps across diagnostic bucket boundaries', () => {
    const firstHash = buildWorkerRuntimeSnapshotStateHash(buildSnapshot({
      lastPollAt: '2026-04-23T20:00:05.000Z',
      lastClaimAttemptAt: '2026-04-23T20:00:05.000Z'
    }));
    const sameBucketHash = buildWorkerRuntimeSnapshotStateHash(buildSnapshot({
      lastPollAt: '2026-04-23T20:00:25.000Z',
      lastClaimAttemptAt: '2026-04-23T20:00:25.000Z'
    }));
    const nextBucketHash = buildWorkerRuntimeSnapshotStateHash(buildSnapshot({
      lastPollAt: '2026-04-23T20:00:35.000Z',
      lastClaimAttemptAt: '2026-04-23T20:00:35.000Z'
    }));

    expect(firstHash).toBe(sameBucketHash);
    expect(firstHash).toBe(nextBucketHash);
  });

  it('keeps state and history stable through three hours of healthy idle polling while liveness advances', async () => {
    const startMs = Date.parse('2026-10-31T00:00:00.000Z');
    let nowMs = startMs;
    // Controlled adapter costs quantify avoided client calls, not PostgreSQL execution.
    let simulatedClientRoundTripMs = 0;
    repositoryRecordLivenessMock.mockImplementation(async () => {
      simulatedClientRoundTripMs += 10;
    });
    repositoryUpsertStateMock.mockImplementation(async () => {
      simulatedClientRoundTripMs += 40;
    });
    repositoryAppendHistoryMock.mockImplementation(async () => {
      simulatedClientRoundTripMs += 20;
    });
    const pipeline = new WorkerRuntimeSnapshotPipeline({
      coalesceMs: 10_000,
      dependencies: { nowMs: () => nowMs }
    });

    for (let elapsedMs = 0; elapsedMs <= 3 * 60 * 60 * 1_000; elapsedMs += 5_000) {
      nowMs = startMs + elapsedMs;
      const observedAt = new Date(nowMs).toISOString();
      const snapshot = buildSnapshot({
        lastHeartbeatAt: observedAt,
        lastPollAt: observedAt,
        lastClaimAttemptAt: observedAt,
        source: 'worker-idle'
      });
      await pipeline.recordLiveness(snapshot.workerId, 'healthy', observedAt);
      pipeline.recordSnapshotIntent(snapshot.workerId, 'worker-idle', snapshot);
      await pipeline.flushAll('idle-poll');
    }

    expect({
      livenessWrites: repositoryRecordLivenessMock.mock.calls.length,
      stateWithLegacyWrites: repositoryUpsertStateMock.mock.calls.length,
      historyWrites: repositoryAppendHistoryMock.mock.calls.length,
      simulatedClientRoundTripMs
    }).toEqual({
      livenessWrites: 2_161,
      stateWithLegacyWrites: 1,
      historyWrites: 1,
      simulatedClientRoundTripMs: 21_670
    });
    expect(repositoryRecordLivenessMock).toHaveBeenLastCalledWith({
      workerId: 'async-queue-slot-1',
      healthStatus: 'healthy',
      lastSeenAt: '2026-10-31T03:00:00.000Z'
    });
    expect(repositoryUpsertStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preserveLegacySnapshot: true })
    );
  });

  it('persists degraded, recovered, and restarted worker states after timestamp-only polls', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const healthy = buildSnapshot({ lastPollAt: '2026-10-31T00:00:00.000Z' });
    const degraded = buildSnapshot({ healthStatus: 'degraded', lastError: 'dependency unavailable' });
    const restarted = { ...healthy, startedAt: '2026-10-31T03:01:00.000Z' };

    for (const [source, snapshot] of [
      ['worker-idle', healthy],
      ['worker-idle', buildSnapshot({ lastPollAt: '2026-10-31T03:00:00.000Z' })],
      ['dependency-failure', degraded],
      ['dependency-recovered', healthy],
      ['bootstrap', restarted]
    ] as const) {
      pipeline.recordSnapshotIntent(snapshot.workerId, source, snapshot);
      await pipeline.flushAll(source);
    }

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(4);
    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(4);
    expect(repositoryUpsertStateMock).toHaveBeenNthCalledWith(
      2, degraded, expect.objectContaining({ source: 'dependency-failure' })
    );
    expect(repositoryUpsertStateMock).toHaveBeenNthCalledWith(
      3, healthy, expect.objectContaining({ source: 'dependency-recovered' })
    );
    expect(repositoryUpsertStateMock).toHaveBeenLastCalledWith(
      restarted, expect.objectContaining({ source: 'bootstrap' })
    );
  });

  it('retries failed state persistence on the next identical idle observation', async () => {
    repositoryUpsertStateMock.mockRejectedValueOnce(new Error('database unavailable'));
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = buildSnapshot();
      pipeline.recordSnapshotIntent(snapshot.workerId, 'worker-idle', snapshot);
      await pipeline.flushAll('retry');
    }

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(2);
    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.snapshot_pipeline.state.failed',
      expect.objectContaining({ error: 'database unavailable' })
    );
  });

  it('retries failed history on the next identical observation, then resumes idle write suppression', async () => {
    repositoryAppendHistoryMock.mockRejectedValueOnce(new Error('history unavailable'));
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const snapshot = buildSnapshot();

    for (let observation = 0; observation < 3; observation += 1) {
      pipeline.recordSnapshotIntent(snapshot.workerId, 'worker-idle', snapshot);
      await pipeline.flushAll('history-retry');
    }

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(2);
    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(2);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.snapshot_pipeline.history.failed',
      expect.objectContaining({ error: 'history unavailable' })
    );
  });

  it('does not invalidate a newer persisted state after an older history write fails late', async () => {
    let failHistory!: (error: Error) => void;
    repositoryAppendHistoryMock.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failHistory = reject;
    }));
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const first = buildSnapshot();
    const newer = buildSnapshot({ currentJobId: 'job-1' });

    try {
      pipeline.recordSnapshotIntent(first.workerId, 'worker-idle', first);
      await pipeline.flushWorker(first.workerId, 'first');
      pipeline.recordSnapshotIntent(newer.workerId, 'job-start', newer);
      await pipeline.flushWorker(newer.workerId, 'newer');
    } finally {
      failHistory(new Error('late history failure'));
      await pipeline.flushAll('drain');
    }
    pipeline.recordSnapshotIntent(newer.workerId, 'job-start', newer);
    await pipeline.flushAll('unchanged');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(2);
    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(2);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.snapshot_pipeline.history.failed',
      expect.objectContaining({ source: 'worker-idle', error: 'late history failure' })
    );
  });

  it('keeps a newer successful A state cached when an older A history fails after A-B-A transitions', async () => {
    let failHistory!: (error: Error) => void;
    repositoryAppendHistoryMock.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failHistory = reject;
    }));
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const first = buildSnapshot();
    const changed = buildSnapshot({ currentJobId: 'job-1' });

    try {
      for (const snapshot of [first, changed, first]) {
        pipeline.recordSnapshotIntent(snapshot.workerId, 'transition', snapshot);
        await pipeline.flushWorker(snapshot.workerId, 'transition');
      }
    } finally {
      failHistory(new Error('obsolete A history failure'));
      await pipeline.flushAll('drain');
    }
    pipeline.recordSnapshotIntent(first.workerId, 'worker-idle', first);
    await pipeline.flushAll('unchanged-newer-A');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(3);
    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(3);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'worker.snapshot_pipeline.history.failed',
      expect.objectContaining({ error: 'obsolete A history failure' })
    );
  });

  it('normalizes volatile inspector, watchdog, queue, and stats observations out of the state hash', () => {
    const baseline = buildSnapshot({ source: 'inspector' });
    const volatileOnly = {
      ...baseline,
      lastHeartbeatAt: '2026-04-23T20:04:30.000Z',
      lastInspectorRunAt: '2026-04-23T20:04:30.000Z',
      updatedAt: '2026-04-23T20:04:30.000Z',
      snapshot: {
        ...baseline.snapshot,
        queueSummary: {
          ...baseline.snapshot.queueSummary,
          pending: 12,
          running: 3,
          lastUpdatedAt: '2026-04-23T20:04:30.000Z',
          oldestPendingJobAgeMs: 240_000
        },
        stats: {
          completed: 20,
          failed: 1,
          running: 3,
          totalTerminal: 21,
          aiCalls: 18
        },
        lastActivityAt: '2026-04-23T20:04:20.000Z',
        lastProcessedJobAt: '2026-04-23T20:03:00.000Z',
        lastWatchdogRunAt: '2026-04-23T20:04:25.000Z',
        lastRecoveryActionAt: '2026-04-23T20:02:00.000Z',
        maxObservedQueueDepth: 12,
        alerts: ['No worker activity for 240000ms while queue work remained pending.'],
        watchdog: {
          ...baseline.snapshot.watchdog,
          inactivityMs: 240_000,
          lastHeartbeatAt: '2026-04-23T20:04:30.000Z',
          lastActivityAt: '2026-04-23T20:04:20.000Z',
          lastProcessedJobAt: '2026-04-23T20:03:00.000Z',
          reason: 'No worker activity for 240000ms while queue work remained pending.'
        },
        lastPersistSource: 'watchdog'
      }
    };

    const normalized = normalizeWorkerRuntimeSnapshotForHash(volatileOnly) as {
      snapshot: Record<string, unknown>;
    };

    expect(buildWorkerRuntimeSnapshotStateHash(volatileOnly)).toBe(
      buildWorkerRuntimeSnapshotStateHash(baseline)
    );
    expect(normalized).not.toHaveProperty('lastInspectorRunAt');
    expect(normalized.snapshot).not.toHaveProperty('queueSummary');
    expect(normalized.snapshot).not.toHaveProperty('stats');
    expect(normalized.snapshot).not.toHaveProperty('alerts');
    expect(normalized.snapshot).not.toHaveProperty('lastWatchdogRunAt');
  });

  it('keeps meaningful watchdog state changes in the state hash', () => {
    const baseline = buildSnapshot({ source: 'watchdog' });
    const watchdogTriggered = {
      ...baseline,
      snapshot: {
        ...baseline.snapshot,
        watchdog: {
          ...baseline.snapshot.watchdog,
          triggered: true,
          stale: false,
          restartRecommended: true,
          inactivityMs: 180_000,
          reason: 'No worker activity for 180000ms while queue work remained pending.'
        }
      }
    };

    expect(buildWorkerRuntimeSnapshotStateHash(watchdogTriggered)).not.toBe(
      buildWorkerRuntimeSnapshotStateHash(baseline)
    );
  });

  it('does not collapse built-in objects to empty records while hashing', () => {
    const firstDateHash = buildWorkerRuntimeSnapshotStateHash({
      ...buildSnapshot(),
      snapshot: {
        ...buildSnapshot().snapshot,
        lastBudgetPauseReason: new Date('2026-04-23T20:00:00.000Z')
      }
    });
    const secondDateHash = buildWorkerRuntimeSnapshotStateHash({
      ...buildSnapshot(),
      snapshot: {
        ...buildSnapshot().snapshot,
        lastBudgetPauseReason: new Date('2026-04-23T20:01:00.000Z')
      }
    });
    const firstMapHash = buildWorkerRuntimeSnapshotStateHash({
      ...buildSnapshot(),
      snapshot: {
        ...buildSnapshot().snapshot,
        lastBudgetPauseReason: new Map([['reason', 'pause-a']])
      }
    });
    const secondMapHash = buildWorkerRuntimeSnapshotStateHash({
      ...buildSnapshot(),
      snapshot: {
        ...buildSnapshot().snapshot,
        lastBudgetPauseReason: new Map([['reason', 'pause-b']])
      }
    });

    expect(firstDateHash).not.toBe(secondDateHash);
    expect(firstMapHash).not.toBe(secondMapHash);
  });

  it('skips watchdog and inspector intents when only volatile observations changed', async () => {
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const baseline = buildSnapshot({ source: 'inspector' });
    const volatileOnly = {
      ...baseline,
      lastInspectorRunAt: '2026-04-23T20:05:00.000Z',
      updatedAt: '2026-04-23T20:05:00.000Z',
      snapshot: {
        ...baseline.snapshot,
        queueSummary: {
          ...baseline.snapshot.queueSummary,
          pending: 4,
          lastUpdatedAt: '2026-04-23T20:05:00.000Z',
          oldestPendingJobAgeMs: 90_000
        },
        stats: {
          completed: 4,
          failed: 0,
          running: 1,
          totalTerminal: 4,
          aiCalls: 4
        },
        lastWatchdogRunAt: '2026-04-23T20:05:00.000Z',
        watchdog: {
          ...baseline.snapshot.watchdog,
          inactivityMs: 90_000,
          lastHeartbeatAt: '2026-04-23T20:05:00.000Z'
        },
        lastPersistSource: 'watchdog'
      }
    };

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'inspector', baseline);
    await pipeline.flushAll('first');
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'watchdog', volatileOnly);
    await pipeline.flushAll('second');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(1);
    expect(repositoryAppendHistoryMock).toHaveBeenCalledTimes(1);
    expect(recordWorkerRuntimeSnapshotSkippedMock).toHaveBeenCalledWith({
      source: 'watchdog',
      healthStatus: 'healthy'
    });
  });

  it('does not schedule a redundant write for duplicate intents while a flush is in flight', async () => {
    let resolveUpsert: (() => void) | null = null;
    repositoryUpsertStateMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveUpsert = resolve;
    }));
    const pipeline = new WorkerRuntimeSnapshotPipeline({ coalesceMs: 10_000 });
    const snapshot = buildSnapshot({ source: 'worker-idle' });

    pipeline.recordSnapshotIntent('async-queue-slot-1', 'worker-idle', snapshot);
    const flushPromise = pipeline.flushAll('first');
    pipeline.recordSnapshotIntent('async-queue-slot-1', 'watchdog', {
      ...snapshot,
      updatedAt: '2026-04-23T20:01:00.000Z',
      snapshot: {
        ...snapshot.snapshot,
        lastPersistSource: 'watchdog'
      }
    });
    resolveUpsert?.();
    await flushPromise;
    await pipeline.flushAll('second');

    expect(repositoryUpsertStateMock).toHaveBeenCalledTimes(1);
    expect(recordWorkerRuntimeSnapshotSkippedMock).toHaveBeenCalledWith({
      source: 'watchdog',
      healthStatus: 'healthy'
    });
  });
});
