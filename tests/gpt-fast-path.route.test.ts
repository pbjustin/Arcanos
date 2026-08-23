import express, { type NextFunction, type Request, type Response } from 'express';
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

jest.unstable_mockModule('../src/transport/http/middleware/publicProviderAdmission.js', () => ({
  publicProviderGptAdmission: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
  getJobById: getJobByIdMock,
  createJob: jest.fn(),
  createClaimedJobFence: jest.fn((workerId: string, claimGeneration: string) => ({
    workerId,
    claimGeneration
  })),
  normalizeJobClaimGeneration: jest.fn((claimGeneration: string) => claimGeneration),
  claimNextPendingJob: jest.fn(),
  failPendingJobIfUnclaimed: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  deferJobForProviderRecovery: jest.fn(),
  recoverStaleJobs: jest.fn(),
  recoverStalledJobsForWorkers: jest.fn(async () => ({
    staleWorkerIds: [],
    stalledJobIds: [],
    requeuedJobIds: [],
    deadLetterJobIds: [],
    cancelledJobIds: []
  })),
  resolveJobWorkerStaleAfterMs: jest.fn(() => 45_000),
  updateJob: jest.fn(),
  getLatestJob: jest.fn(),
  listFailedJobs: jest.fn(async () => []),
  requeueFailedJob: jest.fn(),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn(),
  requestJobCancellation: jest.fn(),
  updateClaimedJobTerminal: jest.fn(),
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
const { canonicalGptIdentifierBoundary } = await import(
  '../src/transport/http/middleware/canonicalGptIdentifierBoundary.js'
);
const { isBackstageNotionEnrichmentAuthorized } = await import(
  '../src/services/backstageNotionEnrichmentAuthorization.js'
);
const { metricsRegistry, resetAppMetricsForTests } = await import(
  '../src/platform/observability/appMetrics.js'
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.post('/gpt/:gptId', canonicalGptIdentifierBoundary);
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

function buildBackstageRouting(
  action:
    | 'generateBooking'
    | 'generateBookingWithHRC'
    | 'queryContinuity'
    | 'simulateMatch'
    | 'upsertStoryline'
) {
  return {
    ok: true,
    plan: {
      matchedId: 'backstage-booker',
      module: 'BACKSTAGE:BOOKER',
      route: 'backstage-booker',
      action,
      availableActions: [
        'generateBooking',
        'generateBookingWithHRC',
        'queryContinuity',
        'simulateMatch',
        'upsertStoryline',
      ],
      moduleVersion: null,
      moduleDescription: null,
      matchMethod: 'exact',
    },
    _route: {
      gptId: 'backstage-booker',
      route: 'backstage-booker',
      module: 'BACKSTAGE:BOOKER',
      action,
      timestamp: '2026-08-15T20:00:00.000Z',
    },
  };
}

function buildBackstageContinuityQueryEnvelope() {
  return {
    ok: true,
    result: {
      universeId: 'my-universe-2k26',
      answer: '- Current champion: Rhea Ripley.',
      coverage: {
        mode: 'relevant',
        pagesScanned: 1,
        chunksConsidered: 1,
        chunksReturned: 1,
        complete: true,
      },
      sources: [],
    },
    _route: {
      requestId: 'request-query-continuity',
      traceId: 'trace-query-continuity',
      gptId: 'backstage-booker',
      module: 'BACKSTAGE:BOOKER',
      action: 'queryContinuity',
      route: 'backstage-booker',
      timestamp: '2026-08-19T20:00:00.000Z',
    },
  };
}

const GPT_ROUTE_TEST_ENV_KEYS = [
  'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  'ARCANOS_CONTROL_PLANE_SCOPES',
  'ARCANOS_JOB_READ_CAPABILITY_SECRET',
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
  'GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS',
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
    resetAppMetricsForTests();
    for (const key of GPT_ROUTE_TEST_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET =
      'gpt-fast-path-job-read-capability-secret-v1';
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
        job_type: 'gpt',
        status: 'pending',
        input: {
          requestPath: '/gpt/arcanos-core',
        },
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
        gptMetricIdentity: { kind: 'registered', id: 'arcanos-core' },
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

  it('uses the finite registered match for fast-path latency metric labels', async () => {
    const requestedAlias = 'arcanos-cor';
    process.env.GPT_FAST_PATH_GPT_ALLOWLIST = requestedAlias;
    mockResolveGptRouting.mockResolvedValueOnce({
      ok: true,
      plan: {
        matchedId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'fuzzy'
      },
      _route: {
        gptId: requestedAlias,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-07-31T00:00:00.000Z'
      }
    });

    const response = await request(buildApp())
      .post(`/gpt/${requestedAlias}`)
      .send({ prompt: 'Generate a prompt for a launch email.' });

    expect(response.status).toBe(200);
    expect(executeFastGptPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      gptId: requestedAlias,
      gptMetricIdentity: { kind: 'registered', id: 'arcanos-core' },
    }));
    const metricsText = await metricsRegistry.metrics();
    expect(metricsText).toMatch(
      /gpt_fast_path_latency_ms_count\{[^}]*gpt_id="arcanos-core"[^}]*outcome="completed"[^}]*\} 1/
    );
    expect(metricsText).not.toContain(`gpt_id="${requestedAlias}"`);
  });

  it('uses the finite registered match for fast-path fallback metric labels', async () => {
    const requestedAlias = 'arcanos-cor';
    process.env.GPT_FAST_PATH_GPT_ALLOWLIST = requestedAlias;
    mockResolveGptRouting.mockResolvedValueOnce({
      ok: true,
      plan: {
        matchedId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'fuzzy'
      },
      _route: {
        gptId: requestedAlias,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-07-31T00:00:00.000Z'
      }
    });
    executeFastGptPromptMock.mockRejectedValueOnce(new Error('fast path unavailable'));

    const response = await request(buildApp())
      .post(`/gpt/${requestedAlias}`)
      .send({ prompt: 'Generate a prompt for a launch email.' });

    expect(response.status).toBe(202);
    const metricsText = await metricsRegistry.metrics();
    expect(metricsText).toMatch(
      /gpt_fast_path_latency_ms_count\{[^}]*gpt_id="arcanos-core"[^}]*outcome="fallback"[^}]*\} 1/
    );
    expect(metricsText).not.toContain(`gpt_id="${requestedAlias}"`);
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
    const metricsText = await metricsRegistry.metrics();
    expect(metricsText).toMatch(
      /gpt_fast_path_latency_ms_count\{[^}]*gpt_id="arcanos-core"[^}]*outcome="completed"[^}]*\} 1/
    );
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

  it('returns a traced unknown-GPT error for query_and_wait without creating jobs', async () => {
    mockResolveGptRouting.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'UNKNOWN_GPT',
        message: "gptId 'invalid-id' is not registered",
      },
      _route: {
        gptId: 'invalid-id',
        timestamp: '2026-04-24T00:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/invalid-id')
      .send({
        action: 'query_and_wait',
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      gptId: 'invalid-id',
      action: 'query_and_wait',
      route: '/gpt/:gptId',
      code: 'UNKNOWN_GPT',
      traceId: expect.any(String),
      error: {
        code: 'UNKNOWN_GPT',
        message: "gptId 'invalid-id' is not registered",
      },
      _route: {
        gptId: 'invalid-id',
        action: 'query_and_wait',
        route: 'routing_validation',
        traceId: expect.any(String),
      },
    });
    expect(executeDirectGptActionMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
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
      code: 'GPT_QUERY_AND_WAIT_TIMEOUT',
      traceId: expect.any(String),
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
      code: 'GPT_QUERY_AND_WAIT_FAILED',
      traceId: expect.any(String),
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
    const metricsText = await metricsRegistry.metrics();
    expect(metricsText).toMatch(
      /gpt_fast_path_latency_ms_count\{[^}]*gpt_id="arcanos-core"[^}]*outcome="error"[^}]*\} 1/
    );
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
      code: 'GPT_QUERY_AND_WAIT_FAILED',
      traceId: expect.any(String),
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

  it.each([
    [
      'generateBooking',
      {
        universeId: 'builder-sync-universe',
        prompt: 'x'.repeat(10_000),
      },
      {
        universeId: 'builder-sync-universe',
        storyline: 'The champion accepts a new challenge.',
      },
      false,
    ],
    [
      'generateBookingWithHRC',
      {
        universeId: 'builder-sync-universe',
        prompt: 'x'.repeat(10_000),
      },
      {
        universeId: 'builder-sync-universe',
        storyline: 'The challenger earns a title opportunity.',
        hrc: {
          fidelity: 0.9,
          resilience: 0.8,
          verdict: 'The booking preserves established canon.',
        },
      },
      true,
    ],
    [
      'simulateMatch',
      {
        universeId: 'builder-sync-universe',
        match: {
          wrestler1: 'Rhea Ripley',
          wrestler2: 'Bianca Belair',
          matchType: 'Singles',
          kayfabeMode: true,
        },
      },
      {
        universeId: 'builder-sync-universe',
        result: {
          match: 'Rhea Ripley vs Bianca Belair',
          result: 'Rhea Ripley wins',
          via: 'Pinfall',
          interference: null,
          rating: '4.0',
        },
        hrc: {
          fidelity: 0.9,
          resilience: 0.8,
          verdict: 'The simulated finish is canon-compatible.',
        },
      },
      false,
    ],
  ] as const)(
    'keeps Builder public %s requests synchronous and inline',
    async (action, payload, result, preferAsync) => {
      process.env.GPT_ASYNC_HEAVY_PROMPT_CHARS = '1';
      mockResolveGptRouting.mockResolvedValueOnce(buildBackstageRouting(action));
      mockRouteGptRequest.mockResolvedValueOnce({
        ok: true,
        result,
        _route: {
          requestId: `request-${action}`,
          traceId: `trace-${action}`,
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action,
          route: 'backstage-booker',
          timestamp: '2026-08-15T20:00:00.000Z',
        },
      });

      let builderRequest = request(buildApp())
        .post('/gpt/backstage-booker');
      if (preferAsync) {
        builderRequest = builderRequest.set('Prefer', 'respond-async');
      }
      const response = await builderRequest.send({
        action,
        executionMode: 'sync',
        payload,
      });

      expect(response.status).toBe(200);
      expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
      expect(response.body).toMatchObject({
        ok: true,
        result,
        _route: {
          requestId: `request-${action}`,
          traceId: `trace-${action}`,
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action,
          route: 'backstage-booker',
        },
      });
      expect(response.body).not.toHaveProperty('requestId');
      expect(response.body).not.toHaveProperty('traceId');
      expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
      expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
      expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
        gptId: 'backstage-booker',
        body: {
          action,
          executionMode: 'sync',
          payload,
        },
      }));
    }
  );

  it('returns a bounded 503 when the authoritative Backstage Notion index is unavailable', async () => {
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
        message: 'The authoritative Backstage Notion index is temporarily unavailable.',
        details: { retryable: true },
      },
      _route: {
        requestId: 'request-notion-index-unavailable',
        traceId: 'trace-notion-index-unavailable',
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-19T20:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Review the current show state.',
        },
      });

    expect(response.status).toBe(503);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
        message: 'The authoritative Backstage Notion index is temporarily unavailable.',
        details: { retryable: true },
      },
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
      },
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'incomplete generated output',
      'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      'Backstage Booker could not produce a complete response within the output limit. Narrow the request and try again.',
      { retryable: false },
      500,
    ],
    [
      'internal query failure',
      'BACKSTAGE_CONTINUITY_QUERY_FAILED',
      'Backstage Booker could not complete the continuity query.',
      { retryable: false },
      500,
    ],
    [
      'missing scope',
      'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
      'The requested Backstage Notion scope was not found.',
      { retryable: false, reason: 'not_found' },
      404,
    ],
    [
      'ambiguous scope',
      'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
      'The requested Backstage Notion scope is ambiguous.',
      { retryable: false, reason: 'ambiguous' },
      409,
    ],
    [
      'invalid cursor',
      'BACKSTAGE_NOTION_CURSOR_INVALID',
      'The Backstage continuity cursor is invalid or no longer applies. Restart the scoped read without a cursor.',
      { retryable: false },
      409,
    ],
  ] as const)(
    'maps a continuity-query %s to its bounded HTTP status',
    async (_caseName, code, message, details, statusCode) => {
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('queryContinuity')
      );
      mockRouteGptRequest.mockResolvedValueOnce({
        ok: false,
        error: { code, message, details },
        _route: {
          requestId: `request-${code.toLowerCase()}`,
          traceId: `trace-${code.toLowerCase()}`,
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'queryContinuity',
          route: 'backstage-booker',
          timestamp: '2026-08-19T20:00:00.000Z',
        },
      });

      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .send({
          action: 'queryContinuity',
          executionMode: 'sync',
          payload: {
            universeId: 'my-universe-2k26',
            query: 'Who is the current champion?',
          },
        });

      expect(response.status).toBe(statusCode);
      expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
      expect(response.body).toMatchObject({
        ok: false,
        error: { code, message, details },
        _route: {
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'queryContinuity',
        },
      });
      expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'malformed cursor',
      { retrievalMode: 'complete_scope', cursor: '!' },
    ],
    [
      'mode-invalid cursor',
      { retrievalMode: 'relevant', cursor: 'eyJ2IjoxfQ' },
    ],
  ] as const)(
    'returns typed HTTP 409 for a canonical continuity request with a %s',
    async (_caseName, cursorFields) => {
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('queryContinuity')
      );
      mockRouteGptRequest.mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_CURSOR_INVALID',
          message: 'The Backstage continuity cursor is invalid or no longer applies. Restart the scoped read without a cursor.',
          details: { retryable: false },
        },
        _route: {
          requestId: 'request-cursor-contract-invalid',
          traceId: 'trace-cursor-contract-invalid',
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'queryContinuity',
          route: 'backstage-booker',
          timestamp: '2026-08-19T20:00:00.000Z',
        },
      });

      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .send({
          action: 'queryContinuity',
          executionMode: 'sync',
          payload: {
            universeId: 'my-universe-2k26',
            query: 'Continue the scoped read.',
            ...cursorFields,
          },
        });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_CURSOR_INVALID',
          details: { retryable: false },
        },
      });
      expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          payload: expect.objectContaining(cursorFields),
        }),
      }));
    }
  );

  it('keeps a heavy continuity query synchronous so request-local Notion auth reaches dispatch', async () => {
    const accessToken = `backstage-${'q'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.GPT_ASYNC_HEAVY_PROMPT_CHARS = '1';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('queryContinuity')
    );
    let authorizedInsideDispatch = false;
    mockRouteGptRequest.mockImplementationOnce(async () => {
      authorizedInsideDispatch = isBackstageNotionEnrichmentAuthorized();
      return buildBackstageContinuityQueryEnvelope();
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'x'.repeat(2_000),
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(authorizedInsideDispatch).toBe(true);
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('keeps a classifier-selected continuity query synchronous without an explicit action', async () => {
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('queryContinuity')
    );
    mockRouteGptRequest.mockResolvedValueOnce(
      buildBackstageContinuityQueryEnvelope()
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        executionMode: 'async',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['body executionMode=async', { executionMode: 'async' }, undefined],
    ['Prefer: respond-async', {}, 'respond-async'],
  ] as const)(
    'overrides %s for continuity queries and dispatches inline',
    async (_caseName, executionFields, preferHeader) => {
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('queryContinuity')
      );
      mockRouteGptRequest.mockResolvedValueOnce(
        buildBackstageContinuityQueryEnvelope()
      );

      let continuityRequest = request(buildApp())
        .post('/gpt/backstage-booker');
      if (preferHeader) {
        continuityRequest = continuityRequest.set('Prefer', preferHeader);
      }
      const response = await continuityRequest.send({
        action: 'queryContinuity',
        ...executionFields,
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
      expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
      expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
      expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    }
  );

  it('keeps a header-selected continuity query synchronous despite an explicit async request', async () => {
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce(
      buildBackstageContinuityQueryEnvelope()
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('X-GPT-Action', 'queryContinuity')
      .send({
        executionMode: 'async',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('ignores job-backed idempotency routing for a continuity query and dispatches inline', async () => {
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('queryContinuity')
    );
    mockRouteGptRequest.mockResolvedValueOnce(
      buildBackstageContinuityQueryEnvelope()
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Idempotency-Key', 'continuity-query-request-local-auth')
      .send({
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('returns a bounded 409 for a Notion-authoritative Backstage write denial', async () => {
    const controlPlaneToken = 'test-notion-read-only-control-plane-token-1234567890';
    process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:notion-read-only-route';
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('upsertStoryline')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_AUTHORITY_READ_ONLY',
        message: 'Notion is authoritative for this Backstage universe; backend mutations are disabled.',
        details: { retryable: false },
      },
      _route: {
        requestId: 'request-notion-authority-read-only',
        traceId: 'trace-notion-authority-read-only',
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'upsertStoryline',
        route: 'backstage-booker',
        timestamp: '2026-08-19T20:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'upsertStoryline')
      .set('X-Confirmed', 'yes')
      .send({
        action: 'upsertStoryline',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          mutationId: '8d64dad3-f080-4bac-88ec-994005dc7152',
          expectedVersion: 0,
          storyline: {
            key: 'summer-feud',
            title: 'Summer Feud',
            summary: null,
            status: 'draft',
            participantNames: [],
          },
        },
      });

    expect(response.status).toBe(409);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_AUTHORITY_READ_ONLY',
        message: 'Notion is authoritative for this Backstage universe; backend mutations are disabled.',
        details: { retryable: false },
      },
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'upsertStoryline',
      },
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('preserves verified Builder bearer provenance through the assembled route', async () => {
    const accessToken = `backstage-${'a'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    let authorizedInsideDispatch = false;
    mockRouteGptRequest.mockImplementationOnce(async () => {
      authorizedInsideDispatch = isBackstageNotionEnrichmentAuthorized();
      return {
        ok: true,
        result: {
          universeId: 'my-universe-2k26',
          storyline: 'Authoritative Notion context was retrieved.',
        },
        _route: {
          requestId: 'request-notion-authorized',
          traceId: 'trace-notion-authorized',
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage-booker',
          timestamp: '2026-08-19T20:00:00.000Z',
        },
      };
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Review the current show state.',
        },
      });

    expect(response.status).toBe(200);
    expect(authorizedInsideDispatch).toBe(true);
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
  });

  it.each([
    ['legacy alias', 'backstage'],
    ['case-normalized canonical ID', 'BACKSTAGE-BOOKER'],
    ['whitespace-normalized canonical ID', '%20backstage-booker%20'],
  ] as const)(
    'keeps the dedicated bearer unauthorized through the assembled %s route',
    async (_caseName, gptId) => {
      const accessToken = `backstage-${'n'.repeat(48)}`;
      process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('queryContinuity')
      );
      let authorizedInsideDispatch = true;
      mockRouteGptRequest.mockImplementationOnce(async () => {
        authorizedInsideDispatch = isBackstageNotionEnrichmentAuthorized();
        return buildBackstageContinuityQueryEnvelope();
      });

      const response = await request(buildApp())
        .post(`/gpt/${gptId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          action: 'queryContinuity',
          executionMode: 'sync',
          payload: {
            universeId: 'my-universe-2k26',
            query: 'Who is the current champion?',
          },
        });

      expect(response.status).toBe(200);
      expect(authorizedInsideDispatch).toBe(false);
      expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
      expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    }
  );

  it('auto-queues a heavy Backstage public action when the sync sentinel is absent', async () => {
    process.env.GPT_ASYNC_HEAVY_PROMPT_CHARS = '1';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'builder-async-control-universe',
          prompt: 'x'.repeat(10_000),
        },
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(response.body).toMatchObject({
      ok: true,
      status: 'queued',
      jobId: 'job-orchestrated',
    });
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('logs only bounded Booker workload metadata for a heavy authenticated decision', async () => {
    const accessToken = `backstage-${'l'.repeat(48)}`;
    const privatePromptSentinel = 'private-prompt-sentinel';
    const privateContextSentinel = 'private-notion-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: 'Safe mocked booking result.',
      _route: {
        requestId: 'request-workload-log',
        traceId: 'trace-workload-log',
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-23T12:00:00.000Z',
      },
    });
    const consoleLogSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    try {
      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          action: 'generateBooking',
          executionMode: 'sync',
          payload: {
            universeId: 'builder-workload-log-universe',
            prompt: `${privatePromptSentinel}: return exactly six matches.`,
            retrievedContext: privateContextSentinel,
          },
        });

      expect(response.status).toBe(200);
      const serializedLogs = consoleLogSpy.mock.calls
        .map(([entry]) => String(entry))
        .join('\n');
      const executionPlanLog = consoleLogSpy.mock.calls
        .map(([entry]) => {
          try {
            return JSON.parse(String(entry)) as {
              event?: string;
              data?: Record<string, unknown>;
            };
          } catch {
            return null;
          }
        })
        .find(entry => entry?.event === 'gpt.request.execution_plan');

      expect(executionPlanLog?.data).toMatchObject({
        backstageWorkloadClass: 'production_generation',
        backstageWorkloadReason: 'expected_item_count',
        backstageQueueRequired: true,
        backstageExpectedItemCount: 6,
        backstageProviderInvocationRequired: true,
      });
      expect(serializedLogs).not.toContain(privatePromptSentinel);
      expect(serializedLogs).not.toContain(privateContextSentinel);
      expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it.each(['backstage-booker', 'backstage'])(
    'returns the documented sixty-second timeout response for synchronous Builder dispatch through %s',
    async (gptId) => {
      process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '6000';
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('generateBooking')
      );
      const timeoutError = new Error('GPT route timeout after 60000ms');
      timeoutError.name = 'AbortError';
      mockRouteGptRequest.mockRejectedValueOnce(timeoutError);

      const response = await request(buildApp())
        .post(`/gpt/${gptId}`)
        .send({
          action: 'generateBooking',
          executionMode: 'sync',
          payload: {
            universeId: 'builder-timeout-universe',
            prompt: 'Book a championship match.',
          },
        });

      expect(response.status).toBe(504);
      expect(response.body).toMatchObject({
        ok: false,
        error: {
          code: 'MODULE_TIMEOUT',
          message: 'GPT route timeout after 60000ms',
        },
        _route: {
          gptId,
        },
      });
      expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    }
  );

  it('keeps delayed synchronous Builder generation alive beyond the generic six-second route default', async () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '6000';
    mockResolveGptRouting
      .mockResolvedValueOnce(buildBackstageRouting('generateBookingWithHRC'))
      .mockResolvedValueOnce(buildBackstageRouting('generateBooking'));

    const delayedDispatch = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 6_250));
      return {
        ok: true,
        result: 'Delayed provider-backed booking result.',
        _route: {
          requestId: 'request-delayed-booker',
          traceId: 'trace-delayed-booker',
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage-booker',
          timestamp: '2026-08-16T12:00:00.000Z',
        },
      };
    };
    mockRouteGptRequest
      .mockImplementationOnce(delayedDispatch)
      .mockImplementationOnce(delayedDispatch);

    const [canonicalResponse, aliasResponse] = await Promise.all([
      request(buildApp())
        .post('/gpt/backstage-booker')
        .send({
          action: 'generateBookingWithHRC',
          executionMode: 'sync',
          payload: {
            universeId: 'builder-delayed-canonical-universe',
            prompt: 'Book and evaluate a championship match.',
          },
        }),
      request(buildApp())
        .post('/gpt/backstage')
        .send({
          action: 'generateBooking',
          executionMode: 'sync',
          payload: {
            universeId: 'builder-delayed-alias-universe',
            prompt: 'Book a championship match.',
          },
        }),
    ]);

    expect([canonicalResponse.status, aliasResponse.status]).toEqual([200, 200]);
    expect(canonicalResponse.body.result).toBe('Delayed provider-backed booking result.');
    expect(aliasResponse.body.result).toBe('Delayed provider-backed booking result.');
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps the Backstage outer budget at sixty seconds for DAG-classified synchronous generation', async () => {
    process.env.GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS = '8000';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    const timeoutError = new Error('GPT route timeout after 60000ms');
    timeoutError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValueOnce(timeoutError);

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'builder-dag-timeout-universe',
          prompt: 'Run a DAG workflow to book a championship match.',
        },
      });

    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({
      error: {
        code: 'MODULE_TIMEOUT',
        message: 'GPT route timeout after 60000ms',
      },
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
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
