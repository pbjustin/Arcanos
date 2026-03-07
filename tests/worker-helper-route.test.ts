import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const getJobQueueSummaryMock = jest.fn();
const getLatestJobMock = jest.fn();
const dispatchArcanosTaskMock = jest.fn();
const getWorkerRuntimeStatusMock = jest.fn();
const startWorkersMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const getDatabaseStatusMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock,
  getJobById: getJobByIdMock,
  getJobQueueSummary: getJobQueueSummaryMock,
  getLatestJob: getLatestJobMock
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  dispatchArcanosTask: dispatchArcanosTaskMock,
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock,
  startWorkers: startWorkersMock
}));

jest.unstable_mockModule('@dispatcher/detectCognitiveDomain.js', () => ({
  detectCognitiveDomain: detectCognitiveDomainMock
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getStatus: getDatabaseStatusMock
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const workerHelperRouter = (await import('../src/routes/worker-helper.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/', workerHelperRouter);
  return app;
}

describe('/worker-helper routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_KEY = 'test-helper-key';
    delete process.env.REGISTER_KEY;
    delete process.env.WORKER_ID;

    getDatabaseStatusMock.mockReturnValue({
      connected: true,
      hasPool: true,
      error: null
    });
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: true,
      model: 'gpt-5.1',
      configuredCount: 2,
      started: true,
      activeListeners: 2,
      workerIds: ['worker-1', 'worker-2'],
      totalDispatched: 5
    });
    getJobQueueSummaryMock.mockResolvedValue({
      pending: 1,
      running: 0,
      completed: 3,
      failed: 1,
      total: 5,
      lastUpdatedAt: '2026-03-06T10:00:00.000Z'
    });
    getLatestJobMock.mockResolvedValue({
      id: 'job-latest',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'completed',
      created_at: '2026-03-06T09:59:00.000Z',
      updated_at: '2026-03-06T10:00:00.000Z',
      completed_at: '2026-03-06T10:00:00.000Z',
      error_message: null,
      output: { result: 'ok' }
    });
    createJobMock.mockResolvedValue({ id: 'job-123' });
    detectCognitiveDomainMock.mockReturnValue({ domain: 'code', confidence: 0.91 });
    dispatchArcanosTaskMock.mockResolvedValue([{ workerId: 'arcanos-core-direct', result: 'ok' }]);
    startWorkersMock.mockResolvedValue({
      started: true,
      alreadyRunning: false,
      runWorkers: true,
      workerCount: 2,
      workerIds: ['worker-1', 'worker-2'],
      model: 'gpt-5.1',
      startedAt: '2026-03-06T10:05:00.000Z',
      message: 'Workers started successfully.'
    });
  });

  it('rejects unauthenticated helper access', async () => {
    const response = await request(buildApp()).get('/worker-helper/status');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'WORKER_HELPER_AUTH_REQUIRED',
      message:
        'Provide x-worker-helper-key, x-admin-api-key, x-register-key, or Authorization: Bearer <key>.'
    });
  });

  it('returns combined status for authenticated requests', async () => {
    const response = await request(buildApp())
      .get('/worker-helper/status')
      .set('x-worker-helper-key', 'test-helper-key');

    expect(response.status).toBe(200);
    expect(response.body.mainApp).toEqual({
      connected: true,
      workerId: 'worker-helper',
      runtime: expect.objectContaining({
        enabled: true,
        workerIds: ['worker-1', 'worker-2']
      })
    });
    expect(response.body.workerService).toEqual({
      observationMode: 'queue-observed',
      database: {
        connected: true,
        hasPool: true,
        error: null
      },
      queueSummary: {
        pending: 1,
        running: 0,
        completed: 3,
        failed: 1,
        total: 5,
        lastUpdatedAt: '2026-03-06T10:00:00.000Z'
      },
      latestJob: {
        id: 'job-latest',
        worker_id: 'worker-helper',
        job_type: 'ask',
        status: 'completed',
        created_at: '2026-03-06T09:59:00.000Z',
        updated_at: '2026-03-06T10:00:00.000Z',
        completed_at: '2026-03-06T10:00:00.000Z',
        error_message: null
      }
    });
  });

  it('queues ask work with detected domain metadata', async () => {
    const response = await request(buildApp())
      .post('/worker-helper/queue/ask')
      .set('x-worker-helper-key', 'test-helper-key')
      .send({
        prompt: 'Explain this stack trace.',
        sessionId: 'session-42',
        clientContext: {
          routingDirectives: ['cli']
        }
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      status: 'pending',
      jobId: 'job-123',
      poll: '/jobs/job-123',
      endpoint: 'worker-helper',
      cognitiveDomain: 'code',
      cognitiveDomainSource: 'detected'
    });
    expect(createJobMock).toHaveBeenCalledWith(
      'worker-helper',
      'ask',
      expect.objectContaining({
        prompt: 'Explain this stack trace.',
        sessionId: 'session-42',
        cognitiveDomain: 'code',
        endpointName: 'worker-helper',
        clientContext: {
          routingDirectives: ['cli']
        }
      })
    );
  });

  it('dispatches direct commands through the in-process worker runtime', async () => {
    const response = await request(buildApp())
      .post('/worker-helper/dispatch')
      .set('x-worker-helper-key', 'test-helper-key')
      .send({
        input: 'Run a direct worker check.',
        attempts: 2,
        backoffMs: 500
      });

    expect(response.status).toBe(200);
    expect(dispatchArcanosTaskMock).toHaveBeenCalledWith('Run a direct worker check.', {
      input: 'Run a direct worker check.',
      attempts: 2,
      backoffMs: 500
    });
    expect(response.body).toEqual(
      expect.objectContaining({
        mode: 'direct-dispatch',
        input: 'Run a direct worker check.',
        resultCount: 1,
        primaryResult: {
          workerId: 'arcanos-core-direct',
          result: 'ok'
        }
      })
    );
  });
});
