import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
  DagRunAdmissionUncertainError,
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

  afterEach(() => {
    jest.useRealTimers();
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

      if (failureMode === 'conflict') {
        await expect(service.createRun(createRunRequest())).rejects.toMatchObject({
          name: 'DagRunSnapshotOwnershipConflictError',
          snapshotGeneration: '1'
        });
      } else {
        await expect(service.createRun(createRunRequest())).rejects.toThrow(
          'initial persistence unavailable'
        );
      }
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

  it('hides and gates an admission-pending run until its serialized initial snapshot settles', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        retryAfterSeconds: 8
      }
    });
    const initialWrite = createDeferred<boolean>();
    const execution = createDeferred();
    upsertDagRunSnapshotMock.mockImplementationOnce(() => initialWrite.promise);
    (service as any).executeRun = jest.fn(() => execution.promise);

    const creationPromise = service.createRun(createRunRequest());
    await flushDetachedWork();

    const initialEnvelope = upsertDagRunSnapshotMock.mock.calls[0]![0];
    const runId = initialEnvelope.runId;
    getDagRunSnapshotByIdMock.mockResolvedValue(initialEnvelope);
    getLatestDagRunSnapshotMock.mockResolvedValue(initialEnvelope);

    await expect(service.getRun(runId)).resolves.toBeNull();
    await expect(service.getLatestRun(initialEnvelope.sessionId)).resolves.toBeNull();
    await expect(service.getRunTrace(runId)).resolves.toBeNull();
    await expect(service.cancelRun(runId)).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 8
    });
    expect(initialEnvelope.snapshot.admissionPending).toBe(true);
    expect(lookupDagRunSnapshotForControlMock).not.toHaveBeenCalled();

    const remoteService = new ArcanosDagRunService();
    lookupDagRunSnapshotForControlMock.mockResolvedValueOnce({
      outcome: 'found',
      record: initialEnvelope
    });
    await expect(remoteService.getRun(runId)).resolves.toBeNull();
    await expect(
      remoteService.getLatestRun(initialEnvelope.sessionId)
    ).resolves.toBeNull();
    await expect(remoteService.getRunTrace(runId)).resolves.toBeNull();
    await expect(remoteService.cancelRun(runId)).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 5
    });

    expect(upsertDagRunSnapshotMock).toHaveBeenCalledTimes(1);
    expect((service as any).persistenceByRunId.has(runId)).toBe(true);
    expect((service as any).runsById.get(runId)).toEqual(
      expect.objectContaining({
        admissionPending: true,
        snapshotGeneration: 1n
      })
    );

    initialWrite.resolve(true);
    await expect(creationPromise).resolves.toEqual(
      expect.objectContaining({
        runId,
        status: 'queued'
      })
    );
    expect((service as any).executeRun).toHaveBeenCalledTimes(1);
    expect((service as any).runsById.get(runId).admissionPending).toBe(false);

    execution.resolve();
    await flushDetachedWork();
  });

  it('accepts an exact generation-one readback after an ambiguous initial commit response', async () => {
    const service = new ArcanosDagRunService();
    let committedEnvelope: any;
    upsertDagRunSnapshotMock.mockImplementationOnce(async envelope => {
      committedEnvelope = JSON.parse(JSON.stringify(envelope));
      throw new Error('connection lost after commit');
    });
    lookupDagRunSnapshotForControlMock.mockImplementationOnce(async runId => ({
      outcome: 'found',
      record: {
        ...committedEnvelope,
        runId
      }
    }));
    (service as any).executeRun = jest.fn(async () => undefined);

    const summary = await service.createRun(createRunRequest());
    expect(summary).toEqual(
      expect.objectContaining({
        runId: committedEnvelope.runId,
        status: 'queued'
      })
    );
    expect(lookupDagRunSnapshotForControlMock).toHaveBeenCalledWith(summary.runId);
    expect(upsertDagRunSnapshotMock).toHaveBeenCalledTimes(1);
    expect((service as any).executeRun).toHaveBeenCalledTimes(1);
    expect((service as any).runsById.get(summary.runId)).toEqual(
      expect.objectContaining({
        admissionPending: false,
        snapshotGeneration: 1n
      })
    );
    await flushDetachedWork();
  });

  it('rejects a mismatched ambiguous readback with the attempted generation', async () => {
    const service = new ArcanosDagRunService();
    let attemptedEnvelope: any;
    upsertDagRunSnapshotMock.mockImplementationOnce(async envelope => {
      attemptedEnvelope = JSON.parse(JSON.stringify(envelope));
      throw new Error('connection lost after possible commit');
    });
    lookupDagRunSnapshotForControlMock.mockImplementationOnce(async () => ({
      outcome: 'found',
      record: {
        ...attemptedEnvelope,
        snapshotGeneration: '2'
      }
    }));
    (service as any).executeRun = jest.fn(async () => undefined);

    await expect(service.createRun(createRunRequest())).rejects.toMatchObject({
      name: 'DagRunSnapshotOwnershipConflictError',
      runId: expect.any(String),
      snapshotGeneration: '1'
    });
    expect((service as any).runsById.has(attemptedEnvelope.runId)).toBe(false);
    expect((service as any).activeRunReservations.has(attemptedEnvelope.runId)).toBe(false);
    expect((service as any).executeRun).not.toHaveBeenCalled();
  });

  it('reports a retained admission as pending then admitted and launches one executor', async () => {
    jest.useFakeTimers();
    const service = new ArcanosDagRunService({
      admissionReconciliation: {
        retryDelayMs: 100,
        maxAttemptsPerCycle: 2,
        cooldownMs: 1_000
      }
    });
    const execution = createDeferred();
    const backgroundReadback = createDeferred<any>();
    let initialEnvelope: any;
    upsertDagRunSnapshotMock.mockImplementationOnce(async envelope => {
      initialEnvelope = JSON.parse(JSON.stringify(envelope));
      throw new Error('connection lost after possible commit');
    });
    lookupDagRunSnapshotForControlMock
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockImplementationOnce(() => backgroundReadback.promise);
    (service as any).executeRun = jest.fn(() => execution.promise);

    const admissionError = await service.createRun(createRunRequest()).then(
      () => null,
      (error: unknown) => error
    );
    expect(admissionError).toBeInstanceOf(DagRunAdmissionUncertainError);
    expect(admissionError).toMatchObject({
      code: 'DAG_RUN_ADMISSION_UNCERTAIN',
      runId: initialEnvelope.runId,
      snapshotGeneration: '1'
    });
    await expect(
      service.getRunAdmissionStatus(initialEnvelope.runId, '1')
    ).resolves.toEqual({
      runId: initialEnvelope.runId,
      snapshotGeneration: '1',
      state: 'pending',
      retryAfterSeconds: 1
    });
    await expect(
      service.getRunAdmissionStatus(initialEnvelope.runId, '2')
    ).resolves.toEqual({
      runId: initialEnvelope.runId,
      snapshotGeneration: '2',
      state: 'unavailable',
      retryAfterSeconds: 5
    });

    const retainedAdmission = (service as any).retainedAdmissionsByRunId.get(
      initialEnvelope.runId
    );
    expect(retainedAdmission).toBeDefined();
    expect(jest.getTimerCount()).toBe(1);
    (service as any).scheduleRetainedAdmissionReconciliation(
      retainedAdmission,
      100
    );
    (service as any).scheduleRetainedAdmissionReconciliation(
      retainedAdmission,
      100
    );
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(100);
    expect(lookupDagRunSnapshotForControlMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    (service as any).scheduleRetainedAdmissionReconciliation(
      retainedAdmission,
      100
    );
    expect(jest.getTimerCount()).toBe(0);

    backgroundReadback.resolve({
      outcome: 'found',
      record: JSON.parse(JSON.stringify(initialEnvelope))
    });
    await jest.advanceTimersByTimeAsync(0);

    expect((service as any).retainedAdmissionsByRunId.has(initialEnvelope.runId))
      .toBe(false);
    expect((service as any).runsById.get(initialEnvelope.runId)).toEqual(
      expect.objectContaining({
        admissionPending: false,
        snapshotGeneration: 1n
      })
    );
    expect((service as any).executeRun).toHaveBeenCalledTimes(1);
    expect((service as any).executeRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: initialEnvelope.runId }),
      createRunRequest(),
      expect.any(Object)
    );
    await expect(service.getRun(initialEnvelope.runId)).resolves.toEqual(
      expect.objectContaining({ runId: initialEnvelope.runId })
    );
    await expect(
      service.getRunAdmissionStatus(initialEnvelope.runId, '1')
    ).resolves.toEqual({
      runId: initialEnvelope.runId,
      snapshotGeneration: '1',
      state: 'admitted'
    });
    expect(jest.getTimerCount()).toBe(0);

    (service as any).scheduleRetainedAdmissionReconciliation(
      retainedAdmission,
      100
    );
    await jest.advanceTimersByTimeAsync(100);
    expect((service as any).executeRun).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    execution.resolve();
    await jest.advanceTimersByTimeAsync(0);
  });

  it.each(['not_found', 'conflict'] as const)(
    'releases a retained uncertain admission after confirmed %s readback',
    async readbackMode => {
      jest.useFakeTimers();
      const service = new ArcanosDagRunService({
        lifecycle: {
          maxActiveRuns: 1
        },
        admissionReconciliation: {
          retryDelayMs: 100,
          maxAttemptsPerCycle: 2,
          cooldownMs: 1_000
        }
      });
      let initialEnvelope: any;
      upsertDagRunSnapshotMock.mockImplementationOnce(async envelope => {
        initialEnvelope = JSON.parse(JSON.stringify(envelope));
        throw new Error('connection lost after possible commit');
      });
      lookupDagRunSnapshotForControlMock
        .mockResolvedValueOnce({ outcome: 'unavailable' })
        .mockImplementationOnce(async () =>
          readbackMode === 'not_found'
            ? { outcome: 'not_found' }
            : {
                outcome: 'found',
                record: {
                  ...initialEnvelope,
                  snapshotGeneration: '2'
                }
              }
        );
      (service as any).executeRun = jest.fn(async () => undefined);

      await expect(service.createRun(createRunRequest())).rejects.toMatchObject({
        code: 'DAG_RUN_ADMISSION_UNCERTAIN',
        runId: expect.any(String),
        snapshotGeneration: '1'
      });
      await expect(
        service.getRunAdmissionStatus(initialEnvelope.runId, '1')
      ).resolves.toEqual({
        runId: initialEnvelope.runId,
        snapshotGeneration: '1',
        state: 'pending',
        retryAfterSeconds: 1
      });
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(100);

      expect((service as any).retainedAdmissionsByRunId.has(initialEnvelope.runId))
        .toBe(false);
      expect((service as any).runsById.has(initialEnvelope.runId)).toBe(false);
      expect((service as any).activeRunReservations.has(initialEnvelope.runId))
        .toBe(false);
      expect((service as any).trinityOrchestrator.getRun(initialEnvelope.runId))
        .toBeNull();
      expect((service as any).executeRun).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await expect(
        service.getRunAdmissionStatus(initialEnvelope.runId, '1')
      ).resolves.toEqual({
        runId: initialEnvelope.runId,
        snapshotGeneration: '1',
        state: 'rejected'
      });
    }
  );

  it('keeps unavailable admission reconciliation bounded, fail-closed, and deduplicated', async () => {
    jest.useFakeTimers();
    const service = new ArcanosDagRunService({
      lifecycle: {
        maxActiveRuns: 1,
        retryAfterSeconds: 6
      },
      admissionReconciliation: {
        retryDelayMs: 100,
        maxAttemptsPerCycle: 2,
        cooldownMs: 1_000
      }
    });
    upsertDagRunSnapshotMock.mockRejectedValueOnce(
      new Error('connection lost after possible commit')
    );
    lookupDagRunSnapshotForControlMock.mockResolvedValue({
      outcome: 'unavailable'
    });
    (service as any).executeRun = jest.fn(async () => undefined);

    const admissionError = await service.createRun(createRunRequest()).then(
      () => null,
      (error: unknown) => error
    );

    const initialEnvelope = upsertDagRunSnapshotMock.mock.calls[0]![0];
    const runId = initialEnvelope.runId;
    expect(admissionError).toMatchObject({
      code: 'DAG_RUN_ADMISSION_UNCERTAIN',
      runId,
      snapshotGeneration: '1'
    });
    getDagRunSnapshotByIdMock.mockResolvedValue(initialEnvelope);
    getLatestDagRunSnapshotMock.mockResolvedValue(initialEnvelope);

    expect((service as any).runsById.get(runId)).toEqual(
      expect.objectContaining({
        admissionPending: true,
        snapshotGeneration: 1n,
        executionSettled: false
      })
    );
    expect((service as any).activeRunReservations.has(runId)).toBe(true);
    expect((service as any).executeRun).not.toHaveBeenCalled();
    const retainedAdmission = (service as any).retainedAdmissionsByRunId.get(runId);
    expect(retainedAdmission).toBeDefined();
    expect(jest.getTimerCount()).toBe(1);
    (service as any).scheduleRetainedAdmissionReconciliation(
      retainedAdmission,
      100
    );
    (service as any).scheduleRetainedAdmissionReconciliation(
      retainedAdmission,
      100
    );
    expect(jest.getTimerCount()).toBe(1);
    await expect(service.getRun(runId)).resolves.toBeNull();
    await expect(service.getLatestRun(initialEnvelope.sessionId)).resolves.toBeNull();
    await expect(service.getRunTrace(runId)).resolves.toBeNull();
    await expect(service.cancelRun(runId)).resolves.toEqual({
      outcome: 'unavailable',
      statusCode: 503,
      retryAfterSeconds: 6
    });
    expect(upsertDagRunSnapshotMock).toHaveBeenCalledTimes(1);
    await expect(service.createRun(createRunRequest(2))).rejects.toBeInstanceOf(
      DagRunCapacityExceededError
    );

    await jest.advanceTimersByTimeAsync(100);
    expect(lookupDagRunSnapshotForControlMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(lookupDagRunSnapshotForControlMock).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(lookupDagRunSnapshotForControlMock).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(lookupDagRunSnapshotForControlMock).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(1);
    expect((service as any).runsById.get(runId).admissionPending).toBe(true);
    expect((service as any).activeRunReservations.has(runId)).toBe(true);
    expect((service as any).executeRun).not.toHaveBeenCalled();
  });

  it('validates persisted admission identity and generation while preserving terminal outcomes', async () => {
    const service = new ArcanosDagRunService({
      lifecycle: {
        retryAfterSeconds: 9
      },
      admissionReconciliation: {
        retryDelayMs: 1_250
      }
    });
    const baseRecord = createPersistedControlRecord('running');
    const admittedRecord = {
      ...baseRecord,
      snapshot: {
        ...baseRecord.snapshot,
        admissionPending: false
      }
    };
    const pendingRecord = {
      ...baseRecord,
      snapshot: {
        ...baseRecord.snapshot,
        admissionPending: true
      }
    };

    lookupDagRunSnapshotForControlMock
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockResolvedValueOnce({ outcome: 'not_found' })
      .mockResolvedValueOnce({
        outcome: 'found',
        record: pendingRecord
      })
      .mockResolvedValueOnce({
        outcome: 'found',
        record: admittedRecord
      })
      .mockResolvedValueOnce({
        outcome: 'found',
        record: admittedRecord
      })
      .mockResolvedValueOnce({
        outcome: 'found',
        record: {
          ...admittedRecord,
          runId: 'run-mismatched-identity'
        }
      });

    await expect(
      service.getRunAdmissionStatus('run-unavailable', '1')
    ).resolves.toEqual({
      runId: 'run-unavailable',
      snapshotGeneration: '1',
      state: 'unavailable',
      retryAfterSeconds: 9
    });
    await expect(
      service.getRunAdmissionStatus('run-rejected', '1')
    ).resolves.toEqual({
      runId: 'run-rejected',
      snapshotGeneration: '1',
      state: 'rejected'
    });
    await expect(
      service.getRunAdmissionStatus(baseRecord.runId, '3')
    ).resolves.toEqual({
      runId: baseRecord.runId,
      snapshotGeneration: '3',
      state: 'pending',
      retryAfterSeconds: 2
    });
    await expect(
      service.getRunAdmissionStatus(baseRecord.runId, '3')
    ).resolves.toEqual({
      runId: baseRecord.runId,
      snapshotGeneration: '3',
      state: 'admitted'
    });
    await expect(
      service.getRunAdmissionStatus(baseRecord.runId, '4')
    ).resolves.toEqual({
      runId: baseRecord.runId,
      snapshotGeneration: '4',
      state: 'unavailable',
      retryAfterSeconds: 9
    });
    await expect(
      service.getRunAdmissionStatus(baseRecord.runId, '3')
    ).resolves.toEqual({
      runId: baseRecord.runId,
      snapshotGeneration: '3',
      state: 'unavailable',
      retryAfterSeconds: 9
    });
  });

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
