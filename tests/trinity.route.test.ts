import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetTrinityStatus = jest.fn();

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

  it('returns 200 for healthy Trinity status payloads', async () => {
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
        observedWorkerIds: ['async-queue-slot-1'],
        queueDepth: 2,
        pendingJobs: 1,
        runningJobs: 1
      },
      bindings: {
        workerMode: 'async_queue',
        memoryContainer: 'trinity',
        trinitySession: 'active',
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
    expect(response.body.pipeline).toBe('trinity');
    expect(response.body.memorySync.status).toBe('active');
    expect(response.body.bindings.memoryContainer).toBe('trinity');
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
    expect(response.body.status).toBe('offline');
  });
});
