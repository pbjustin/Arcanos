import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetDagRunSnapshotById = jest.fn();
const mockGetLatestDagRunSnapshot = jest.fn();
const mockLookupDagRunSnapshotForControl = jest.fn();
const mockUpsertDagRunSnapshot = jest.fn();

jest.unstable_mockModule('../src/core/db/repositories/dagRunRepository.js', () => ({
  getLatestDagRunSnapshot: mockGetLatestDagRunSnapshot,
  getDagRunSnapshotById: mockGetDagRunSnapshotById,
  lookupDagRunSnapshotForControl: mockLookupDagRunSnapshotForControl,
  upsertDagRunSnapshot: mockUpsertDagRunSnapshot
}));

const { ArcanosDagRunService } = await import('../src/services/arcanosDagRunService.js');

function buildPersistedSnapshotRecord() {
  return {
    runId: 'run-db-1',
    sessionId: 'session-db-1',
    template: 'archetype-v2',
    status: 'running',
    snapshotGeneration: '7',
    plannerNodeId: 'planner',
    rootNodeId: 'writer',
    createdAt: '2026-03-07T00:00:00.000Z',
    updatedAt: '2026-03-07T00:00:03.000Z',
    snapshot: {
      runId: 'run-db-1',
      sessionId: 'session-db-1',
      template: 'archetype-v2',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      status: 'running',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:03.000Z',
      summary: {
        runId: 'run-db-1',
        sessionId: 'session-db-1',
        template: 'archetype-v2',
        status: 'running',
        plannerNodeId: 'planner',
        rootNodeId: 'writer',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T00:00:03.000Z'
      },
      nodes: [
        {
          nodeId: 'planner',
          runId: 'run-db-1',
          parentNodeId: null,
          agentRole: 'planner',
          jobType: 'plan',
          status: 'complete',
          dependencyIds: [],
          spawnDepth: 0,
          attempt: 1,
          maxRetries: 2,
          input: {},
          childNodeIds: ['writer'],
          error: null,
          completedAt: '2026-03-07T00:00:02.000Z'
        },
        {
          nodeId: 'writer',
          runId: 'run-db-1',
          parentNodeId: 'planner',
          agentRole: 'writer',
          jobType: 'synthesize',
          status: 'running',
          dependencyIds: ['planner'],
          spawnDepth: 1,
          attempt: 1,
          maxRetries: 2,
          input: {},
          childNodeIds: [],
          error: null
        }
      ],
      events: [],
      errors: [],
      guardViolations: [],
      metrics: {
        totalNodes: 2,
        maxParallelNodesObserved: 1,
        maxSpawnDepthObserved: 1,
        totalRetries: 0,
        totalFailures: 0,
        totalAiCalls: 2,
        estimatedCostUsd: 0.001,
        wallClockDurationMs: 3000,
        sumNodeDurationMs: 2000,
        queueWaitMsP50: 5,
        queueWaitMsP95: 5
      },
      verification: {
        runCompleted: false,
        plannerSpawnedChildren: true,
        parallelExecutionObserved: false,
        aggregationRanLast: false,
        retryPolicyRespected: true,
        budgetPolicyRespected: true,
        deadlockDetected: false,
        stalledJobsDetected: false,
        loopDetected: false
      },
      limits: {
        maxConcurrency: 5,
        maxSpawnDepth: 3,
        maxChildrenPerNode: 5,
        maxRetriesPerNode: 2,
        maxAiCallsPerRun: 20,
        defaultNodeTimeoutMs: 180000
      },
      features: {
        dagOrchestration: true,
        parallelExecution: true,
        recursiveSpawning: false,
        jobTreeInspection: true,
        eventStreaming: false
      },
      loopDetected: false
    }
  };
}

describe('ArcanosDagRunService persistence fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestDagRunSnapshot.mockResolvedValue(null);
    mockLookupDagRunSnapshotForControl.mockResolvedValue({
      outcome: 'not_found'
    });
    mockUpsertDagRunSnapshot.mockResolvedValue(true);
  });

  it('loads run summaries from shared persistence when local memory is empty', async () => {
    mockGetDagRunSnapshotById.mockResolvedValue(buildPersistedSnapshotRecord());
    const service = new ArcanosDagRunService();

    const run = await service.getRun('run-db-1');
    const tree = await service.getRunTree('run-db-1');

    expect(run).toEqual(
      expect.objectContaining({
        runId: 'run-db-1',
        sessionId: 'session-db-1',
        template: 'trinity-core',
        status: 'running'
      })
    );
    expect(tree?.nodes).toHaveLength(2);
    expect(tree?.nodes[1]?.nodeId).toBe('writer');
    expect(mockGetDagRunSnapshotById).toHaveBeenCalledWith('run-db-1');
  });

  it('loads the latest run summary from shared persistence when local memory is empty', async () => {
    mockGetLatestDagRunSnapshot.mockResolvedValue(buildPersistedSnapshotRecord());
    const service = new ArcanosDagRunService();

    const latestRun = await service.getLatestRun();

    expect(latestRun).toEqual(
      expect.objectContaining({
        runId: 'run-db-1',
        sessionId: 'session-db-1',
        template: 'trinity-core',
        status: 'running'
      })
    );
    expect(mockGetLatestDagRunSnapshot).toHaveBeenCalledWith(undefined);
  });

  it('builds a full trace from one persisted snapshot lookup', async () => {
    mockGetDagRunSnapshotById.mockResolvedValue(buildPersistedSnapshotRecord());
    const service = new ArcanosDagRunService();

    const trace = await service.getRunTrace('run-db-1');

    expect(trace).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({
          runId: 'run-db-1'
        }),
        tree: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ nodeId: 'planner' }),
            expect.objectContaining({ nodeId: 'writer' })
          ])
        }),
        sections: expect.objectContaining({
          events: expect.objectContaining({
            returned: 0,
            maxEvents: 200
          })
        })
      })
    );
    expect(mockGetDagRunSnapshotById).toHaveBeenCalledTimes(1);
    expect(mockGetDagRunSnapshotById).toHaveBeenCalledWith('run-db-1');
  });
});

function createRunRequest() {
  return {
    sessionId: 'session-create-1',
    template: 'trinity-core',
    input: {
      goal: 'Verify durable DAG snapshot admission.'
    }
  };
}

async function flushPersistenceQueue(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('ArcanosDagRunService snapshot generation persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestDagRunSnapshot.mockResolvedValue(null);
    mockUpsertDagRunSnapshot.mockResolvedValue(true);
  });

  it('persists applied generation 1 before launching execution', async () => {
    const service = new ArcanosDagRunService();
    const executeRun = jest.fn(async () => undefined);
    (service as any).executeRun = executeRun;

    const summary = await service.createRun(createRunRequest());

    expect(mockUpsertDagRunSnapshot).toHaveBeenCalledTimes(1);
    expect(mockUpsertDagRunSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: summary.runId,
        snapshotGeneration: '1',
        status: 'queued',
        snapshot: expect.objectContaining({
          runId: summary.runId,
          status: 'queued'
        })
      })
    );
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(
      mockUpsertDagRunSnapshot.mock.invocationCallOrder[0]
    ).toBeLessThan(executeRun.mock.invocationCallOrder[0]);
    expect(
      (service as any).runsById.get(summary.runId).snapshotGeneration
    ).toBe(1n);
  });

  it.each([
    ['a persistence exception', 'throw'],
    ['a rejected generation', 'conflict']
  ])(
    'rolls back admission without execution after %s',
    async (_label, failureMode) => {
      const service = new ArcanosDagRunService();
      const executeRun = jest.fn(async () => undefined);
      (service as any).executeRun = executeRun;
      if (failureMode === 'throw') {
        mockUpsertDagRunSnapshot.mockRejectedValueOnce(
          new Error('snapshot persistence unavailable')
        );
      } else {
        mockUpsertDagRunSnapshot.mockResolvedValueOnce(false);
      }

      await expect(service.createRun(createRunRequest())).rejects.toThrow();

      const rejectedEnvelope = mockUpsertDagRunSnapshot.mock.calls[0][0];
      const runId = rejectedEnvelope.runId as string;
      expect(rejectedEnvelope.snapshotGeneration).toBe('1');
      expect(executeRun).not.toHaveBeenCalled();
      expect((service as any).runsById.has(runId)).toBe(false);
      expect((service as any).persistenceByRunId.has(runId)).toBe(false);
      expect((service as any).persistenceConflictedRunIds.has(runId)).toBe(
        false
      );
      expect(
        (service as any).trinityOrchestrator.getRun(runId)
      ).toBeNull();
    }
  );

  it('captures immutable complete envelopes with one generation per queue append', async () => {
    const service = new ArcanosDagRunService();
    (service as any).executeRun = jest.fn(async () => undefined);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);
    mockUpsertDagRunSnapshot.mockClear();

    record.status = 'running';
    record.summary.status = 'running';
    (service as any).queuePersistRecord(record);
    expect(record.snapshotGeneration).toBe(2n);

    record.status = 'failed';
    record.summary.status = 'failed';
    record.sessionId = 'mutated-after-capture';
    record.events.push({
      eventId: 'late-event',
      type: 'run.failed',
      at: '2026-07-27T12:00:00.000Z',
      data: {}
    });
    (service as any).queuePersistRecord(record);
    expect(record.snapshotGeneration).toBe(3n);

    await flushPersistenceQueue();

    expect(mockUpsertDagRunSnapshot).toHaveBeenCalledTimes(2);
    expect(mockUpsertDagRunSnapshot.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-create-1',
        status: 'running',
        snapshotGeneration: '2',
        snapshot: expect.objectContaining({
          sessionId: 'session-create-1',
          status: 'running',
          events: expect.not.arrayContaining([
            expect.objectContaining({ eventId: 'late-event' })
          ])
        })
      })
    );
    expect(mockUpsertDagRunSnapshot.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        sessionId: 'mutated-after-capture',
        status: 'failed',
        snapshotGeneration: '3',
        snapshot: expect.objectContaining({
          status: 'failed',
          events: expect.arrayContaining([
            expect.objectContaining({ eventId: 'late-event' })
          ])
        })
      })
    );
  });

  it('does not consume a generation when deep-clone capture fails', async () => {
    const service = new ArcanosDagRunService();
    (service as any).executeRun = jest.fn(async () => undefined);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    record.events.push({
      eventId: 'circular-event',
      type: 'run.started',
      at: '2026-07-27T12:00:00.000Z',
      data: circular
    });

    expect(() =>
      (service as any).capturePersistenceEnvelope(record)
    ).toThrow();
    expect(record.snapshotGeneration).toBe(1n);

    record.events.pop();
    expect(
      (service as any).capturePersistenceEnvelope(record).snapshotGeneration
    ).toBe('2');
    expect(record.snapshotGeneration).toBe(2n);
  });

  it('logs one ownership conflict and quarantines all later database writes', async () => {
    const service = new ArcanosDagRunService();
    (service as any).executeRun = jest.fn(async () => undefined);
    const summary = await service.createRun(createRunRequest());
    const record = (service as any).runsById.get(summary.runId);
    mockUpsertDagRunSnapshot.mockClear();
    mockUpsertDagRunSnapshot.mockResolvedValueOnce(false);
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    (service as any).queuePersistRecord(record);
    (service as any).queuePersistRecord(record);
    await flushPersistenceQueue();
    (service as any).queuePersistRecord(record);
    await flushPersistenceQueue();

    expect(mockUpsertDagRunSnapshot).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      '[DAG Runs] Snapshot persistence ownership conflict:',
      {
        runId: summary.runId,
        snapshotGeneration: '2'
      }
    );
    expect(
      (service as any).persistenceConflictedRunIds.has(summary.runId)
    ).toBe(true);
    expect((service as any).runsById.has(summary.runId)).toBe(true);
    expect(
      (service as any).trinityOrchestrator.getRun(summary.runId)
    ).not.toBeNull();
  });
});
