import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetWorkerControlStatus = jest.fn();
const mockCreateRun = jest.fn();
const mockGetRun = jest.fn();
const mockWaitForRunUpdate = jest.fn();
const mockGetRunTree = jest.fn();
const mockGetNode = jest.fn();
const mockGetRunEvents = jest.fn();
const mockGetRunMetrics = jest.fn();
const mockGetRunErrors = jest.fn();
const mockGetRunLineage = jest.fn();
const mockCancelRun = jest.fn();
const mockGetRunVerification = jest.fn();
const mockGetFeatureFlags = jest.fn();
const mockGetExecutionLimits = jest.fn();

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: mockGetWorkerControlStatus
}));

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
    cancelRun: mockCancelRun,
    getRunVerification: mockGetRunVerification,
    getFeatureFlags: mockGetFeatureFlags,
    getExecutionLimits: mockGetExecutionLimits
  }
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/api-arcanos-verification.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'req-test';
    next();
  });
  app.use(router);
  return app;
}

describe('api-arcanos-verification routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetFeatureFlags.mockReturnValue({
      dagOrchestration: true,
      parallelExecution: true,
      recursiveSpawning: false,
      jobTreeInspection: true,
      eventStreaming: false
    });
    mockGetExecutionLimits.mockReturnValue({
      maxConcurrency: 5,
      maxSpawnDepth: 3,
      maxChildrenPerNode: 5,
      maxRetriesPerNode: 2,
      maxAiCallsPerRun: 20,
      defaultNodeTimeoutMs: 60000
    });
    mockGetWorkerControlStatus.mockResolvedValue({
      mainApp: {
        workerId: 'main-worker',
        runtime: {
          enabled: true,
          started: true,
          startedAt: '2026-03-07T00:00:00.000Z',
          lastDispatchAt: '2026-03-07T00:01:00.000Z'
        }
      },
      workerService: {
        database: { connected: true },
        queueSummary: {
          pending: 2,
          running: 1,
          failed: 0,
          lastUpdatedAt: '2026-03-07T00:02:00.000Z'
        },
        health: {
          overallStatus: 'healthy',
          alerts: [],
          workers: [
            {
              workerId: 'async-queue',
              lastHeartbeatAt: '2026-03-07T00:02:00.000Z'
            }
          ]
        }
      }
    });
  });

  it('returns health and capabilities envelopes', async () => {
    const healthResponse = await request(buildApp()).get('/health');
    const capabilitiesResponse = await request(buildApp()).get('/capabilities');

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.ok).toBe(true);
    expect(healthResponse.body.requestId).toBe('req-test');
    expect(healthResponse.body.data.service).toBe('arcanos-verification-api');

    expect(capabilitiesResponse.status).toBe(200);
    expect(capabilitiesResponse.body.data.features.dagOrchestration).toBe(true);
    expect(capabilitiesResponse.body.data.limits.maxAiCallsPerRun).toBe(20);
  });

  it('returns worker status and queue envelopes', async () => {
    const workersResponse = await request(buildApp()).get('/workers/status');
    const queueResponse = await request(buildApp()).get('/workers/queue');

    expect(workersResponse.status).toBe(200);
    expect(workersResponse.body.data.workers).toHaveLength(2);
    expect(workersResponse.body.data.workers[1].type).toBe('async_queue');
    expect(workersResponse.body.data.workers[1].activeJobs).toBe(1);

    expect(queueResponse.status).toBe(200);
    expect(queueResponse.body.data.queue.depth).toBe(3);
    expect(queueResponse.body.data.queue.waiting).toBe(2);
  });

  it('creates and fetches DAG run resources in envelope form', async () => {
    mockCreateRun.mockReturnValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-1',
      sessionId: 'session-1',
      template: 'verification-default',
      status: 'queued',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z'
    });
    mockGetRun.mockReturnValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-1',
      sessionId: 'session-1',
      template: 'verification-default',
      status: 'running',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:01.000Z'
    });
    mockWaitForRunUpdate.mockResolvedValue({
      run: {
        pipeline: 'trinity',
        trinity_version: '1.0',
        runId: 'run-1',
        sessionId: 'session-1',
        template: 'verification-default',
        status: 'running',
        plannerNodeId: 'planner',
        rootNodeId: 'writer',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T00:00:01.000Z'
      },
      updated: true,
      waited: false
    });
    mockGetRunTree.mockReturnValue({
      runId: 'run-1',
      nodes: [
        {
          pipeline: 'trinity',
          trinity_version: '1.0',
          role: 'trinity_planner',
          nodeId: 'planner',
          parentNodeId: null,
          agentRole: 'planner',
          jobType: 'plan',
          status: 'complete',
          dependencyIds: [],
          childNodeIds: ['research', 'build', 'audit'],
          spawnDepth: 0
        }
      ]
    });
    mockGetNode.mockReturnValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      role: 'trinity_planner',
      nodeId: 'planner',
      runId: 'run-1',
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan',
      status: 'complete',
      dependencyIds: [],
      spawnDepth: 0,
      attempt: 1,
      maxRetries: 2,
      input: {},
      error: null
    });
    mockGetRunEvents.mockReturnValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-1',
      events: []
    });
    mockGetRunMetrics.mockReturnValue({
      runId: 'run-1',
      metrics: {
        totalNodes: 5,
        maxParallelNodesObserved: 3,
        maxSpawnDepthObserved: 2,
        totalRetries: 1,
        totalFailures: 0,
        totalAiCalls: 5,
        estimatedCostUsd: 0.01,
        wallClockDurationMs: 1000,
        sumNodeDurationMs: 1500,
        queueWaitMsP50: 10,
        queueWaitMsP95: 20
      },
      limits: mockGetExecutionLimits(),
      guardViolations: []
    });
    mockGetRunErrors.mockReturnValue({
      runId: 'run-1',
      errors: []
    });
    mockGetRunLineage.mockReturnValue({
      runId: 'run-1',
      lineage: [],
      loopDetected: false
    });
    mockGetRunVerification.mockReturnValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-1',
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
        sessionId: 'session-1',
        sessionPropagationMode: 'inherit_run_session',
        observedWorkerIds: ['async-queue-slot-1', 'async-queue-slot-2'],
        observedSourceEndpoints: ['dag.agent.planner', 'dag.agent.audit']
      }
    });
    mockCancelRun.mockReturnValue({
      runId: 'run-1',
      status: 'cancelled',
      cancelledNodes: ['writer']
    });

    const createResponse = await request(buildApp())
      .post('/dag/runs')
      .send({
        sessionId: 'session-1',
        template: 'verification-default',
        input: { goal: 'test the DAG' }
      });

    expect(createResponse.status).toBe(202);
    expect(createResponse.body.data.run.runId).toBe('run-1');
    expect(createResponse.body.data.run.pipeline).toBe('trinity');

    const runResponse = await request(buildApp()).get('/dag/runs/run-1');
    const treeResponse = await request(buildApp()).get('/dag/runs/run-1/tree');
    const nodeResponse = await request(buildApp()).get('/dag/runs/run-1/nodes/planner');
    const metricsResponse = await request(buildApp()).get('/dag/runs/run-1/metrics');
    const verificationResponse = await request(buildApp()).get('/dag/runs/run-1/verification');
    const cancelResponse = await request(buildApp()).post('/dag/runs/run-1/cancel');

    expect(runResponse.status).toBe(200);
    expect(runResponse.body.data.run.status).toBe('running');
    expect(runResponse.body.data.run.trinity_version).toBe('1.0');
    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('run-1', {
      updatedAfter: undefined,
      waitForUpdateMs: undefined
    });

    expect(treeResponse.status).toBe(200);
    expect(treeResponse.body.data.nodes[0].nodeId).toBe('planner');
    expect(treeResponse.body.data.nodes[0].role).toBe('trinity_planner');

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body.data.node.agentRole).toBe('planner');
    expect(nodeResponse.body.data.node.pipeline).toBe('trinity');

    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.body.data.metrics.maxParallelNodesObserved).toBe(3);

    expect(verificationResponse.status).toBe(200);
    expect(verificationResponse.body.data.verification.parallelExecutionObserved).toBe(true);
    expect(verificationResponse.body.data.pipeline).toBe('trinity');
    expect(verificationResponse.body.data.lineage.workerPipeline).toBe('trinity');
    expect(verificationResponse.body.data.lineage.workerEntryPoint).toBe('runWorkerTrinityPrompt');

    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.data.status).toBe('cancelled');
  });

  it('supports long-poll run status queries with explicit wait cursors', async () => {
    mockWaitForRunUpdate.mockResolvedValue({
      run: {
        runId: 'run-1',
        sessionId: 'session-1',
        template: 'verification-default',
        status: 'complete',
        plannerNodeId: 'planner',
        rootNodeId: 'writer',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T00:00:05.000Z'
      },
      updated: true,
      waited: true
    });

    const response = await request(buildApp())
      .get('/dag/runs/run-1')
      .query({
        updatedAfter: '2026-03-07T00:00:01.000Z',
        waitForUpdateMs: 5000
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-arcanos-run-wait-applied']).toBe('true');
    expect(response.headers['x-arcanos-run-updated']).toBe('true');
    expect(response.headers['x-arcanos-recommended-poll-interval-ms']).toBe('5000');
    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    });
  });
});
