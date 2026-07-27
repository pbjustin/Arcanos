import type { Test } from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'api-arcanos-dag-token-12345678901234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

const mockGetWorkerControlStatus = jest.fn();
const mockCreateRun = jest.fn();
const mockGetLatestRun = jest.fn();
const mockGetRun = jest.fn();
const mockWaitForRunUpdate = jest.fn();
const mockGetRunTrace = jest.fn();
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

class MockDagRunCapacityExceededError extends Error {
  readonly code = 'DAG_RUN_CAPACITY_EXCEEDED';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 5) {
    super('DAG run capacity is temporarily unavailable.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: mockGetWorkerControlStatus
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  DagRunCapacityExceededError: MockDagRunCapacityExceededError,
  arcanosDagRunService: {
    createRun: mockCreateRun,
    getLatestRun: mockGetLatestRun,
    getRun: mockGetRun,
    waitForRunUpdate: mockWaitForRunUpdate,
    getRunTrace: mockGetRunTrace,
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

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = 'arcanos:read,mcp:invoke',
  principalId = 'operator:api-arcanos-verification'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authorizeDagRequest(pendingRequest: Test): Test {
  return pendingRequest.set(
    'Authorization',
    `Bearer ${controlPlaneToken}`
  );
}

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
    configureControlPlane();

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
      defaultNodeTimeoutMs: 180000
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
    expect(healthResponse.headers['x-response-bytes']).toBeTruthy();
    expect(healthResponse.body.ok).toBe(true);
    expect(healthResponse.body.requestId).toBe('req-test');
    expect(healthResponse.body.data.service).toBe('arcanos-verification-api');

    expect(capabilitiesResponse.status).toBe(200);
    expect(capabilitiesResponse.headers['x-response-bytes']).toBeTruthy();
    expect(capabilitiesResponse.body.data.features.dagOrchestration).toBe(true);
    expect(capabilitiesResponse.body.data.limits.maxAiCallsPerRun).toBe(20);
  });

  it('returns worker status and queue envelopes', async () => {
    const workersResponse = await request(buildApp()).get('/workers/status');
    const queueResponse = await request(buildApp()).get('/workers/queue');

    expect(workersResponse.status).toBe(200);
    expect(workersResponse.headers['x-response-bytes']).toBeTruthy();
    expect(workersResponse.body.data.workers).toHaveLength(2);
    expect(workersResponse.body.data.workers[1].type).toBe('async_queue');
    expect(workersResponse.body.data.workers[1].activeJobs).toBe(1);

    expect(queueResponse.status).toBe(200);
    expect(queueResponse.headers['x-response-bytes']).toBeTruthy();
    expect(queueResponse.body.data.queue.depth).toBe(3);
    expect(queueResponse.body.data.queue.waiting).toBe(2);
  });

  it('creates and fetches DAG run resources in envelope form', async () => {
    mockCreateRun.mockReturnValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-1',
      sessionId: 'session-1',
      template: 'trinity-core',
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
      template: 'trinity-core',
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
        template: 'trinity-core',
        status: 'running',
        plannerNodeId: 'planner',
        rootNodeId: 'writer',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T00:00:01.000Z'
      },
      updated: true,
      waited: false
    });
    mockGetLatestRun.mockResolvedValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'run-1',
      sessionId: 'session-1',
      template: 'trinity-core',
      status: 'running',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:01.000Z'
    });
    mockGetRunTrace.mockResolvedValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      run: {
        pipeline: 'trinity',
        trinity_version: '1.0',
        runId: 'run-1',
        sessionId: 'session-1',
        template: 'trinity-core',
        status: 'running',
        plannerNodeId: 'planner',
        rootNodeId: 'writer',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T00:00:01.000Z'
      },
      tree: {
        pipeline: 'trinity',
        trinity_version: '1.0',
        runId: 'run-1',
        nodes: [{ nodeId: 'planner' }]
      },
      events: {
        pipeline: 'trinity',
        trinity_version: '1.0',
        runId: 'run-1',
        events: []
      },
      metrics: {
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
      },
      errors: {
        runId: 'run-1',
        errors: []
      },
      lineage: {
        runId: 'run-1',
        lineage: [],
        loopDetected: false
      },
      verification: {
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
          tokenAuditSessionMode: 'dag_node_branch',
          observedWorkerIds: ['async-queue-slot-1', 'async-queue-slot-2'],
          observedSourceEndpoints: ['dag.agent.planner', 'dag.agent.audit']
        }
      },
      sections: {
        requested: ['run', 'tree', 'events', 'metrics', 'errors', 'lineage', 'verification'],
        events: {
          total: 0,
          returned: 0,
          truncated: false,
          maxEvents: 200
        }
      }
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
        tokenAuditSessionMode: 'dag_node_branch',
        observedWorkerIds: ['async-queue-slot-1', 'async-queue-slot-2'],
        observedSourceEndpoints: ['dag.agent.planner', 'dag.agent.audit']
      }
    });
    mockCancelRun.mockResolvedValue({
      outcome: 'already_cancelled',
      statusCode: 200,
      data: {
        runId: 'run-1',
        status: 'cancelled',
        cancelledNodes: ['writer']
      }
    });

    const createResponse = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs')
    ).send({
        sessionId: 'session-1',
        template: 'verification-default',
        input: { goal: 'test the DAG' }
      });

    expect(createResponse.status).toBe(202);
    expect(createResponse.headers['x-response-bytes']).toBeTruthy();
    expect(createResponse.body.data.run.runId).toBe('run-1');
    expect(createResponse.body.data.run.pipeline).toBe('trinity');
    expect(createResponse.body.data.run.template).toBe('trinity-core');

    const latestResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/latest')
    );
    const runResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1')
    );
    const traceResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1/trace')
    );
    const treeResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1/tree')
    );
    const nodeResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1/nodes/planner')
    );
    const metricsResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1/metrics')
    );
    const verificationResponse = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1/verification')
    );
    const cancelResponse = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-1/cancel')
    );

    expect(latestResponse.status).toBe(200);
    expect(latestResponse.headers['x-response-bytes']).toBeTruthy();
    expect(latestResponse.body.data.run.runId).toBe('run-1');
    expect(mockGetLatestRun).toHaveBeenCalledWith(undefined);

    expect(runResponse.status).toBe(200);
    expect(runResponse.headers['x-response-bytes']).toBeTruthy();
    expect(runResponse.body.data.run.status).toBe('running');
    expect(runResponse.body.data.run.trinity_version).toBe('1.0');
    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('run-1', {
      updatedAfter: undefined,
      waitForUpdateMs: undefined
    });

    expect(treeResponse.status).toBe(200);
    expect(treeResponse.headers['x-response-bytes']).toBeTruthy();
    expect(treeResponse.body.data.nodes[0].nodeId).toBe('planner');
    expect(treeResponse.body.data.nodes[0].role).toBe('trinity_planner');

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.headers['x-response-bytes']).toBeTruthy();
    expect(nodeResponse.body.data.node.agentRole).toBe('planner');
    expect(nodeResponse.body.data.node.pipeline).toBe('trinity');

    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers['x-response-bytes']).toBeTruthy();
    expect(metricsResponse.body.data.metrics.maxParallelNodesObserved).toBe(3);

    expect(traceResponse.status).toBe(200);
    expect(traceResponse.headers['x-response-bytes']).toBeTruthy();
    expect(traceResponse.body.data.run.runId).toBe('run-1');
    expect(traceResponse.body.data.sections.events.maxEvents).toBe(200);
    expect(mockGetRunTrace).toHaveBeenCalledWith('run-1', {
      maxEvents: undefined
    });

    expect(verificationResponse.status).toBe(200);
    expect(verificationResponse.headers['x-response-bytes']).toBeTruthy();
    expect(verificationResponse.body.data.verification.parallelExecutionObserved).toBe(true);
    expect(verificationResponse.body.data.pipeline).toBe('trinity');
    expect(verificationResponse.body.data.lineage.workerPipeline).toBe('trinity');
    expect(verificationResponse.body.data.lineage.workerEntryPoint).toBe('runWorkerTrinityPrompt');

    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.headers['x-response-bytes']).toBeTruthy();
    expect(cancelResponse.body.data.status).toBe('cancelled');
  });

  it('returns a stable overload response when DAG run capacity is exhausted', async () => {
    mockCreateRun.mockRejectedValueOnce(new MockDagRunCapacityExceededError(7));

    const response = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs')
    ).send({
      sessionId: 'capacity-session',
      template: 'verification-default',
      input: { goal: 'wait for available DAG capacity' }
    });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expect(response.body).toEqual({
      error: 'DAG_RUN_CAPACITY_EXCEEDED',
      message: 'DAG run capacity is temporarily unavailable.'
    });
  });

  it('maps DAG cancellation lifecycle outcomes to stable HTTP responses', async () => {
    mockCancelRun
      .mockResolvedValueOnce({
        outcome: 'cancellation_requested',
        statusCode: 202,
        data: {
          runId: 'run-cancel-requested',
          status: 'cancellation_requested',
          cancelledNodes: ['writer']
        }
      })
      .mockResolvedValueOnce({
        outcome: 'already_cancelled',
        statusCode: 200,
        data: {
          runId: 'run-already-cancelled',
          status: 'cancelled',
          cancelledNodes: ['writer']
        }
      })
      .mockResolvedValueOnce({
        outcome: 'not_found',
        statusCode: 404
      })
      .mockResolvedValueOnce({
        outcome: 'not_cancellable',
        statusCode: 409,
        runStatus: 'complete'
      })
      .mockResolvedValueOnce({
        outcome: 'owned_elsewhere',
        statusCode: 503,
        retryAfterSeconds: 11
      })
      .mockResolvedValueOnce({
        outcome: 'unavailable',
        statusCode: 503,
        retryAfterSeconds: 13
      });

    const cancellationRequested = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-cancel-requested/cancel')
    );
    const alreadyCancelled = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-already-cancelled/cancel')
    );
    const notFound = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-missing/cancel')
    );
    const notCancellable = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-complete/cancel')
    );
    const ownedElsewhere = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-owned-elsewhere/cancel')
    );
    const unavailable = await authorizeDagRequest(
      request(buildApp()).post('/dag/runs/run-state-unavailable/cancel')
    );

    expect(cancellationRequested.status).toBe(202);
    expect(cancellationRequested.body.data).toEqual({
      runId: 'run-cancel-requested',
      status: 'cancellation_requested',
      cancelledNodes: ['writer']
    });

    expect(alreadyCancelled.status).toBe(200);
    expect(alreadyCancelled.body.data).toEqual({
      runId: 'run-already-cancelled',
      status: 'cancelled',
      cancelledNodes: ['writer']
    });

    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ error: 'RUN_NOT_FOUND' });

    expect(notCancellable.status).toBe(409);
    expect(notCancellable.body).toEqual({
      error: 'RUN_NOT_CANCELLABLE',
      status: 'complete'
    });

    expect(ownedElsewhere.status).toBe(503);
    expect(ownedElsewhere.headers['retry-after']).toBe('11');
    expect(ownedElsewhere.body).toEqual({
      error: 'DAG_RUN_OWNED_ELSEWHERE'
    });

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('13');
    expect(unavailable.body).toEqual({
      error: 'DAG_RUN_CANCELLATION_UNAVAILABLE'
    });
    expect(mockCancelRun).toHaveBeenCalledTimes(6);
  });

  it('supports long-poll run status queries with explicit wait cursors', async () => {
    mockWaitForRunUpdate.mockResolvedValue({
      run: {
        runId: 'run-1',
        sessionId: 'session-1',
        template: 'trinity-core',
        status: 'complete',
        plannerNodeId: 'planner',
        rootNodeId: 'writer',
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-07T00:00:05.000Z'
      },
      updated: true,
      waited: true
    });

    const response = await authorizeDagRequest(
      request(buildApp()).get('/dag/runs/run-1')
    ).query({
        updatedAfter: '2026-03-07T00:00:01.000Z',
        waitForUpdateMs: 5000
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-arcanos-run-wait-applied']).toBe('true');
    expect(response.headers['x-arcanos-run-updated']).toBe('true');
    expect(response.headers['x-arcanos-recommended-poll-interval-ms']).toBe('5000');
    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    });
  });

  it('rejects anonymous DAG execution before invoking the run service', async () => {
    const response = await request(buildApp())
      .post('/dag/runs')
      .send({
        sessionId: 'anonymous-session',
        template: 'verification-default',
        input: { goal: 'must not execute' }
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('principal-throttles DAG writes across caller-selected session rotation', async () => {
    configureControlPlane(
      'mcp:invoke',
      'operator:api-arcanos-dag-rate-limit'
    );
    mockCreateRun.mockReturnValue({
      runId: 'run-rate-limit',
      sessionId: 'session-rate-limit',
      template: 'trinity-core',
      status: 'queued',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z'
    });
    const app = buildApp();

    const firstResponse = await authorizeDagRequest(
      request(app)
        .post('/dag/runs')
        .set('X-Session-ID', 'caller-selected-session-1')
    ).send({
      sessionId: 'body-session-1',
      template: 'verification-default',
      input: { goal: 'first request' }
    });
    const secondResponse = await authorizeDagRequest(
      request(app)
        .post('/dag/runs')
        .set('X-Session-ID', 'caller-selected-session-2')
    ).send({
      sessionId: 'body-session-2',
      template: 'verification-default',
      input: { goal: 'second request' }
    });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstResponse.headers['x-ratelimit-bucket']).toBe(
      'api-arcanos-dag-write'
    );
    expect(Number(secondResponse.headers['x-ratelimit-remaining'])).toBe(
      Number(firstResponse.headers['x-ratelimit-remaining']) - 1
    );
    expect(mockCreateRun).toHaveBeenCalledTimes(2);
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});
