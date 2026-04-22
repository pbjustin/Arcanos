import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const executeFastGptPromptMock = jest.fn();
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

jest.unstable_mockModule('../src/services/gptFastPath.js', () => ({
  executeFastGptPrompt: executeFastGptPromptMock,
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

describe('GPT fast-path route branching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GPT_FAST_PATH_ENABLED;
    delete process.env.GPT_FAST_PATH_GPT_ALLOWLIST;
    delete process.env.GPT_FAST_PATH_MAX_PROMPT_CHARS;
    delete process.env.GPT_FAST_PATH_MAX_MESSAGE_COUNT;
    delete process.env.GPT_FAST_PATH_MAX_WORDS;
    delete process.env.GPT_FAST_PATH_TIMEOUT_MS;
    delete process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
    executeFastGptPromptMock.mockResolvedValue(buildFastPathEnvelope());
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

  it('keeps non-prompt-generation requests on the existing async job path', async () => {
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
      status: 'pending',
      jobId: 'job-orchestrated',
      _route: {
        gptId: 'arcanos-core',
        route: 'async',
      },
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
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
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Analyze this deployment timeout.',
        executionMode: 'fast',
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision']).toBe('orchestrated_path');
    expect(response.headers['x-gpt-route-decision-reason']).toBe('no_prompt_generation_intent');
    expect(response.headers['x-gpt-fast-path-queue-bypassed']).toBe('false');
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'pending',
      jobId: 'job-orchestrated',
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
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
      status: 'pending',
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
      status: 'pending',
      jobId: 'job-orchestrated',
    });
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
  });
});
