import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getDagRunSnapshotByIdMock = jest.fn();
const getLatestDagRunSnapshotMock = jest.fn();
const lookupDagRunSnapshotForControlMock = jest.fn();
const upsertDagRunSnapshotMock = jest.fn();

jest.unstable_mockModule('../src/core/db/repositories/dagRunRepository.js', () => ({
  getDagRunSnapshotById: getDagRunSnapshotByIdMock,
  getLatestDagRunSnapshot: getLatestDagRunSnapshotMock,
  lookupDagRunSnapshotForControl: lookupDagRunSnapshotForControlMock,
  upsertDagRunSnapshot: upsertDagRunSnapshotMock
}));

const {
  ArcanosDagRunService,
  DagRunCapacityExceededError,
  getDagRunLifecycleSettings
} = await import('../src/services/arcanosDagRunService.js');

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createRunRequest(index = 1) {
  return {
    sessionId: `session-lifecycle-${index}`,
    template: 'trinity-core',
    input: {
      goal: `Verify DAG lifecycle ${index}.`
    }
  };
}

function createPersistedControlRecord(
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
) {
  const runId = `run-remote-${status}`;
  const at = '2026-07-27T12:00:00.000Z';
  return {
    runId,
    sessionId: 'session-remote',
    template: 'trinity-core',
    status,
    snapshotGeneration: '3',
    plannerNodeId: null,
    rootNodeId: null,
    createdAt: at,
    updatedAt: at,
    snapshot: {
      runId,
      sessionId: 'session-remote',
      template: 'trinity-core',
      status,
      plannerNodeId: null,
      rootNodeId: null,
      createdAt: at,
      updatedAt: at,
      summary: {
        runId,
        sessionId: 'session-remote',
        template: 'trinity-core',
        status,
        plannerNodeId: null,
        rootNodeId: null,
        createdAt: at,
        updatedAt: at
      },
      nodes: [],
      events: [],
      errors: [],
      guardViolations: [],
      metrics: {},
      verification: {},
      limits: {},
      features: {},
      loopDetected: false
    }
  };
}

async function flushDetachedWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('ArcanosDagRunService lifecycle controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDagRunSnapshotByIdMock.mockResolvedValue(null);
    getLatestDagRunSnapshotMock.mockResolvedValue(null);
    lookupDagRunSnapshotForControlMock.mockResolvedValue({
      outcome: 'not_found'
    });
    upsertDagRunSnapshotMock.mockResolvedValue(true);
  });

  it('uses stable defaults when lifecycle environment values are invalid', () => {
    expect(getDagRunLifecycleSettings({}, {
      DAG_MAX_ACTIVE_RUNS: '0',
      DAG_TERMINAL_RETENTION_MS: 'not-a-number',
      DAG_MAX_RETAINED_RUNS: '-2',
      DAG_OVERLOAD_RETRY_AFTER_SECONDS: '1.5'
    })).toEqual({
      maxActiveRuns: 4,
      terminalRetentionMs: 15 * 60 * 1_000,
      maxRetainedRuns: 100,
      retryAfterSeconds: 5
    });
  });

  it('reserves four slots before the first admission await and rejects a concurrent fifth run', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        maxActiveRuns: 4,
        retryAfterSeconds: 9
      }
    });
    const admissionWrites = Array.from({ length: 4 }, () =>
      createDeferred<boolean>()
    );
    let admissionWriteIndex = 0;
    upsertDagRunSnapshotMock.mockImplementation(
      () => admissionWrites[admissionWriteIndex++]?.promise ?? Promise.resolve(true)
    );
    const executions = Array.from({ length: 5 }, () => createDeferred());
    let executionIndex = 0;
    (service as any).executeRun = jest.fn(
      () => executions[executionIndex++]!.promise
    );

    const admittedPromises = [1, 2, 3, 4].map(index =>
      service.createRun(createRunRequest(index))
    );
    const fifthPromise = service.createRun(createRunRequest(5));
    await expect(fifthPromise).rejects.toMatchObject({
      name: 'DagRunCapacityExceededError',
      code: 'DAG_RUN_CAPACITY_EXCEEDED',
      retryAfterSeconds: 9
    });
    expect(upsertDagRunSnapshotMock).toHaveBeenCalledTimes(4);
    expect((service as any).activeRunReservations.size).toBe(4);

    admissionWrites.forEach(write => write.resolve(true));
    const admitted = await Promise.all(admittedPromises);

    executions[0]!.resolve();
    await flushDetachedWork();

    await expect(service.createRun(createRunRequest(6))).resolves.toEqual(
      expect.objectContaining({
        sessionId: 'session-lifecycle-6',
        status: 'queued'
      })
    );
    expect((service as any).activeRunReservations.has(admitted[0]!.runId)).toBe(false);
    expect((service as any).activeRunReservations.has(admitted[1]!.runId)).toBe(true);

    executions[1]!.resolve();
    executions[2]!.resolve();
    executions[3]!.resolve();
    executions[4]!.resolve();
    await flushDetachedWork();
  });

  it.each(['conflict', 'exception'] as const)(
    'fully rolls back a reserved slot after initial snapshot %s',
    async failureMode => {
      const service = new ArcanosDagRunService({
        lifecycle: {
          maxActiveRuns: 1
        }
      });
      (service as any).executeRun = jest.fn(async () => undefined);
      if (failureMode === 'conflict') {
        upsertDagRunSnapshotMock.mockResolvedValueOnce(false);
      } else {
        upsertDagRunSnapshotMock.mockRejectedValueOnce(
          new Error('initial persistence unavailable')
        );
      }

      await expect(service.createRun(createRunRequest())).rejects.toThrow();
      const rejectedRunId = upsertDagRunSnapshotMock.mock.calls[0]![0].runId;
      expect((service as any).activeRunReservations.size).toBe(0);
      expect((service as any).runsById.has(rejectedRunId)).toBe(false);
      expect((service as any).persistenceByRunId.has(rejectedRunId)).toBe(false);
      expect((service as any).persistenceConflictedRunIds.has(rejectedRunId)).toBe(false);
      expect((service as any).trinityOrchestrator.getRun(rejectedRunId)).toBeNull();

      await expect(service.createRun(createRunRequest(2))).resolves.toEqual(
        expect.objectContaining({ sessionId: 'session-lifecycle-2' })
      );
    }
  );

  it('persists local cancellation intent before abort and restores state after a failed CAS', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        maxActiveRuns: 1
      }
    });
    const execution = createDeferred();
    (service as any).executeRun = jest.fn(() => execution.promise);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    upsertDagRunSnapshotMock.mockImplementationOnce(async () => {
      expect(record.abortController.signal.aborted).toBe(false);
      throw new Error('transient snapshot write failed');
    });
    await expect(service.cancelRun(summary.runId)).resolves.toEqual(
      expect.objectContaining({
        outcome: 'unavailable',
        statusCode: 503
      })
    );
    expect(record.abortController.signal.aborted).toBe(false);
    expect(record.cancellationRequestedAt).toBeUndefined();
    expect(record.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.cancellation_requested' })
      ])
    );

    upsertDagRunSnapshotMock.mockResolvedValueOnce(true);
    await expect(service.cancelRun(summary.runId)).resolves.toEqual(
      expect.objectContaining({
        outcome: 'cancellation_requested',
        statusCode: 202,
        data: expect.objectContaining({
          status: 'cancellation_requested'
        })
      })
    );
    expect(record.abortController.signal.aborted).toBe(true);
    await expect(service.cancelRun(summary.runId)).resolves.toEqual(
      expect.objectContaining({
        outcome: 'already_requested',
        statusCode: 200
      })
    );

    await expect(service.createRun(createRunRequest(2))).rejects.toBeInstanceOf(
      DagRunCapacityExceededError
    );
    execution.resolve();
    await flushDetachedWork();
    warn.mockRestore();
  });

  it('quarantines a local run after a cancellation snapshot ownership conflict', async () => {
    const service = new ArcanosDagRunService();
    const execution = createDeferred();
    (service as any).executeRun = jest.fn(() => execution.promise);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    upsertDagRunSnapshotMock.mockResolvedValueOnce(false);

    await expect(service.cancelRun(summary.runId)).resolves.toEqual(
      expect.objectContaining({
        outcome: 'unavailable',
        statusCode: 503
      })
    );
    expect(record.abortController.signal.aborted).toBe(false);
    expect(record.cancellationRequestedAt).toBeUndefined();
    expect((service as any).persistenceConflictedRunIds.has(summary.runId)).toBe(true);

    const callsAfterConflict = upsertDagRunSnapshotMock.mock.calls.length;
    await expect(service.cancelRun(summary.runId)).resolves.toEqual(
      expect.objectContaining({
        outcome: 'unavailable',
        statusCode: 503
      })
    );
    expect(upsertDagRunSnapshotMock).toHaveBeenCalledTimes(callsAfterConflict);

    execution.resolve();
    await flushDetachedWork();
    error.mockRestore();
  });

  it('does not abort or report cancellation when execution becomes terminal during intent persistence', async () => {
    const service = new ArcanosDagRunService();
    const execution = createDeferred();
    (service as any).executeRun = jest.fn(() => execution.promise);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);
    const cancellationWrite = createDeferred<boolean>();
    upsertDagRunSnapshotMock
      .mockImplementationOnce(() => cancellationWrite.promise)
      .mockResolvedValueOnce(true);

    const cancellationPromise = service.cancelRun(summary.runId);
    await flushDetachedWork();
    expect(record.cancellationPersistenceInProgress).toBe(true);

    record.status = 'complete';
    record.summary.status = 'complete';
    record.updatedAt = new Date().toISOString();
    await expect((service as any).queuePersistRecord(record)).resolves.toBe('deferred');
    execution.resolve();
    cancellationWrite.resolve(true);

    await expect(cancellationPromise).resolves.toEqual({
      outcome: 'not_cancellable',
      statusCode: 409,
      runStatus: 'complete'
    });
    expect(record.abortController.signal.aborted).toBe(false);
    expect(upsertDagRunSnapshotMock).toHaveBeenCalledTimes(3);
    expect(upsertDagRunSnapshotMock.mock.calls[2]![0]).toEqual(
      expect.objectContaining({
        status: 'complete',
        snapshot: expect.objectContaining({ status: 'complete' })
      })
    );
    await flushDetachedWork();
  });

  it('distinguishes remote active, terminal, absent, and unavailable control state', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        retryAfterSeconds: 7
      }
    });

    lookupDagRunSnapshotForControlMock.mockResolvedValueOnce({
      outcome: 'found',
      record: createPersistedControlRecord('running')
    });
    await expect(service.cancelRun('run-remote-running')).resolves.toEqual({
      outcome: 'owned_elsewhere',
      statusCode: 503,
      retryAfterSeconds: 7
    });

    lookupDagRunSnapshotForControlMock.mockResolvedValueOnce({
      outcome: 'found',
      record: createPersistedControlRecord('cancelled')
    });
    await expect(service.cancelRun('run-remote-cancelled')).resolves.toEqual({
      outcome: 'already_cancelled',
      statusCode: 200,
      data: {
        runId: 'run-remote-cancelled',
        status: 'cancelled',
        cancelledNodes: []
      }
    });

    lookupDagRunSnapshotForControlMock.mockResolvedValueOnce({
      outcome: 'found',
      record: createPersistedControlRecord('complete')
    });
    await expect(service.cancelRun('run-remote-complete')).resolves.toEqual({
      outcome: 'not_cancellable',
      statusCode: 409,
      runStatus: 'complete'
    });

    lookupDagRunSnapshotForControlMock
      .mockResolvedValueOnce({ outcome: 'not_found' })
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockResolvedValueOnce({
        outcome: 'invalid',
        reason: 'identity_mismatch'
      });
    await expect(service.cancelRun('run-absent')).resolves.toEqual({
      outcome: 'not_found',
      statusCode: 404
    });
    await expect(service.cancelRun('run-db-down')).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 7
    });
    await expect(service.cancelRun('run-corrupt')).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 7
    });

    const partiallyCorruptRecord = createPersistedControlRecord('running');
    (partiallyCorruptRecord.snapshot as any).summary = {};
    lookupDagRunSnapshotForControlMock.mockResolvedValueOnce({
      outcome: 'found',
      record: partiallyCorruptRecord
    });
    await expect(
      service.cancelRun('run-remote-running')
    ).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 7
    });

    const malformedNodesRecord = createPersistedControlRecord('cancelled');
    (malformedNodesRecord.snapshot as any).nodes = [null];
    (malformedNodesRecord.snapshot as any).orchestratorState = {
      runId: 'run-remote-cancelled',
      status: 'cancelled',
      activeNodes: [],
      completedNodes: [],
      failedNodes: [],
      artifacts: [],
      updatedAtIso: '2026-07-27T12:00:00.000Z'
    };
    lookupDagRunSnapshotForControlMock.mockResolvedValueOnce({
      outcome: 'found',
      record: malformedNodesRecord
    });
    await expect(
      service.cancelRun('run-remote-cancelled')
    ).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 7
    });
  });

  it('evicts the oldest settled terminal run above the retained-run cap', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        maxActiveRuns: 2,
        maxRetainedRuns: 1,
        terminalRetentionMs: 60_000
      }
    });
    let completionIndex = 0;
    (service as any).executeRun = jest.fn(async (record: any) => {
      record.status = 'complete';
      record.summary.status = 'complete';
      record.updatedAt = new Date(Date.now() + completionIndex++).toISOString();
    });
    const forgetRun = jest.spyOn(
      (service as any).trinityOrchestrator,
      'forgetRun'
    );

    const first = await service.createRun(createRunRequest(1));
    await flushDetachedWork();
    const second = await service.createRun(createRunRequest(2));
    await flushDetachedWork();

    expect((service as any).runsById.has(first.runId)).toBe(false);
    expect((service as any).runsById.has(second.runId)).toBe(true);
    expect(forgetRun).toHaveBeenCalledWith(first.runId);
  });

  it('does not evict an expired terminal record until execution and persistence settle', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        terminalRetentionMs: 1
      }
    });
    const execution = createDeferred();
    (service as any).executeRun = jest.fn(() => execution.promise);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);
    record.status = 'complete';
    record.summary.status = 'complete';
    record.updatedAt = '2020-01-01T00:00:00.000Z';
    const pendingPersistence = createDeferred<'applied'>();
    (service as any).persistenceByRunId.set(
      summary.runId,
      pendingPersistence.promise
    );

    (service as any).evictRetainedRuns(Date.now());
    expect((service as any).runsById.has(summary.runId)).toBe(true);

    execution.resolve();
    await flushDetachedWork();
    expect((service as any).runsById.has(summary.runId)).toBe(true);

    (service as any).persistenceByRunId.delete(summary.runId);
    (service as any).evictRetainedRuns(Date.now());
    expect((service as any).runsById.has(summary.runId)).toBe(false);
    pendingPersistence.resolve('applied');
  });
});
