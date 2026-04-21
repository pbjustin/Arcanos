import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const requestJobCancellationMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
const resolveAsyncGptPollIntervalMsMock = jest.fn(() => 250);
const resolveAsyncGptWaitForResultMsMock = jest.fn((requested?: number) => requested ?? 3500);

class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
  getJobById: getJobByIdMock,
  requestJobCancellation: requestJobCancellationMock,
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: planAutonomousWorkerJobMock,
}));

jest.unstable_mockModule('../src/services/queuedGptCompletionService.js', () => ({
  waitForQueuedGptJobCompletion: waitForQueuedGptJobCompletionMock,
  resolveAsyncGptPollIntervalMs: resolveAsyncGptPollIntervalMsMock,
  resolveAsyncGptWaitForResultMs: resolveAsyncGptWaitForResultMsMock,
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: bridgeRouter } = await import('../src/routes/bridge.js');
const { default: jobsRouter } = await import('../src/routes/jobs.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/', bridgeRouter);
  app.use('/', jobsRouter);
  return app;
}

describe('Custom GPT bridge smoke action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_ACTION_SHARED_SECRET = 'test-shared-secret';
    process.env.DEFAULT_GPT_ID = 'arcanos-core';
    planAutonomousWorkerJobMock.mockResolvedValue({
      status: 'pending',
      retryCount: 0,
      maxRetries: 2,
      priority: 85,
      autonomyState: {
        planner: {
          reasons: [],
        },
      },
      planningReasons: [],
    });
  });

  it('rejects health_echo without the bridge shared secret', async () => {
    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .send({
        gptId: 'arcanos-core',
        action: 'health_echo',
      });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      ok: false,
      status: 'unauthorized',
      error: {
        source: 'auth',
      },
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns the deterministic completed smoke response when the worker job completes inside the wait window', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-smoke-complete',
        status: 'pending',
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: {
        id: 'job-smoke-complete',
        job_type: 'gpt',
        status: 'completed',
        output: {
          ok: true,
          status: 'completed',
          output: 'OK',
        },
      },
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-shared-secret')
      .send({
        gptId: 'arcanos-core',
        action: 'health_echo',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      status: 'completed',
      output: 'OK',
    });
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledWith(
      'gpt',
      expect.objectContaining({
        gptId: 'arcanos-core',
        prompt: 'OK',
        routeHint: 'health_echo',
        requestPath: '/api/bridge/gpt',
        executionModeReason: 'bridge_health_echo',
        bridgeSmoke: true,
        bridgeAction: 'health_echo',
        body: expect.objectContaining({
          action: 'health_echo',
          bridgeSmoke: true,
          expectedOutput: 'OK',
        }),
      })
    );
  });

  it('returns a standard pending payload for health_echo when inline waiting is disabled', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-smoke-pending',
        status: 'pending',
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-shared-secret')
      .send({
        gptId: 'arcanos-core',
        action: 'health_echo',
        metadata: {
          waitForResultMs: 0,
        },
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'pending',
      action: 'health_echo',
      jobId: 'job-smoke-pending',
      poll_url: '/jobs/job-smoke-pending',
      result_url: '/jobs/job-smoke-pending/result',
      poll: '/jobs/job-smoke-pending',
      result: {
        method: 'GET',
        url: '/jobs/job-smoke-pending/result',
      },
    });
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          bridgeSmoke: true,
          bridgeAction: 'health_echo',
        }),
      })
    );
  });

  it('keeps query_and_wait on the normal queued model path', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-model-pending',
        status: 'pending',
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-model-pending',
        status: 'pending',
      },
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-shared-secret')
      .send({
        gptId: 'arcanos-core',
        action: 'query_and_wait',
        prompt: 'Return OK only.',
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'pending',
      action: 'query_and_wait',
      jobId: 'job-model-pending',
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          gptId: 'arcanos-core',
          prompt: 'Return OK only.',
          routeHint: 'query',
          executionModeReason: 'bridge_query_and_wait',
          body: expect.objectContaining({
            prompt: 'Return OK only.',
            executionMode: 'async',
          }),
        }),
      })
    );
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]?.input).not.toMatchObject({
      bridgeSmoke: true,
    });
  });

  it('exposes the deterministic smoke output through the canonical job result route', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-smoke-pending',
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-21T10:00:00.000Z',
      updated_at: '2026-04-21T10:00:01.000Z',
      completed_at: '2026-04-21T10:00:01.000Z',
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      error_message: null,
      output: {
        ok: true,
        status: 'completed',
        output: 'OK',
      },
      cancel_requested_at: null,
      cancel_reason: null,
    });

    const response = await request(buildApp()).get('/jobs/job-smoke-pending/result');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      jobId: 'job-smoke-pending',
      status: 'completed',
      result: {
        ok: true,
        status: 'completed',
        output: 'OK',
      },
      error: null,
    });
  });
});
