import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findOrCreateGptJobMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
const resolveAsyncGptPollIntervalMsMock = jest.fn((requested?: number) => requested ?? 250);
const resolveAsyncGptWaitForResultMsMock = jest.fn((requested?: number) => requested ?? 3500);

class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
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
const { buildGptRequestFingerprintHash } = await import('../src/shared/gpt/gptIdempotency.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/', bridgeRouter);
  return app;
}

function buildJob(id: string, status: string, output: unknown = null) {
  return {
    id,
    job_type: 'gpt',
    status,
    created_at: '2026-04-16T12:00:00.000Z',
    started_at: status === 'pending' ? null : '2026-04-16T12:00:01.000Z',
    completed_at: status === 'completed' ? '2026-04-16T12:00:02.000Z' : null,
    output,
  };
}

describe('Custom GPT bridge route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_ACTION_SHARED_SECRET = 'test-bridge-secret';
    process.env.DEFAULT_GPT_ID = 'arcanos-core';
    delete process.env.OPENAI_ACTION_BRIDGE_WAIT_TIMEOUT_MS;
    delete process.env.OPENAI_ACTION_BRIDGE_QUERY_WAIT_TIMEOUT_MS;
    delete process.env.OPENAI_ACTION_BRIDGE_POLL_INTERVAL_MS;
    delete process.env.OPENAI_ACTION_BRIDGE_FAILURE_COUNTER_WINDOW_MS;
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

  it('rejects requests with an invalid bridge shared secret', async () => {
    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer wrong-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'unauthorized',
        error: expect.objectContaining({
          source: 'auth',
        }),
      }),
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns a pending async job response for query actions', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-pending-123', 'pending'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
        metadata: {
          source: 'custom-gpt',
        },
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        status: 'pending',
        jobId: 'job-pending-123',
        poll_url: '/jobs/job-pending-123',
        result_url: '/jobs/job-pending-123/result',
        action: 'query',
      }),
    );
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: 'Analyze this deployment',
          body: expect.objectContaining({
            prompt: 'Analyze this deployment',
          }),
        }),
      }),
    );
    const jobOptions = findOrCreateGptJobMock.mock.calls[0]?.[0];
    const legacyFingerprintHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Analyze this deployment',
        action: 'query',
      },
    });
    const bridgeFingerprintHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Analyze this deployment',
        action: 'query',
        bridgeFingerprintVersion: 2,
      },
    });
    expect(jobOptions?.requestFingerprintHash).toBe(bridgeFingerprintHash);
    expect(jobOptions?.requestFingerprintHash).not.toBe(legacyFingerprintHash);
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('returns completed output immediately when a query dedupes to a completed job', async () => {
    const completedJob = buildJob('job-deduped-completed-123', 'completed', {
      ok: true,
      result: 'cached output',
    });
    findOrCreateGptJobMock.mockResolvedValue({
      job: completedJob,
      created: false,
      deduped: true,
      dedupeReason: 'reused_completed_result',
    });

    const response = await request(buildApp())
      .post('/api/openai/gpt-action')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        status: 'completed',
        jobId: 'job-deduped-completed-123',
        output: 'cached output',
        observability: expect.objectContaining({
          deduped: true,
        }),
      }),
    );
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid DEFAULT_GPT_ID before enqueueing work', async () => {
    process.env.DEFAULT_GPT_ID = 'x'.repeat(129);

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'misconfigured',
        error: expect.objectContaining({
          source: 'routing',
          message: expect.stringContaining('DEFAULT_GPT_ID is invalid'),
        }),
      }),
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns a completed output when query_and_wait finishes within the wait window', async () => {
    const completedJob = buildJob('job-completed-123', 'completed', {
      ok: true,
      result: {
        answer: 'Deployment is healthy.',
      },
    });
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-completed-123', 'running'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: completedJob,
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('x-openai-action-secret', 'test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query_and_wait',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        status: 'completed',
        jobId: 'job-completed-123',
        poll_url: '/jobs/job-completed-123',
        result_url: '/jobs/job-completed-123/result',
        output: {
          answer: 'Deployment is healthy.',
        },
      }),
    );
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith('job-completed-123', {
      waitForResultMs: 3500,
      pollIntervalMs: 250,
    });
  });
});
