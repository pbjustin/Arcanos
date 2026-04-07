import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const findOrCreateGptJobMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
  getJobById: jest.fn(),
  createJob: jest.fn(),
  claimNextPendingJob: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  recoverStaleJobs: jest.fn(),
  updateJob: jest.fn(),
  getLatestJob: jest.fn(),
  listFailedJobs: jest.fn(async () => []),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn(),
  requestJobCancellation: jest.fn(),
  cleanupExpiredGptJobs: jest.fn(async () => ({
    expiredPending: 0,
    expiredTerminal: 0,
    deletedExpired: 0
  }))
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: planAutonomousWorkerJobMock
}));

jest.unstable_mockModule('../src/services/queuedGptCompletionService.js', () => ({
  waitForQueuedGptJobCompletion: waitForQueuedGptJobCompletionMock,
  resolveAsyncGptPollIntervalMs: jest.fn(() => 250),
  resolveAsyncGptWaitForResultMs: jest.fn(() => 3500)
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

describe('async /gpt idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
    planAutonomousWorkerJobMock.mockResolvedValue({
      status: 'pending',
      retryCount: 0,
      maxRetries: 2,
      priority: 85,
      autonomyState: {
        planner: {
          reasons: []
        }
      },
      planningReasons: []
    });
  });

  it('returns the canonical in-flight job when an equivalent async request is deduped', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-123',
        status: 'running'
      },
      created: false,
      deduped: true,
      dedupeReason: 'reused_inflight_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-123',
        status: 'running'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze   this deployment timeout'
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      status: 'pending',
      jobId: 'job-123',
      poll: '/jobs/job-123',
      stream: '/jobs/job-123/stream',
      jobStatus: 'running',
      lifecycleStatus: 'running',
      deduped: true,
      idempotencyKey: expect.stringMatching(/^derived:/),
      idempotencySource: 'derived',
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'async'
      })
    });
  });

  it('reuses a completed result for duplicate async submissions', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-456',
        status: 'completed'
      },
      created: false,
      deduped: true,
      dedupeReason: 'reused_completed_result'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: {
        id: 'job-456',
        status: 'completed',
        created_at: '2026-04-06T10:00:00.000Z',
        started_at: '2026-04-06T10:00:01.000Z',
        completed_at: '2026-04-06T10:00:03.000Z',
        output: {
          ok: true,
          result: {
            answer: 'done'
          },
          _route: {
            gptId: 'arcanos-core',
            module: 'ARCANOS:CORE',
            route: 'core',
            timestamp: '2026-04-06T10:00:03.000Z'
          }
        }
      }
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze the deployment timeout'
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      jobId: 'job-456',
      status: 'completed',
      lifecycleStatus: 'completed',
      poll: '/jobs/job-456',
      stream: '/jobs/job-456/stream',
      deduped: true,
      result: {
        answer: 'done'
      }
    });
  });

  it('collapses concurrent identical submissions onto one canonical job id', async () => {
    let callCount = 0;
    findOrCreateGptJobMock.mockImplementation(async () => {
      callCount += 1;
      return callCount === 1
        ? {
            job: {
              id: 'job-777',
              status: 'pending'
            },
            created: true,
            deduped: false,
            dedupeReason: 'new_job'
          }
        : {
            job: {
              id: 'job-777',
              status: 'pending'
            },
            created: false,
            deduped: true,
            dedupeReason: 'reused_inflight_job'
          };
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-777',
        status: 'pending'
      }
    });

    const [firstResponse, secondResponse] = await Promise.all([
      request(buildApp()).post('/gpt/arcanos-core').send({ prompt: 'Collapse duplicates safely' }),
      request(buildApp()).post('/gpt/arcanos-core').send({ prompt: 'Collapse duplicates safely' })
    ]);

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstResponse.body.jobId).toBe('job-777');
    expect(secondResponse.body.jobId).toBe('job-777');
    expect(secondResponse.body.deduped).toBe(true);
  });

  it('rejects explicit idempotency key reuse for a different semantic request', async () => {
    findOrCreateGptJobMock.mockRejectedValue(
      new MockIdempotencyKeyConflictError(
        'Explicit idempotency key mapped to a different GPT request fingerprint.'
      )
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Idempotency-Key', 'retry-123')
      .send({
        prompt: 'First prompt body'
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_KEY_CONFLICT'
      },
      idempotencyKey: 'retry-123'
    });
  });

  it('falls back to synchronous dispatch when async job persistence is unavailable', async () => {
    findOrCreateGptJobMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('Database not configured')
    );
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        result: '[MOCK RESPONSE] sync fallback'
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Fallback to sync when queue persistence is offline'
      });

    expect(response.status).toBe(200);
    expect(response.body.result?.result).toContain('sync fallback');
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        body: {
          prompt: 'Fallback to sync when queue persistence is offline'
        }
      })
    );
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('returns 503 for explicit idempotency when durable persistence is unavailable', async () => {
    findOrCreateGptJobMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('Database not configured')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Idempotency-Key', 'retry-offline')
      .send({
        prompt: 'Persist this safely'
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_UNAVAILABLE'
      },
      idempotencyKey: 'retry-offline'
    });
  });
});
