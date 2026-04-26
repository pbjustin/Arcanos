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
    deletedExpired: 0,
  })),
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
  resolveAsyncGptWaitForResultMs: resolveAsyncGptWaitForResultMsMock,
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

function buildFastPathEnvelope() {
  return {
    ok: true,
    result: {
      result: 'Write a crisp launch-email prompt.',
      module: 'fast_path',
      activeModel: 'gpt-test',
      routingStages: ['GPT-FAST-PATH'],
      fastPath: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: true,
        modelLatencyMs: 12,
        totalLatencyMs: 14,
        timeoutMs: 8_000,
      },
    },
    routeDecision: {
      path: 'fast_path',
      reason: 'simple_prompt_generation',
      queueBypassed: true,
      promptLength: 40,
      messageCount: 0,
      maxWords: null,
      timeoutMs: 8_000,
    },
    _route: {
      requestId: 'req-fast',
      gptId: 'arcanos-core',
      module: 'GPT:FAST_PATH',
      action: 'query',
      route: 'fast_path',
      timestamp: '2026-04-21T12:00:00.000Z',
    },
  };
}

function buildDirectActionEnvelope() {
  return {
    ok: true,
    result: {
      result: 'Direct action response.',
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
      modelLatencyMs: 10,
      totalLatencyMs: 12,
    },
    _route: {
      requestId: 'req-direct-action',
      gptId: 'arcanos-core',
      module: 'GPT:DIRECT_ACTION',
      action: 'query_and_wait',
      route: 'direct_action',
      timestamp: '2026-04-21T12:01:00.000Z',
    },
  };
}

const GPT_ROUTE_TEST_ENV_KEYS = [
  'GPT_ASYNC_HEAVY_PROMPT_CHARS',
  'GPT_ASYNC_HEAVY_MESSAGE_COUNT',
  'GPT_ASYNC_HEAVY_MAX_WORDS',
  'GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS',
  'GPT_FAST_PATH_ENABLED',
  'GPT_FAST_PATH_GPT_ALLOWLIST',
  'GPT_FAST_PATH_MAX_PROMPT_CHARS',
  'GPT_FAST_PATH_MAX_MESSAGE_COUNT',
  'GPT_FAST_PATH_MAX_WORDS',
  'GPT_FAST_PATH_TIMEOUT_MS',
  'GPT_PUBLIC_RESPONSE_MAX_BYTES',
  'GPT_ROUTE_ASYNC_CORE_DEFAULT',
  'GPT_ROUTE_HARD_TIMEOUT_MS',
  'PRIORITY_QUEUE_ENABLED',
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

const originalRouteTestEnv = captureEnv(GPT_ROUTE_TEST_ENV_KEYS);

describe('GPT fast-path route branching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of GPT_ROUTE_TEST_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.PRIORITY_QUEUE_ENABLED = 'false';
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
    executeFastGptPromptMock.mockResolvedValue(buildFastPathEnvelope());
    executeDirectGptActionMock.mockResolvedValue(buildDirectActionEnvelope());
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
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: 'job-orchestrated',
        status: 'pending',
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'pending',
      job: {
        id: 'job-orchestrated',
        status: 'pending',
      },
    });
  });

  afterEach(() => {
    restoreEnv(originalRouteTestEnv);
  });

  it('returns eligible prompt-generation requests inline without queue submission', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Generate a prompt for a launch email.',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision']).toBe('fast_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('simple_prompt_generation');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('true');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        result: 'Write a crisp launch-email prompt.',
        module: 'fast_path',
        activeModel: 'gpt-test',
      },
      routeDecision: {
        path: 'fast_path',
        queueBypassed: true,
      },
      _route: {
        gptId: 'arcanos-core',
        route: 'fast_path',
      },
    });
    expect(executeFastGptPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        prompt: 'Generate a prompt for a launch email.',
        timeoutMs: 8_000,
        routeDecision: expect.objectContaining({
          path: 'fast_path',
          reason: 'simple_prompt_generation',
          timeoutMs: 8_000,
        }),
      })
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('runs core query_and_wait through the direct action lane by default', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait',
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision']).toBe('fast_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('query_and_wait_direct_action');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('true');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: true,
      gptId: 'arcanos-core',
      action: 'query_and_wait',
      status: 'completed',
      result: 'Direct action response.',
      routeDecision: {
        path: 'fast_path',
        reason: 'query_and_wait_direct_action',
        queueBypassed: true,
        action: 'query_and_wait',
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
      },
    });
    expect(executeDirectGptActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment timeout.',
        action: 'query_and_wait',
        timeoutMs: 24_000,
      })
    );
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('recognizes query_and_wait supplied as a request query parameter', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core?action=query_and_wait')
      .send({
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision']).toBe('fast_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('query_and_wait_direct_action');
    expect(response.body).toMatchObject({
      ok: true,
      gptId: 'arcanos-core',
      action: 'query_and_wait',
      status: 'completed',
      _route: {
        module: 'GPT:DIRECT_ACTION',
        action: 'query_and_wait',
        route: 'direct_action',
      },
    });
    expect(executeDirectGptActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment timeout.',
        action: 'query_and_wait',
      })
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('recognizes operation-style query_and_wait action aliases', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        operationId: 'requestQueryAndWait',
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision-reason']).toBe('query_and_wait_direct_action');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query_and_wait',
      _route: {
        module: 'GPT:DIRECT_ACTION',
        action: 'query_and_wait',
        route: 'direct_action',
      },
    });
    expect(executeDirectGptActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Analyze this deployment timeout.',
        action: 'query_and_wait',
      })
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns a typed error instead of bounded fallback when direct query_and_wait times out', async () => {
    const timeoutError = new Error('GPT direct action timeout after 24000ms');
    timeoutError.name = 'AbortError';
    executeDirectGptActionMock.mockRejectedValueOnce(timeoutError);

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait',
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'GPT_QUERY_AND_WAIT_TIMEOUT',
        message: 'GPT direct action timeout after 24000ms',
      },
      routeDecision: {
        reason: 'query_and_wait_direct_action',
      },
      _route: {
        gptId: 'arcanos-core',
        action: 'query_and_wait',
        route: 'query_and_wait_direct',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('bounded fallback response');
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns service unavailable when the direct action client is unavailable', async () => {
    executeDirectGptActionMock.mockRejectedValueOnce(
      new Error('OpenAI client unavailable for GPT direct action.')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait',
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'GPT_QUERY_AND_WAIT_FAILED',
        message: 'OpenAI client unavailable for GPT direct action.',
      },
      _route: {
        action: 'query_and_wait',
        route: 'query_and_wait_direct',
      },
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns internal error when direct action execution produces no output', async () => {
    executeDirectGptActionMock.mockRejectedValueOnce(
      new Error('GPT direct action returned empty output.')
    );

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query_and_wait',
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'GPT_QUERY_AND_WAIT_FAILED',
        message: 'GPT direct action returned empty output.',
      },
      _route: {
        action: 'query_and_wait',
        route: 'query_and_wait_direct',
      },
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('keeps small non-prompt-generation core requests on the bounded direct path by default', async () => {
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        result: 'Direct core response.',
      },
      _route: {
        requestId: 'req-core-direct',
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        action: 'query',
        route: 'core',
        matchMethod: 'direct',
        availableActions: [],
        timestamp: '2026-04-21T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('no_prompt_generation_intent');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        result: 'Direct core response.',
      },
      _route: {
        gptId: 'arcanos-core',
        route: 'core',
      },
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        body: {
          prompt: 'Analyze this deployment timeout.',
        },
      })
    );
  });

  it('preserves the legacy async core default when explicitly enabled', async () => {
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'true';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('no_prompt_generation_intent');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-orchestrated',
      _route: {
        gptId: 'arcanos-core',
        route: 'async',
      },
    });
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledWith(
      'gpt',
      expect.objectContaining({
        executionModeReason: 'core_query_async_default',
      })
    );
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('keeps explicit async core requests on the job path', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze this deployment timeout.',
        executionMode: 'async',
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('explicit_orchestrated_mode');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-orchestrated',
      _route: {
        gptId: 'arcanos-core',
        route: 'async',
      },
    });
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledWith(
      'gpt',
      expect.objectContaining({
        executionModeReason: 'explicit_async_request',
      })
    );
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('keeps heavy core requests on the async job path without the legacy default', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze this deployment timeout.',
        maxWords: 900,
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('no_prompt_generation_intent');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-orchestrated',
      _route: {
        gptId: 'arcanos-core',
        route: 'async',
      },
    });
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledWith(
      'gpt',
      expect.objectContaining({
        executionModeReason: 'heavy_prompt_auto_async',
      })
    );
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('reports actual queue bypass for sync module-dispatch responses', async () => {
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        result: 'Synchronous module response.',
      },
      _route: {
        requestId: 'req-sync',
        gptId: 'support-bot',
        module: 'GPT:SUPPORT',
        action: 'query',
        route: 'query',
        matchMethod: 'direct',
        availableActions: [],
        timestamp: '2026-04-21T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/support-bot')
      .send({
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('no_prompt_generation_intent');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        result: 'Synchronous module response.',
      },
      _route: {
        gptId: 'support-bot',
        route: 'query',
      },
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
  });

  it('does not fast-path non-prompt-generation requests even when fast mode is requested', async () => {
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        result: 'Direct core response.',
      },
      _route: {
        requestId: 'req-core-fast-rejected',
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        action: 'query',
        route: 'core',
        matchMethod: 'direct',
        availableActions: [],
        timestamp: '2026-04-21T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze this deployment timeout.',
        executionMode: 'fast',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('no_prompt_generation_intent');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        result: 'Direct core response.',
      },
      _route: {
        gptId: 'arcanos-core',
        route: 'core',
      },
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed payload shapes before queue submission', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Generate a prompt for a launch email.',
        executionMode: 'fast',
        payload: 'operators',
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('invalid_payload_shape_requires_module_dispatch');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'GPT request payload must be a JSON object when provided.',
      },
      routeDecision: {
        path: 'orchestrated_path',
        reason: 'invalid_payload_shape_requires_module_dispatch',
      },
      _route: {
        route: 'async',
      },
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('falls back to the orchestrated path when inline fast-path execution is unavailable', async () => {
    executeFastGptPromptMock.mockRejectedValueOnce(new Error('OpenAI client unavailable for GPT fast path.'));

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Generate a prompt for a launch email.',
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('fast_path_fallback');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-orchestrated',
    });
    expect(executeFastGptPromptMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the explicit async query bridge for prompt-generation prompts', async () => {
    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'query',
        prompt: 'Generate a promo prompt.',
        executionMode: 'fast',
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('explicit_action_preserves_async_bridge');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-orchestrated',
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
  });
});
