import express from 'express';
import request, { type Test } from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const healWorkerRuntimeMock = jest.fn();
const buildAutoHealPlanMock = jest.fn();
const summarizeAutoHealMock = jest.fn();
const getWorkerRuntimeStatusMock = jest.fn();
const loadStateMock = jest.fn();
const updateStateMock = jest.fn();

jest.unstable_mockModule('@platform/runtime/workerPaths.js', () => ({
  resolveWorkersDirectory: () => ({ path: 'C:\\nonexistent-arcanos-workers' }),
  resolveWorkerModuleFile: jest.fn(() => ({ status: 'not_found' })),
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  dispatchArcanosTask: jest.fn(),
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock,
}));

jest.unstable_mockModule('@services/autoHealService.js', () => ({
  buildAutoHealPlan: buildAutoHealPlanMock,
  summarizeAutoHeal: summarizeAutoHealMock,
}));

jest.unstable_mockModule('@services/stateManager.js', () => ({
  loadState: loadStateMock,
  updateState: updateStateMock,
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  dispatchWorkerInput: jest.fn(),
  getWorkerControlHealth: jest.fn(),
  getLatestWorkerJobDetail: jest.fn(),
  getWorkerControlStatus: jest.fn(),
  getWorkerJobDetailById: jest.fn(),
  healWorkerRuntime: healWorkerRuntimeMock,
  listRecentFailedWorkerJobs: jest.fn(),
  queueWorkerAsk: jest.fn(),
}));

const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
  delete process.env[environmentName];
}

const workersRouter = (await import('../src/routes/workers.js')).default;
const workerHelperRouter = (await import('../src/routes/worker-helper.js')).default;
const workerHelperToken = 'workers-heal-route-token-1234567890';

function buildApp(authUser?: { id: number; role: string }): express.Express {
  const app = express();
  app.use(express.json());
  if (authUser) {
    app.use((req, _res, next) => {
      req.authUser = {
        id: authUser.id,
        email: 'worker-heal-operator@example.test',
        role: authUser.role,
        plan: 'internal',
        profileId: null,
        source: 'session',
      };
      next();
    });
  }
  app.use(workersRouter);
  app.use(workerHelperRouter);
  return app;
}

function withWorkerHelperToken(requestBuilder: Test): Test {
  return requestBuilder.set(
    'x-arcanos-worker-helper-token',
    workerHelperToken
  );
}

describe('workers heal route security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      delete process.env[environmentName];
    }
    process.env.ARCANOS_WORKER_HELPER_TOKEN = workerHelperToken;
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: true,
      configuredCount: 1,
      model: 'test-model',
      started: true,
    });
    summarizeAutoHealMock.mockReturnValue({ severity: 'healthy' });
    buildAutoHealPlanMock.mockResolvedValue({
      planId: 'worker-heal-plan-1',
      severity: 'degraded',
      recommendedAction: 'restart',
    });
    healWorkerRuntimeMock.mockResolvedValue({
      requestedForce: true,
      restart: {
        started: true,
        alreadyRunning: false,
        runWorkers: true,
        message: 'Worker runtime restart started.',
      },
    });
    loadStateMock.mockReturnValue({});
  });

  it('authenticates before confirmation, planning, or execution', async () => {
    const response = await request(buildApp())
      .post('/workers/heal')
      .set('x-confirmed', 'yes')
      .send({ execute: true, force: true });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(buildAutoHealPlanMock).not.toHaveBeenCalled();
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('requires confirmation after the worker credential succeeds', async () => {
    const response = await withWorkerHelperToken(
      request(buildApp()).post('/workers/heal')
    ).send({ execute: true });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Confirmation required');
    expect(response.headers['x-confirmation-challenge'])
      .toEqual(expect.any(String));
    expect(buildAutoHealPlanMock).not.toHaveBeenCalled();
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('executes only after worker authentication and confirmation both pass', async () => {
    const response = await withWorkerHelperToken(
      request(buildApp()).post('/workers/heal')
    )
      .set('x-confirmed', 'yes')
      .send({ execute: true, force: true });

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe('execute');
    expect(healWorkerRuntimeMock).toHaveBeenCalledWith(true, 'workers_route');
    expect(updateStateMock).toHaveBeenCalledTimes(1);
  });

  it('does not disclose worker-heal dependency failures', async () => {
    buildAutoHealPlanMock.mockRejectedValueOnce(
      new Error('database password=test-worker-heal-secret')
    );

    const response = await withWorkerHelperToken(
      request(buildApp()).post('/workers/heal')
    )
      .set('x-confirmed', 'yes')
      .send({ mode: 'plan' });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'WORKER_HEAL_FAILED',
      message: 'Worker heal request failed.',
    });
    expect(JSON.stringify(response.body)).not.toContain('worker-heal-secret');
  });

  it('denies operator-light even when the worker credential is valid', async () => {
    const response = await withWorkerHelperToken(
      request(buildApp({ id: 20, role: 'operator-light' }))
        .post('/workers/heal')
    )
      .set('x-confirmed', 'yes')
      .send({ execute: true });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('WORKER_HELPER_OPERATOR_FORBIDDEN');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('shares one principal budget across both worker-heal entry points', async () => {
    const app = buildApp({ id: 777, role: 'operator' });

    for (let index = 0; index < 5; index += 1) {
      await request(app)
        .post('/workers/heal')
        .set('x-confirmed', 'yes')
        .send({ mode: 'plan' })
        .expect(200);
      await request(app)
        .post('/worker-helper/heal')
        .send({ mode: 'plan' })
        .expect(200);
    }

    const exhausted = await request(app)
      .post('/workers/heal')
      .set('x-confirmed', 'yes')
      .send({ mode: 'plan' });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers['x-ratelimit-bucket'])
      .toBe('worker-heal-control');
  });
});

afterAll(() => {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
});
