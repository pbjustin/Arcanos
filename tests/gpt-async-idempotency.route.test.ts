import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const executeFastGptPromptMock = jest.fn();
const executeDirectGptActionMock = jest.fn();
const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
const resolveAsyncGptPollIntervalMsMock = jest.fn(() => 250);
const resolveAsyncGptWaitForResultMsMock = jest.fn((requested?: number) => requested ?? 3500);
const tryAcquirePriorityGptDirectExecutionSlotMock = jest.fn(() => null);
const startReservedPriorityGptDirectExecutionMock = jest.fn();
class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/services/gptFastPath.js', () => ({
  executeFastGptPrompt: executeFastGptPromptMock,
  executeDirectGptAction: executeDirectGptActionMock,
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
  deferJobForProviderRecovery: jest.fn(),
  recoverStaleJobs: jest.fn(),
  updateJob: jest.fn(),
  getLatestJob: jest.fn(),
  listFailedJobs: jest.fn(async () => []),
  requeueFailedJob: jest.fn(),
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
  planAutonomousWorkerJob: planAutonomousWorkerJobMock,
  getWorkerAutonomyHealthReport: jest.fn(async () => ({
    status: 'ok',
    workers: [],
  })),
  getWorkerAutonomySettings: jest.fn(() => ({
    enabled: false,
    mode: 'off',
  })),
}));

jest.unstable_mockModule('../src/services/queuedGptCompletionService.js', () => ({
  waitForQueuedGptJobCompletion: waitForQueuedGptJobCompletionMock,
  resolveAsyncGptPollIntervalMs: resolveAsyncGptPollIntervalMsMock,
  resolveAsyncGptWaitForResultMs: resolveAsyncGptWaitForResultMsMock
}));

jest.unstable_mockModule('../src/services/priorityGptDirectExecutionService.js', () => ({
  tryAcquirePriorityGptDirectExecutionSlot: tryAcquirePriorityGptDirectExecutionSlotMock,
  startReservedPriorityGptDirectExecution: startReservedPriorityGptDirectExecutionMock,
  getPriorityGptDirectExecutionSnapshot: jest.fn(() => ({
    active: 0,
    capacity: 1,
    available: 1
  }))
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

const ASYNC_IDEMPOTENCY_ENV_KEYS = [
  'GPT_ASYNC_HEAVY_PROMPT_CHARS',
  'GPT_ASYNC_HEAVY_MESSAGE_COUNT',
  'GPT_ASYNC_HEAVY_MAX_WORDS',
  'GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS',
  'GPT_PUBLIC_RESPONSE_MAX_BYTES',
  'GPT_ROUTE_ASYNC_CORE_DEFAULT',
  'GPT_ROUTE_HARD_TIMEOUT_MS',
  'PRIORITY_QUEUE_ENABLED',
  'GPT_DIRECT_EXECUTION_THRESHOLD_MS',
  'GPT_WAIT_TIMEOUT_MS',
] as const;

function captureEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [key, originalValue] of snapshot) {
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

function buildDirectActionEnvelope(result = 'OK') {
  return {
    ok: true,
    result: {
      result,
      module: 'direct_action',
      activeModel: 'gpt-test',
      routingStages: ['GPT-DIRECT-ACTION'],
      directAction: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: true,
        timeoutMs: 24_000,
      },
    },
    directAction: {
      inline: true,
      queueBypassed: true,
      orchestrationBypassed: true,
      action: 'query_and_wait',
      timeoutMs: 24_000,
      modelLatencyMs: 1,
      totalLatencyMs: 2,
    },
    _route: {
      requestId: 'req-direct-action',
      gptId: 'arcanos-core',
      module: 'GPT:DIRECT_ACTION',
      action: 'query_and_wait',
      route: 'direct_action',
      timestamp: '2026-04-24T00:00:00.000Z',
    },
  };
}

describe('async /gpt idempotency', () => {
  const originalAsyncIdempotencyEnv = captureEnv(ASYNC_IDEMPOTENCY_ENV_KEYS);

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ASYNC_IDEMPOTENCY_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'true';
    process.env.PRIORITY_QUEUE_ENABLED = 'false';
    executeDirectGptActionMock.mockResolvedValue(buildDirectActionEnvelope());
    mockResolveGptRouting.mockImplementation(async (gptId: string) => ({
      ok: true,
      plan: {
        matchedId: gptId,
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact'
      },
      _route: {
        gptId,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-24T00:00:00.000Z'
      }
    }));
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

  afterEach(() => {
    restoreEnv(originalAsyncIdempotencyEnv);
  });

  it('rejects unknown GPT IDs before creating async jobs', async () => {
    mockResolveGptRouting.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'UNKNOWN_GPT',
        message: "gptId 'invalid-id' is not registered"
      },
      _route: {
        gptId: 'invalid-id',
        timestamp: '2026-04-24T00:00:00.000Z'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/invalid-id')
      .send({
        action: 'query',
        prompt: 'This should not enter the queue.'
      });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNKNOWN_GPT'
      },
      _route: {
        gptId: 'invalid-id'
      }
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
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
      action: 'query',
      status: 'running',
      jobId: 'job-123',
      result: {},
      poll: '/jobs/job-123/result',
      stream: '/jobs/job-123/stream',
      timedOut: false,
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: true,
      action: 'get_result',
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
      poll: '/jobs/job-lookup-complete/result',
      stream: '/jobs/job-lookup-complete/stream',
      output: {
        ok: true,
        result: {
          answer: 'stored output'
        }
      },
      error: null,
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
        poll: '/jobs/job-lookup-complete/result',
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      action: 'get_result',
      jobId: 'job-lookup-normalized',
      status: 'completed',
      output: {
        ok: true,
        result: {
          answer: 'normalized output'
        }
      },
    });
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
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

  it('returns structured validation errors when get_result job identifiers are rejected by storage', async () => {
    getJobByIdMock.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid: "missing-job-for-smoke"')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_result',
        payload: {
          jobId: 'missing-job-for-smoke'
        }
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      gptId: 'arcanos-core',
      action: 'get_result',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      jobId: 'missing-job-for-smoke',
      error: {
        code: 'JOB_ID_INVALID',
        message: expect.stringContaining('valid job identifier')
      },
      _route: {
        gptId: 'arcanos-core',
        action: 'get_result',
        route: 'job_result'
      }
    });
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      action: 'get_result',
      jobId: 'job-lookup-pending',
      status: 'pending',
      jobStatus: 'running',
      lifecycleStatus: 'running',
      output: null,
      error: null,
      result: {
        jobId: 'job-lookup-pending',
        status: 'pending',
        jobStatus: 'running',
        lifecycleStatus: 'running',
        result: null,
        error: null
      }
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      action: 'get_result',
      jobId: 'job-lookup-expired',
      status: 'expired',
      jobStatus: 'expired',
      lifecycleStatus: 'expired',
      retentionUntil: '2026-04-06T10:10:00.000Z',
      idempotencyUntil: '2026-04-06T10:05:00.000Z',
      expiresAt: '2026-04-06T10:15:00.000Z',
      output: {
        ok: true,
        result: {
          answer: 'retained expired output'
        }
      },
      error: {
        code: 'JOB_EXPIRED',
        message: 'Expired after retention window.'
      },
      result: {
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
    expect(response.body).toMatchObject({
      action: 'get_result',
      jobId: 'job-lookup-failed',
      status: 'failed',
      jobStatus: 'failed',
      lifecycleStatus: 'failed',
      output: null,
      error: {
        code: 'JOB_FAILED',
        message: 'OpenAI upstream timed out'
      },
      result: {
        jobId: 'job-lookup-failed',
        status: 'failed',
        jobStatus: 'failed',
        lifecycleStatus: 'failed',
        result: null,
        error: {
          code: 'JOB_FAILED',
          message: 'OpenAI upstream timed out'
        }
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      ok: false,
      gptId: 'arcanos-core',
      action: 'get_result',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
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
      poll: '/jobs/missing-job/result',
      stream: '/jobs/missing-job/stream',
      output: null,
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'Async GPT job was not found.'
      },
      result: {
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
        poll: '/jobs/missing-job/result',
        stream: '/jobs/missing-job/stream',
        result: null,
        error: {
          code: 'JOB_NOT_FOUND',
          message: 'Async GPT job was not found.'
        }
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        action: 'get_result',
        route: 'job_result'
      })
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: true,
      action: 'get_status',
      jobId: 'job-status-running',
      status: 'running',
      lifecycleStatus: 'running',
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
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

  it('returns structured validation errors when get_status job identifiers are rejected by storage', async () => {
    getJobByIdMock.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid: "missing-job-for-smoke"')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'get_status',
        payload: {
          jobId: 'missing-job-for-smoke'
        }
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      gptId: 'arcanos-core',
      action: 'get_status',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      jobId: 'missing-job-for-smoke',
      error: {
        code: 'JOB_ID_INVALID',
        message: expect.stringContaining('valid job identifier')
      },
      _route: {
        gptId: 'arcanos-core',
        action: 'get_status',
        route: 'job_status'
      }
    });
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
      status: 'timeout',
      jobId: 'job-timeout',
      result: {},
      poll: '/jobs/job-timeout/result',
      stream: '/jobs/job-timeout/stream',
      timedOut: true,
      jobStatus: 'running',
      lifecycleStatus: 'running',
      instruction: 'Direct wait timed out after 5250ms. Use GET /jobs/job-timeout/result to retrieve the final result.',
      directReturn: {
        requested: true,
        timedOut: true,
        waitForResultMs: 5_250,
        pollIntervalMs: 250,
        poll: '/jobs/job-timeout/result',
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
    expect(resolveAsyncGptWaitForResultMsMock).toHaveBeenCalledWith(24_000);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-query-and-wait',
      expect.objectContaining({
        waitForResultMs: 24_000,
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

  it('keeps core query_and_wait prompt execution on the direct action lane', async () => {
    process.env.GPT_PUBLIC_RESPONSE_MAX_BYTES = '5000';
    executeDirectGptActionMock.mockResolvedValueOnce(buildDirectActionEnvelope('OK'));

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait',
        prompt: 'Reply with OK'
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toMatchObject({
      ok: true,
      gptId: 'arcanos-core',
      action: 'query_and_wait',
      status: 'completed',
      result: 'OK',
      routeDecision: {
        path: 'fast_path',
        reason: 'query_and_wait_direct_action',
        queueBypassed: true,
      },
      directAction: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: true,
        action: 'query_and_wait',
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'GPT:DIRECT_ACTION',
        action: 'query_and_wait',
        route: 'direct_action',
      }
    });
    expect(response.body.meta).toBeUndefined();
    expect(executeDirectGptActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        prompt: 'Reply with OK',
        action: 'query_and_wait',
        timeoutMs: 24_000,
      })
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('supports explicit query by creating one durable writing job without waiting for completion', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-query',
        status: 'pending'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-query',
        status: 'pending'
      }
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'query',
        prompt: 'Draft the next promo'
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-query',
      result: {},
      poll: '/jobs/job-query/result',
      timedOut: false,
      jobStatus: 'pending',
      lifecycleStatus: 'queued'
    });
    expect(resolveAsyncGptWaitForResultMsMock).toHaveBeenCalledWith(0);
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toMatchObject({
      input: {
        gptId: 'backstage-booker',
        body: {
          prompt: 'Draft the next promo'
        },
        routeHint: 'query'
      }
    });
    expect((findOrCreateGptJobMock.mock.calls[0]?.[0] as { input?: { body?: Record<string, unknown> } }).input?.body?.action).toBe('query');
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('keeps the exact prompt on async query jobs when callers provide transport hints inside payload', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-query-payload-async',
        status: 'pending'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query',
        prompt: 'Reply with exactly OK.',
        payload: {
          executionMode: 'async'
        }
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-query-payload-async',
      result: {},
      poll: '/jobs/job-query-payload-async/result',
      timedOut: false,
      jobStatus: 'pending',
      lifecycleStatus: 'queued'
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toMatchObject({
      input: {
        gptId: 'arcanos-core',
        prompt: 'Reply with exactly OK.',
        bypassIntentRouting: true,
        body: {
          action: 'query',
          prompt: 'Reply with exactly OK.',
          payload: {
            executionMode: 'async'
          }
        },
        routeHint: 'query'
      }
    });
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
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
      status: 'timeout',
      jobId: 'job-query-and-wait-timeout',
      result: {},
      poll: '/jobs/job-query-and-wait-timeout/result',
      timedOut: true,
      jobStatus: 'running',
      lifecycleStatus: 'running',
      instruction: 'Direct wait timed out after 1ms. Use GET /jobs/job-query-and-wait-timeout/result to retrieve the final result.',
      directReturn: {
        requested: true,
        timedOut: true,
        waitForResultMs: 1,
        pollIntervalMs: 250,
        poll: '/jobs/job-query-and-wait-timeout/result',
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'PROMPT_REQUIRED'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('rejects query requests without a prompt', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query'
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      action: 'query',
      error: {
        code: 'PROMPT_REQUIRED'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('ignores direct-wait controls for query requests so query_and_wait stays the only wait-capable action', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-query-ignore-wait',
        status: 'pending'
      },
      deduped: false,
      dedupeReason: 'new_job'
    });
    planAutonomousWorkerJobMock.mockResolvedValue({ planned: true });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query',
        prompt: 'Create the writing job only.',
        waitForResultMs: 5000,
        pollIntervalMs: 250
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-query-ignore-wait'
    });
    expect(response.body).not.toHaveProperty('directReturn');
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('fails non-core query_and_wait clearly when durable async jobs are unavailable instead of falling back to sync query routing', async () => {
    findOrCreateGptJobMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('jobs backend unavailable')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-gaming')
      .send({
        action: 'query_and_wait',
        prompt: 'Generate a Seth Rollins promo prompt'
      });

    expect(response.status).toBe(503);
    expect(response.headers['x-response-bytes']).toBeTruthy();
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

  it('fails query clearly when durable async jobs are unavailable instead of falling back to sync query routing', async () => {
    findOrCreateGptJobMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('jobs backend unavailable')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query',
        prompt: 'Generate a Seth Rollins promo prompt'
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'query',
      error: {
        code: 'ASYNC_GPT_JOBS_UNAVAILABLE',
        message: 'query requires durable GPT job persistence, but the jobs backend is unavailable.'
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
      jobStatus: 'completed',
      poll: '/jobs/job-456/result',
      stream: '/jobs/job-456/stream',
      timedOut: false,
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_UNAVAILABLE'
      },
      idempotencyKey: 'retry-offline'
    });
  });
});
