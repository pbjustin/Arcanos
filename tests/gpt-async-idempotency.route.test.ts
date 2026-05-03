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

  describe('deprecated GPT-route job lookup compatibility', () => {
    async function expectGptJobLookupControlRejected(options: {
      gptId?: string;
      action: string;
      expectedAction?: string;
      jobId?: string;
    }) {
      const gptId = options.gptId ?? 'arcanos-core';
      const expectedAction = options.expectedAction ?? options.action.trim().toLowerCase();
      const response = await request(buildApp())
        .post(`/gpt/${gptId}`)
        .send({
          action: options.action,
          payload: {
            jobId: options.jobId ?? 'job-lookup-control'
          }
        });

      expect(response.status).toBe(400);
      expect(response.headers['x-response-bytes']).toBeTruthy();
      expect(response.body).toMatchObject({
        ok: false,
        gptId,
        action: expectedAction,
        route: '/gpt/:gptId',
        traceId: expect.any(String),
        error: {
          code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
          message: expect.stringContaining('/gpt-access/*')
        },
        canonical: expect.objectContaining({
          jobStatus: '/gpt-access/jobs/result',
          jobResult: '/gpt-access/jobs/result',
          gptAccessJobResult: '/gpt-access/jobs/result'
        }),
        _route: expect.objectContaining({
          gptId,
          action: expectedAction,
          route: 'control_guard'
        })
      });
      expect(response.body).not.toHaveProperty('result');
      expect(getJobByIdMock).not.toHaveBeenCalled();
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
      expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }

    it.each([
      ['completed result lookup', { action: 'get_result', jobId: 'job-lookup-complete' }],
      ['pending result lookup', { action: 'get_result', jobId: 'job-lookup-pending' }],
      ['failed result lookup', { action: 'get_result', jobId: 'job-lookup-failed' }],
      ['missing result lookup', { action: 'get_result', jobId: 'missing-job' }],
      ['whitespace result job id', { action: 'get_result', jobId: '   ' }],
      [
        'normalized result action variant',
        { action: ' Get_Result ', expectedAction: 'get_result', jobId: 'job-lookup-normalized' }
      ],
      [
        'status lookup for another GPT id',
        { gptId: 'backstage-booker', action: 'get_status', jobId: 'job-status-running' }
      ],
      ['missing status lookup', { action: 'get_status', jobId: 'missing-status-job' }],
      ['whitespace status job id', { action: 'get_status', jobId: '   ' }],
      ['storage-invalid status job id shape', { action: 'get_status', jobId: 'missing-job-for-smoke' }]
    ])('rejects %s through /gpt/:gptId before storage lookup', async (_label, options) => {
      await expectGptJobLookupControlRejected(options);
    });
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
