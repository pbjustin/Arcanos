import express from 'express';
import fs, * as fsModule from 'node:fs';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getWorkerRuntimeStatusMock = jest.fn();
const summarizeAutoHealMock = jest.fn();
const existsSyncMock = jest.fn();
const readdirSyncMock = jest.fn();

const JOB_UUID_SENTINEL = '223e4567-e89b-42d3-a456-426614174000';
const PROMPT_SENTINEL = 'WORKERS_STATUS_PROMPT_SENTINEL';
const RESULT_SENTINEL = 'WORKERS_STATUS_RESULT_SENTINEL';
const ERROR_SENTINEL = 'WORKERS_STATUS_ERROR_SENTINEL';
const ABSOLUTE_PATH_SENTINEL =
  'C:\\private\\arcanos\\WORKERS_STATUS_ABSOLUTE_PATH_SENTINEL';

jest.unstable_mockModule('fs', () => ({
  ...fsModule,
  default: {
    ...fs,
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
  },
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
}));

jest.unstable_mockModule('@platform/runtime/workerPaths.js', () => ({
  resolveWorkersDirectory: () => ({ path: ABSOLUTE_PATH_SENTINEL }),
  resolveWorkerModuleFile: jest.fn(() => ({ status: 'not_found' })),
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  dispatchArcanosTask: jest.fn(),
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock,
}));

jest.unstable_mockModule('@services/autoHealService.js', () => ({
  buildAutoHealPlan: jest.fn(),
  summarizeAutoHeal: summarizeAutoHealMock,
}));

jest.unstable_mockModule('@services/stateManager.js', () => ({
  loadState: jest.fn(() => ({})),
  updateState: jest.fn(),
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  healWorkerRuntime: jest.fn(),
}));

const workersRouter = (await import('../src/routes/workers.js')).default;

function buildApp() {
  const app = express();
  app.use(workersRouter);
  return app;
}

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => [
    key,
    ...collectObjectKeys(nestedValue),
  ]);
}

describe('GET /workers/status public projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([]);
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: true,
      model: 'WORKERS_STATUS_MODEL_SENTINEL',
      configuredCount: 3,
      maxActiveWorkers: 4,
      surgeWorkerCount: 0,
      started: true,
      dispatcherStarted: true,
      startedAt: '2026-07-29T09:00:00.000Z',
      activeListeners: 1,
      workerIds: [JOB_UUID_SENTINEL],
      totalDispatched: 9,
      lastDispatchAt: '2026-07-29T09:01:00.000Z',
      lastInputPreview: PROMPT_SENTINEL,
      lastResult: { output: RESULT_SENTINEL },
      lastError: ERROR_SENTINEL,
    });
    summarizeAutoHealMock.mockReturnValue({
      status: 'critical',
      failingWorkers: [],
      lastError: ERROR_SENTINEL,
      recommendedAction: RESULT_SENTINEL,
    });
  });

  it('omits runtime detail and the absolute directory while retaining aggregate state', async () => {
    const response = await request(buildApp()).get('/workers/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      status: 'unhealthy',
      overallStatus: 'unhealthy',
      totalWorkers: 0,
      availableWorkers: 0,
      runtime: expect.objectContaining({
        status: 'active',
        totalDispatched: 9,
        startedAt: '2026-07-29T09:00:00.000Z',
        lastDispatchAt: '2026-07-29T09:01:00.000Z',
      }),
      workers: expect.objectContaining({
        total: 0,
        available: 0,
        configured: 3,
        active: 1,
      }),
      queue: expect.objectContaining({
        status: 'unavailable',
      }),
      timestamp: expect.any(String),
    }));

    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      JOB_UUID_SENTINEL,
      PROMPT_SENTINEL,
      RESULT_SENTINEL,
      ERROR_SENTINEL,
      'WORKERS_STATUS_ABSOLUTE_PATH_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(collectObjectKeys(response.body)).toEqual(
      expect.not.arrayContaining([
        'workerIds',
        'lastInputPreview',
        'lastResult',
        'lastError',
        'workersDirectory',
      ])
    );
  });

  it('counts unavailable workers when runtime fallback health is degraded', async () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['unavailable-worker.js']);
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: true,
      model: 'WORKERS_STATUS_MODEL_SENTINEL',
      configuredCount: 1,
      maxActiveWorkers: 1,
      surgeWorkerCount: 0,
      started: false,
      dispatcherStarted: false,
      activeListeners: 0,
      workerIds: [],
      totalDispatched: 0,
    });
    summarizeAutoHealMock.mockReturnValue(undefined);

    const response = await request(buildApp()).get('/workers/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'degraded',
        overallStatus: 'degraded',
        totalWorkers: 1,
        availableWorkers: 0,
        workers: expect.objectContaining({
          status: 'degraded',
          total: 1,
          available: 0,
          degraded: 1,
          unhealthy: 0,
        }),
      })
    );
  });
});
