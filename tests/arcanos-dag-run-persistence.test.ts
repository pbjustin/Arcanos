import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetDagRunSnapshotById = jest.fn();
const mockGetLatestDagRunSnapshot = jest.fn();
const mockUpsertDagRunSnapshot = jest.fn();

jest.unstable_mockModule('../src/core/db/repositories/dagRunRepository.js', () => ({
  getLatestDagRunSnapshot: mockGetLatestDagRunSnapshot,
  getDagRunSnapshotById: mockGetDagRunSnapshotById,
  upsertDagRunSnapshot: mockUpsertDagRunSnapshot
}));

const { ArcanosDagRunService } = await import('../src/services/arcanosDagRunService.js');

function buildPersistedSnapshotRecord() {
  return {
    runId: 'run-db-1',
    sessionId: 'session-db-1',
    template: 'archetype-v2',
    status: 'running',
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
