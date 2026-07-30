import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetTrinityStatus = jest.fn();
const JOB_UUID_SENTINEL = '523e4567-e89b-42d3-a456-426614174000';
const PROMPT_SENTINEL = 'TRINITY_STATUS_PROMPT_SENTINEL';
const RESULT_SENTINEL = 'TRINITY_STATUS_RESULT_SENTINEL';
const ERROR_SENTINEL = 'TRINITY_STATUS_ERROR_SENTINEL';

jest.unstable_mockModule('../src/services/trinityStatusService.js', () => ({
  getTrinityStatus: mockGetTrinityStatus
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/trinity.js')).default;

function buildApp() {
  const app = express();
  app.use(router);
  return app;
}

describe('trinity route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a no-store aggregate projection for healthy Trinity status', async () => {
    mockGetTrinityStatus.mockResolvedValue({
      pipeline: 'trinity',
      version: '1.0',
      status: 'healthy',
      workersConnected: true,
      memorySync: {
        status: 'active',
        memoryVersion: '2026-03-07T20:00:01.000Z',
        lastUpdatedAt: '2026-03-07T20:00:01.000Z',
        loadedFrom: 'db',
        bindingsVersion: 'dispatch-v9',
        trustedSnapshotId: 'trusted-snapshot-1',
        routeCount: 4
      },
      lastDispatch: '2026-03-07T20:00:06.000Z',
      lastWorkerHeartbeat: '2026-03-07T20:00:07.000Z',
      timestamp: '2026-03-07T20:00:08.000Z',
      workerHealth: {
        overallStatus: 'healthy',
        observedWorkerIds: [JOB_UUID_SENTINEL],
        queueDepth: 2,
        pendingJobs: 1,
        runningJobs: 1
      },
      queue: {
        idle: false,
        pendingJobs: 1,
        runningJobs: 1,
        completedJobs: 3,
        retainedFailedJobs: 1,
        delayedJobs: 0,
        stalledRunningJobs: 0,
        lastUpdatedAt: '2026-03-07T20:00:05.000Z',
        semantics: {
          failedCountMode: 'retained_terminal_jobs',
          failedCountDescription: PROMPT_SENTINEL,
          activeFailureSignals: [RESULT_SENTINEL]
        },
        retryPolicy: {
          defaultMaxRetries: 2,
          retryBackoffBaseMs: 2000,
          retryBackoffMaxMs: 60000,
          staleAfterMs: 60000,
          watchdogIdleMs: 120000
        },
        recentFailedJobs: [{
          id: JOB_UUID_SENTINEL,
          worker_id: 'worker-helper',
          job_type: 'ask',
          status: 'failed',
          error_message: ERROR_SENTINEL,
          created_at: '2026-03-07T20:00:00.000Z',
          updated_at: '2026-03-07T20:00:05.000Z',
          completed_at: '2026-03-07T20:00:05.000Z'
        }]
      },
      bindings: {
        workerMode: PROMPT_SENTINEL,
        memoryContainer: RESULT_SENTINEL,
        trinitySession: ERROR_SENTINEL,
        databaseConfigured: true
      },
      limits: {
        workerApiTimeoutMs: 180000,
        workerTrinityRuntimeBudgetMs: 420000,
        workerTrinityStageTimeoutMs: 180000,
        dagMaxTokenBudget: 250000,
        dagNodeTimeoutMs: 420000,
        dagQueueClaimGraceMs: 120000,
        sessionTokenLimit: 250000
      },
      telemetry: {
        sourceEndpoint: 'trinity.status',
        traceIdPropagation: 'not_exposed',
        pipelineBindingsPublished: true,
        failedJobInspectionEndpoint: '/worker-helper/jobs/failed'
      }
    });

    const response = await request(buildApp()).get('/trinity/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      status: 'healthy',
      overallStatus: 'healthy',
      totalWorkers: null,
      availableWorkers: null,
      runtime: {
        status: 'active',
        totalDispatched: null,
        startedAt: null,
        lastDispatchAt: '2026-03-07T20:00:06.000Z'
      },
      workers: {
        status: 'healthy',
        total: null,
        available: null,
        configured: null,
        active: null,
        observed: 1,
        stale: null,
        degraded: null,
        unhealthy: null,
        lastHeartbeatAt: '2026-03-07T20:00:07.000Z'
      },
      queue: {
        status: 'active',
        total: 6,
        pending: 1,
        running: 1,
        completed: 3,
        retainedFailed: 1,
        delayed: 0,
        stalledRunning: 0,
        lastUpdatedAt: '2026-03-07T20:00:05.000Z'
      },
      memory: {
        status: 'active',
        routes: 4,
        lastUpdatedAt: '2026-03-07T20:00:01.000Z'
      },
      timestamp: '2026-03-07T20:00:08.000Z'
    });
    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      JOB_UUID_SENTINEL,
      PROMPT_SENTINEL,
      RESULT_SENTINEL,
      ERROR_SENTINEL
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('returns 503 when Trinity is offline', async () => {
    mockGetTrinityStatus.mockResolvedValue({
      pipeline: 'trinity',
      version: '1.0',
      status: 'offline',
      workersConnected: false,
      memorySync: {
        status: 'offline',
        memoryVersion: null,
        lastUpdatedAt: null,
        loadedFrom: null,
        bindingsVersion: null,
        trustedSnapshotId: null,
        routeCount: 0
      },
      lastDispatch: null,
      lastWorkerHeartbeat: null,
      timestamp: '2026-03-07T20:00:08.000Z',
      workerHealth: {
        overallStatus: 'offline',
        observedWorkerIds: [],
        queueDepth: 0,
        pendingJobs: 0,
        runningJobs: 0
      },
      queue: {
        idle: true,
        pendingJobs: 0,
        runningJobs: 0,
        completedJobs: 0,
        retainedFailedJobs: 0,
        delayedJobs: 0,
        stalledRunningJobs: 0,
        lastUpdatedAt: null,
        semantics: {
          failedCountMode: 'retained_terminal_jobs',
          failedCountDescription: 'Retained terminal jobs.',
          activeFailureSignals: []
        },
        retryPolicy: {
          defaultMaxRetries: 2,
          retryBackoffBaseMs: 2000,
          retryBackoffMaxMs: 60000,
          staleAfterMs: 60000,
          watchdogIdleMs: 120000
        },
        recentFailedJobs: []
      },
      bindings: {
        workerMode: null,
        memoryContainer: null,
        trinitySession: null,
        databaseConfigured: false
      },
      limits: {
        workerApiTimeoutMs: 180000,
        workerTrinityRuntimeBudgetMs: 420000,
        workerTrinityStageTimeoutMs: 180000,
        dagMaxTokenBudget: 250000,
        dagNodeTimeoutMs: 420000,
        dagQueueClaimGraceMs: 120000,
        sessionTokenLimit: 250000
      },
      telemetry: {
        sourceEndpoint: 'trinity.status',
        traceIdPropagation: 'not_exposed',
        pipelineBindingsPublished: true,
        failedJobInspectionEndpoint: '/worker-helper/jobs/failed'
      }
    });

    const response = await request(buildApp()).get('/trinity/status');

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.status).toBe('offline');
    expect(response.body.runtime.status).toBe('offline');
    expect(response.body.memory.status).toBe('offline');
  });

  it('returns a fixed no-store error without dependency details', async () => {
    const absolutePathSentinel =
      'C:\\private\\workers\\TRINITY_ABSOLUTE_PATH_SENTINEL';
    mockGetTrinityStatus.mockRejectedValue(new Error([
      JOB_UUID_SENTINEL,
      PROMPT_SENTINEL,
      RESULT_SENTINEL,
      ERROR_SENTINEL,
      absolutePathSentinel
    ].join(' ')));

    const response = await request(buildApp()).get('/trinity/status');

    expect(response.status).toBe(500);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      error: 'TRINITY_STATUS_FAILED',
      message: 'Trinity status request failed.'
    });
    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      JOB_UUID_SENTINEL,
      PROMPT_SENTINEL,
      RESULT_SENTINEL,
      ERROR_SENTINEL,
      'TRINITY_ABSOLUTE_PATH_SENTINEL'
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});
