import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCreateRun = jest.fn();
const mockGetRun = jest.fn();
const mockWaitForRunUpdate = jest.fn();
const mockGetRunTree = jest.fn();
const mockGetNode = jest.fn();
const mockGetRunEvents = jest.fn();
const mockGetRunMetrics = jest.fn();
const mockGetRunErrors = jest.fn();
const mockGetRunLineage = jest.fn();
const mockGetRunVerification = jest.fn();
const mockCancelRun = jest.fn();

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    createRun: mockCreateRun,
    getRun: mockGetRun,
    waitForRunUpdate: mockWaitForRunUpdate,
    getRunTree: mockGetRunTree,
    getNode: mockGetNode,
    getRunEvents: mockGetRunEvents,
    getRunMetrics: mockGetRunMetrics,
    getRunErrors: mockGetRunErrors,
    getRunLineage: mockGetRunLineage,
    getRunVerification: mockGetRunVerification,
    cancelRun: mockCancelRun
  }
}));

const buildModule = (await import('../src/services/arcanos-build.js')).default;
const trackerModule = (await import('../src/services/arcanos-tracker.js')).default;

describe('ARCANOS build and tracker modules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes build payloads into DAG create-run requests', async () => {
    mockCreateRun.mockResolvedValue({
      runId: 'run-build-1',
      sessionId: 'session-build-1',
      template: 'trinity-core',
      status: 'queued',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z'
    });

    const result = await buildModule.actions.run({
      message: 'Ship the BUILD module wrapper',
      buildPrompt: 'Generate an implementation plan',
      maxConcurrency: 2
    });

    expect(mockCreateRun).toHaveBeenCalledWith(expect.objectContaining({
      template: 'trinity-core',
      input: expect.objectContaining({
        prompt: 'Ship the BUILD module wrapper',
        buildPrompt: 'Generate an implementation plan'
      }),
      options: {
        maxConcurrency: 2
      }
    }));
    expect(mockCreateRun.mock.calls[0][0].sessionId).toEqual(expect.any(String));
    expect(result).toEqual({
      run: expect.objectContaining({
        runId: 'run-build-1',
        template: 'trinity-core'
      })
    });
  });

  it('returns tracker overview data through the default query action', async () => {
    mockGetRun.mockResolvedValue({
      runId: 'run-track-1',
      sessionId: 'session-track-1',
      template: 'trinity-core',
      status: 'running',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:01.000Z'
    });
    mockGetRunMetrics.mockResolvedValue({
      runId: 'run-track-1',
      metrics: {
        totalNodes: 5,
        maxParallelNodesObserved: 2,
        maxSpawnDepthObserved: 1,
        totalRetries: 0,
        totalFailures: 0,
        totalAiCalls: 3,
        estimatedCostUsd: 0,
        wallClockDurationMs: 100,
        sumNodeDurationMs: 100,
        queueWaitMsP50: 0,
        queueWaitMsP95: 0
      },
      limits: {
        maxConcurrency: 3,
        maxSpawnDepth: 2,
        maxChildrenPerNode: 5,
        maxRetriesPerNode: 2,
        maxAiCallsPerRun: 10,
        defaultNodeTimeoutMs: 30000
      },
      guardViolations: []
    });
    mockGetRunVerification.mockResolvedValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-track-1',
      verification: {
        runCompleted: false,
        plannerSpawnedChildren: true,
        parallelExecutionObserved: true,
        aggregationRanLast: false,
        retryPolicyRespected: true,
        budgetPolicyRespected: true,
        deadlockDetected: false,
        stalledJobsDetected: false,
        loopDetected: false
      },
      lineage: {
        workerPipeline: 'trinity',
        workerEntryPoint: 'runWorkerTrinityPrompt',
        sessionId: 'session-track-1',
        sessionPropagationMode: 'inherit_run_session',
        tokenAuditSessionMode: 'dag_node_branch',
        observedWorkerIds: [],
        observedSourceEndpoints: []
      }
    });

    const result = await trackerModule.actions.query({ runId: 'run-track-1' });

    expect(mockGetRun).toHaveBeenCalledWith('run-track-1');
    expect(mockGetRunMetrics).toHaveBeenCalledWith('run-track-1');
    expect(mockGetRunVerification).toHaveBeenCalledWith('run-track-1');
    expect(result).toEqual({
      run: expect.objectContaining({
        runId: 'run-track-1',
        status: 'running'
      }),
      metrics: expect.objectContaining({
        runId: 'run-track-1'
      }),
      verification: expect.objectContaining({
        runId: 'run-track-1'
      })
    });
  });

  it('maps tracker wait and cancel actions to the DAG run service', async () => {
    mockWaitForRunUpdate.mockResolvedValue({
      run: {
        runId: 'run-track-2',
        sessionId: 'session-track-2',
        template: 'trinity-core',
        status: 'complete',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:05.000Z'
      },
      updated: true,
      waited: true
    });
    mockCancelRun.mockReturnValue({
      runId: 'run-track-2',
      status: 'cancelled',
      cancelledNodes: ['writer']
    });

    const waitResult = await trackerModule.actions.waitForRunUpdate({
      runId: 'run-track-2',
      updatedAfter: '2026-03-22T00:00:01.000Z',
      waitForUpdateMs: 2500
    });
    const cancelResult = await trackerModule.actions.cancelRun({ runId: 'run-track-2' });

    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('run-track-2', {
      updatedAfter: '2026-03-22T00:00:01.000Z',
      waitForUpdateMs: 2500
    });
    expect(waitResult).toEqual(expect.objectContaining({
      updated: true,
      waited: true
    }));
    expect(cancelResult).toEqual({
      runId: 'run-track-2',
      status: 'cancelled',
      cancelledNodes: ['writer']
    });
  });
});
