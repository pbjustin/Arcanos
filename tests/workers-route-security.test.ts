import fs from 'fs';
import type { IncomingHttpHeaders } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request, { type Test } from 'supertest';

import workersRouter from '../src/routes/workers.js';

const workerHelperToken = 'worker-run-route-test-token-1234567890';
const originalWorkerHelperToken = process.env.ARCANOS_WORKER_HELPER_TOKEN;

function createWorkersApp(options: {
  authUserRole?: string;
  daemonToken?: string;
  operatorActor?: string;
} = {}) {
  const app = express();
  app.use(express.json());
  if (options.authUserRole || options.daemonToken || options.operatorActor) {
    app.use((req, _res, next) => {
      if (options.authUserRole) {
        req.authUser = {
          id: 1,
          email: 'worker-route-operator@example.test',
          role: options.authUserRole,
          plan: 'internal',
          profileId: null,
          source: 'session'
        };
      }
      if (options.daemonToken) {
        req.daemonToken = options.daemonToken;
      }
      if (options.operatorActor) {
        req.operatorActor = options.operatorActor;
      }
      next();
    });
  }
  app.use(workersRouter);
  return app;
}

function withWorkerHelperToken(requestBuilder: Test): Test {
  return requestBuilder.set('x-arcanos-worker-helper-token', workerHelperToken);
}

describe('workers run route security', () => {
  beforeEach(() => {
    process.env.ARCANOS_WORKER_HELPER_TOKEN = workerHelperToken;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalWorkerHelperToken === undefined) {
      delete process.env.ARCANOS_WORKER_HELPER_TOKEN;
    } else {
      process.env.ARCANOS_WORKER_HELPER_TOKEN = originalWorkerHelperToken;
    }
  });

  it.each([
    ['encoded POSIX traversal', '..%2F..%2Fworkers%2Fdist%2Fworker-logger'],
    ['encoded side-effecting script traversal', '..%2F..%2Fscripts%2Fmigration-repair'],
    ['encoded Windows traversal', '..%5C..%5Cworkers%5Cdist%5Cworker-logger'],
    ['encoded absolute path', '%2Ftmp%2Fworker'],
    ['drive-qualified path', 'C:%5Ctemp%5Cworker'],
    ['double-encoded traversal', '%252e%252e%252fworker'],
    ['excluded job runner', 'jobRunner'],
    ['excluded shared module', 'shared-utils']
  ])('rejects %s before importing a module', async (_label, encodedWorkerId) => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const existsSpy = jest.spyOn(fs, 'existsSync');

    const response = await withWorkerHelperToken(
      request(createWorkersApp()).post(`/workers/run/${encodedWorkerId}`)
    )
      .set('x-confirmed', 'yes')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: 'Invalid worker identifier'
    });
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('preserves not-found behavior for a safe worker identifier', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await withWorkerHelperToken(
      request(createWorkersApp()).post('/workers/run/definitely-missing-worker')
    )
      .set('x-confirmed', 'yes')
      .send({});

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      workerId: 'definitely-missing-worker',
      error: 'Worker definitely-missing-worker not found'
    });
  });

  it('authenticates before confirmation or worker dispatch', async () => {
    const existsSpy = jest.spyOn(fs, 'existsSync');

    const response = await request(createWorkersApp())
      .post('/workers/run/arcanos')
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: 'WORKER_HELPER_AUTH_REQUIRED'
    });
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid worker credential before confirmation', async () => {
    const response = await request(createWorkersApp())
      .post('/workers/run/definitely-missing-worker')
      .set('x-arcanos-worker-helper-token', 'wrong-token')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
  });

  it('fails closed when worker token authentication is not configured', async () => {
    delete process.env.ARCANOS_WORKER_HELPER_TOKEN;

    const response = await request(createWorkersApp())
      .post('/workers/run/arcanos')
      .set('x-arcanos-worker-helper-token', workerHelperToken)
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
  });

  it('fails closed when the worker token collides with another purpose-bound credential', async () => {
    const originalAutomationSecret = process.env.ARCANOS_AUTOMATION_SECRET;
    process.env.ARCANOS_AUTOMATION_SECRET = workerHelperToken;

    try {
      const response = await withWorkerHelperToken(
        request(createWorkersApp()).post('/workers/run/arcanos')
      )
        .set('x-confirmed', 'yes')
        .send({ input: 'must not dispatch' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
      expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    } finally {
      if (originalAutomationSecret === undefined) {
        delete process.env.ARCANOS_AUTOMATION_SECRET;
      } else {
        process.env.ARCANOS_AUTOMATION_SECRET = originalAutomationSecret;
      }
    }
  });

  it('rejects simultaneous custom and Bearer credentials before confirmation', async () => {
    const existsSpy = jest.spyOn(fs, 'existsSync');

    const response = await withWorkerHelperToken(
      request(createWorkersApp()).post('/workers/run/arcanos')
    )
      .set('authorization', `Bearer ${workerHelperToken}`)
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['Authorization', `Bearer ${workerHelperToken}`],
    ['X-Arcanos-Worker-Helper-Token', workerHelperToken]
  ])('rejects duplicate %s headers on the Express transport', async (headerName, value) => {
    const duplicateHeaders: IncomingHttpHeaders = {
      [headerName]: [value, value]
    };

    const response = await request(createWorkersApp())
      .post('/workers/run/arcanos')
      .set(duplicateHeaders)
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
  });

  it('requires action confirmation after worker authentication succeeds', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const existsSpy = jest.spyOn(fs, 'existsSync');

    const response = await withWorkerHelperToken(
      request(createWorkersApp()).post('/workers/run/definitely-missing-worker')
    ).send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Confirmation required');
    expect(response.headers['x-confirmation-challenge']).toEqual(expect.any(String));
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('accepts the existing worker-helper bearer credential', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await request(createWorkersApp())
      .post('/workers/run/definitely-missing-worker')
      .set('authorization', `Bearer ${workerHelperToken}`)
      .set('x-confirmed', 'yes')
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Worker definitely-missing-worker not found');
  });

  it('treats an empty custom header as absent on the Express transport', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await request(createWorkersApp())
      .post('/workers/run/definitely-missing-worker')
      .set('x-arcanos-worker-helper-token', '')
      .set('authorization', `Bearer ${workerHelperToken}`)
      .set('x-confirmed', 'yes')
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Worker definitely-missing-worker not found');
  });

  it('accepts an established full-operator identity before requiring confirmation', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await request(createWorkersApp({ authUserRole: 'operator' }))
      .post('/workers/run/definitely-missing-worker')
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Confirmation required');
    expect(response.headers['x-confirmation-challenge']).toEqual(expect.any(String));
  });

  it.each([
    ['legacy daemon marker', { daemonToken: 'anonymous-daemon' }],
    ['operator audit label', { operatorActor: 'operator:unverified' }]
  ])('does not treat %s as worker-run authority', async (_label, context) => {
    const response = await request(createWorkersApp(context))
      .post('/workers/run/arcanos')
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
  });

  it.each([
    ['x-daemon-token', 'anonymous-daemon'],
    ['x-operator-actor', 'operator:spoofed'],
    ['x-user-role', 'owner']
  ])('does not derive worker-run authority from spoofed %s headers', async (headerName, value) => {
    const response = await request(createWorkersApp())
      .post('/workers/run/arcanos')
      .set(headerName, value)
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
  });

  it('denies operator-light even when the worker credential is valid', async () => {
    const response = await withWorkerHelperToken(
      request(createWorkersApp({ authUserRole: 'operator-light' })).post('/workers/run/arcanos')
    )
      .set('x-confirmed', 'yes')
      .send({ input: 'must not dispatch' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('WORKER_HELPER_OPERATOR_FORBIDDEN');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
  });

});
