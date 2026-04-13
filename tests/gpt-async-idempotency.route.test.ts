import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
const resolveAsyncGptPollIntervalMsMock = jest.fn(() => 250);
const resolveAsyncGptWaitForResultMsMock = jest.fn((requested?: number) => requested ?? 3500);
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
  getJobById: getJobByIdMock,
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
  resolveAsyncGptPollIntervalMs: resolveAsyncGptPollIntervalMsMock,
  resolveAsyncGptWaitForResultMs: resolveAsyncGptWaitForResultMsMock
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
    delete process.env.GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS;
    delete process.env.GPT_ROUTE_HARD_TIMEOUT_MS;
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
  });

  it('returns stored completed job results for explicit get_result actions without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-lookup-complete',
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:03.000Z',
      completed_at: '2026-04-06T10:00:03.000Z',
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      output: {
        ok: true,
        result: {
          answer: 'stored output'
        }
      },
      error_message: null
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'job-lookup-complete'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      result: {
        jobId: 'job-lookup-complete',
        status: 'completed',
        jobStatus: 'completed',
        lifecycleStatus: 'completed',
        createdAt: '2026-04-06T10:00:00.000Z',
        updatedAt: '2026-04-06T10:00:03.000Z',
        completedAt: '2026-04-06T10:00:03.000Z',
        retentionUntil: null,
        idempotencyUntil: null,
        expiresAt: null,
        poll: '/jobs/job-lookup-complete',
        stream: '/jobs/job-lookup-complete/stream',
        result: {
          ok: true,
          result: {
            answer: 'stored output'
          }
        },
        error: null
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        action: 'get_result',
        route: 'job_result'
      })
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('accepts normalized get_result action variants without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-lookup-normalized',
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:03.000Z',
      completed_at: '2026-04-06T10:00:03.000Z',
      output: {
        ok: true,
        result: {
          answer: 'normalized output'
        }
      },
      error_message: null
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: ' Get_Result ',
        payload: {
          jobId: 'job-lookup-normalized'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      jobId: 'job-lookup-normalized',
      status: 'completed',
      result: {
        ok: true,
        result: {
          answer: 'normalized output'
        }
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only job identifiers for get_result actions', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: '   '
        }
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'JOB_ID_INVALID'
      },
      _route: {
        gptId: 'arcanos-core',
        action: 'get_result',
        route: 'job_result'
      }
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });
  it('returns explicit pending status for get_result without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-lookup-pending',
      job_type: 'gpt',
      status: 'running',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:01.000Z',
      completed_at: null,
      output: null,
      error_message: null
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'job-lookup-pending'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      jobId: 'job-lookup-pending',
      status: 'pending',
      jobStatus: 'running',
      lifecycleStatus: 'running',
      result: null,
      error: null
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns explicit expired status and preserved retained output for get_result without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-lookup-expired',
      job_type: 'gpt',
      status: 'expired',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:15:00.000Z',
      completed_at: '2026-04-06T10:01:30.000Z',
      retention_until: '2026-04-06T10:10:00.000Z',
      idempotency_until: '2026-04-06T10:05:00.000Z',
      expires_at: '2026-04-06T10:15:00.000Z',
      output: {
        ok: true,
        result: {
          answer: 'retained expired output'
        }
      },
      error_message: 'Expired after retention window.'
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'job-lookup-expired'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      jobId: 'job-lookup-expired',
      status: 'expired',
      jobStatus: 'expired',
      lifecycleStatus: 'expired',
      retentionUntil: '2026-04-06T10:10:00.000Z',
      idempotencyUntil: '2026-04-06T10:05:00.000Z',
      expiresAt: '2026-04-06T10:15:00.000Z',
      result: {
        ok: true,
        result: {
          answer: 'retained expired output'
        }
      },
      error: {
        code: 'JOB_EXPIRED',
        message: 'Expired after retention window.'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('returns explicit failed status for terminal get_result lookups without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-lookup-failed',
      job_type: 'gpt',
      status: 'failed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:02.000Z',
      completed_at: '2026-04-06T10:00:02.000Z',
      output: null,
      error_message: 'OpenAI upstream timed out'
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'job-lookup-failed'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      jobId: 'job-lookup-failed',
      status: 'failed',
      jobStatus: 'failed',
      lifecycleStatus: 'failed',
      result: null,
      error: {
        code: 'JOB_FAILED',
        message: 'OpenAI upstream timed out'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns explicit not_found status for missing get_result lookups without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue(null);

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'missing-job'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toEqual({
      jobId: 'missing-job',
      status: 'not_found',
      jobStatus: null,
      lifecycleStatus: 'not_found',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      retentionUntil: null,
      idempotencyUntil: null,
      expiresAt: null,
      poll: '/jobs/missing-job',
      stream: '/jobs/missing-job/stream',
      result: null,
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'Async GPT job was not found.'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns canonical job status for explicit get_status actions without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-status-running',
      job_type: 'gpt',
      status: 'running',
      created_at: '2026-04-11T10:00:00.000Z',
      updated_at: '2026-04-11T10:00:02.000Z',
      completed_at: null,
      cancel_requested_at: null,
      cancel_reason: null,
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      output: null,
      error_message: null
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'get_status',
        payload: {
          jobId: 'job-status-running'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      result: {
        id: 'job-status-running',
        job_type: 'gpt',
        status: 'running',
        lifecycle_status: 'running',
        created_at: '2026-04-11T10:00:00.000Z',
        updated_at: '2026-04-11T10:00:02.000Z',
        completed_at: null,
        cancel_requested_at: null,
        cancel_reason: null,
        retention_until: null,
        idempotency_until: null,
        expires_at: null,
        error_message: null,
        output: null,
        result: null
      },
      _route: expect.objectContaining({
        gptId: 'backstage-booker',
        action: 'get_status',
        route: 'job_status'
      })
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns 404 for missing get_status lookups without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue(null);

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_status',
        payload: {
          jobId: 'missing-status-job'
        }
      });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'Async GPT job was not found.'
      },
      _route: {
        gptId: 'arcanos-core',
        action: 'get_status',
        route: 'job_status'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only job identifiers for get_status actions', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_status',
        payload: {
          jobId: '   '
        }
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'JOB_ID_INVALID'
      },
      _route: {
        gptId: 'arcanos-core',
        action: 'get_status',
        route: 'job_status'
      }
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('uses a short inline wait budget for heavy async core requests', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-heavy',
        status: 'running'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-heavy',
        status: 'running'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Return a full distributed systems diagnosis for this latency incident'
      });

    expect(response.status).toBe(202);
    expect(resolveAsyncGptWaitForResultMsMock).toHaveBeenCalledWith(500);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-heavy',
      expect.objectContaining({
        waitForResultMs: 500,
        pollIntervalMs: 250
      })
    );
  });

  it('honors an explicit direct-return wait override for async GPT requests', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-direct-return',
        status: 'completed'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: {
        id: 'job-direct-return',
        status: 'completed',
        output: {
          ok: true,
          result: 'Generated Seth Rollins prompt',
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
        prompt: 'Generate a Seth Rollins promo prompt',
        executionMode: 'async',
        waitForResultMs: 12_000,
        pollIntervalMs: 100
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      jobId: 'job-direct-return',
      status: 'completed',
      lifecycleStatus: 'completed',
      result: 'Generated Seth Rollins prompt'
    });
    expect(resolveAsyncGptWaitForResultMsMock).toHaveBeenCalledWith(12_000);
    expect(resolveAsyncGptPollIntervalMsMock).toHaveBeenCalledWith(100);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-direct-return',
      expect.objectContaining({
        waitForResultMs: 5_250,
        pollIntervalMs: 250
      })
    );
  });

  it('honors a larger route timeout budget when configured for direct-return waits', async () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '60000';

    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-direct-return-expanded-timeout',
        status: 'completed'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: {
        id: 'job-direct-return-expanded-timeout',
        status: 'completed',
        output: {
          ok: true,
          result: 'Generated Seth Rollins prompt',
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
        prompt: 'Generate a Seth Rollins promo prompt',
        executionMode: 'async',
        waitForResultMs: 12_000,
        pollIntervalMs: 100
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      jobId: 'job-direct-return-expanded-timeout',
      status: 'completed',
      lifecycleStatus: 'completed',
      result: 'Generated Seth Rollins prompt'
    });
    expect(resolveAsyncGptWaitForResultMsMock).toHaveBeenCalledWith(12_000);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-direct-return-expanded-timeout',
      expect.objectContaining({
        waitForResultMs: 12_000,
        pollIntervalMs: 250
      })
    );
  });

  it('returns direct-return timeout guidance without creating a second job', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-timeout',
        status: 'running'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-timeout',
        status: 'running'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Generate a Seth Rollins promo prompt',
        executionMode: 'async',
        waitForResultMs: 20_000,
        pollIntervalMs: 125
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'pending',
      jobId: 'job-timeout',
      jobStatus: 'running',
      lifecycleStatus: 'running',
      instruction: 'Direct wait timed out after 5250ms. Use GET /jobs/job-timeout/result to retrieve the final result.',
      directReturn: {
        requested: true,
        timedOut: true,
        waitForResultMs: 5_250,
        pollIntervalMs: 250,
        poll: '/jobs/job-timeout',
        result: '/jobs/job-timeout/result'
      }
    });
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('supports explicit query_and_wait for non-core gpt ids without creating duplicate jobs', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-query-and-wait',
        status: 'completed'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: {
        id: 'job-query-and-wait',
        status: 'completed',
        output: {
          ok: true,
          result: 'Seth Rollins promo prompt',
          _route: {
            gptId: 'backstage-booker',
            module: 'BACKSTAGE:BOOKER',
            route: 'backstage-booker',
            timestamp: '2026-04-11T10:00:03.000Z'
          }
        }
      }
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'query_and_wait',
        prompt: 'Generate a Seth Rollins promo prompt'
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      jobId: 'job-query-and-wait',
      status: 'completed',
      lifecycleStatus: 'completed',
      result: 'Seth Rollins promo prompt'
    });
    expect(resolveAsyncGptWaitForResultMsMock).toHaveBeenCalledWith(25_000);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-query-and-wait',
      expect.objectContaining({
        waitForResultMs: 25_000,
        pollIntervalMs: 250
      })
    );
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toMatchObject({
      input: {
        gptId: 'backstage-booker',
        body: {
          prompt: 'Generate a Seth Rollins promo prompt',
          executionMode: 'async'
        },
        routeHint: 'query'
      }
    });
    expect((findOrCreateGptJobMock.mock.calls[0]?.[0] as { input?: { body?: Record<string, unknown> } }).input?.body?.action).toBeUndefined();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns query_and_wait timeout guidance with the same job id and one job creation only', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-query-and-wait-timeout',
        status: 'running'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-query-and-wait-timeout',
        status: 'running'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-gaming')
      .send({
        action: 'query_and_wait',
        prompt: 'Generate a Seth Rollins promo prompt',
        timeoutMs: 1,
        pollIntervalMs: 1
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'pending',
      jobId: 'job-query-and-wait-timeout',
      jobStatus: 'running',
      lifecycleStatus: 'running',
      instruction: 'Direct wait timed out after 1ms. Use GET /jobs/job-query-and-wait-timeout/result to retrieve the final result.',
      directReturn: {
        requested: true,
        timedOut: true,
        waitForResultMs: 1,
        pollIntervalMs: 250,
        poll: '/jobs/job-query-and-wait-timeout',
        result: '/jobs/job-query-and-wait-timeout/result'
      }
    });
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects query_and_wait requests without a prompt', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait'
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'PROMPT_REQUIRED'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('fails query_and_wait clearly when durable async jobs are unavailable instead of falling back to sync query routing', async () => {
    findOrCreateGptJobMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('jobs backend unavailable')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait',
        prompt: 'Generate a Seth Rollins promo prompt'
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'ASYNC_GPT_JOBS_UNAVAILABLE',
        message: 'query_and_wait requires durable GPT job persistence, but the jobs backend is unavailable.'
      },
      idempotencyKey: expect.stringMatching(/^derived:/)
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
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
