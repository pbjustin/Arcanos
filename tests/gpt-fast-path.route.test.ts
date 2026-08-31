import { request as httpRequest, type ClientRequest, type Server } from 'node:http';
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
  claimNextPendingJobWithAdmission: jest.fn(),
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
const { parseQueuedGptJobInput } = await import(
  '../src/shared/gpt/asyncGptJob.js'
);
const { protectBackstageQueuedGptJobOutput } = await import(
  '../src/shared/backstage/backstageQueuedJobResultProtection.js'
);
const { buildGptIdempotencyScopeHash } = await import(
  '../src/shared/gpt/gptIdempotency.js'
);
const { BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY } = await import(
  '../src/services/backstageBookerAccessAuth.js'
);
const { BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS } = await import(
  '../src/shared/gpt/gptAsyncWaitPolicy.js'
);
const { metricsRegistry, resetAppMetricsForTests } = await import(
  '../src/platform/observability/appMetrics.js'
);

function buildApp(options: { onResponseClose?: () => void } = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((_req, res, next) => {
    if (options.onResponseClose) {
      res.once('close', options.onResponseClose);
    }
    next();
  });
  app.post('/gpt/:gptId', canonicalGptIdentifierBoundary);
  app.use('/gpt', gptRouter);
  return app;
}

async function startAbortableBookerPost(input: {
  accessToken: string;
  body: Record<string, unknown>;
}): Promise<{
  client: ClientRequest;
  clientClosed: Promise<void>;
  serverResponseClosed: Promise<void>;
  server: Server;
}> {
  let observeServerResponseClose!: () => void;
  const serverResponseClosed = new Promise<void>((resolve) => {
    observeServerResponseClose = resolve;
  });
  const server = buildApp({
    onResponseClose: observeServerResponseClose,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected a TCP test listener.');
  }

  const serializedBody = JSON.stringify(input.body);
  const client = httpRequest({
    host: '127.0.0.1',
    port: address.port,
    method: 'POST',
    path: '/gpt/backstage-booker',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serializedBody),
    },
  }, (response) => {
    response.resume();
  });
  client.on('error', () => undefined);
  const clientClosed = new Promise<void>((resolve) => {
    client.once('close', resolve);
  });
  client.end(serializedBody);

  return { client, clientClosed, serverResponseClosed, server };
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function expectManagedBookerJobResponse(
  body: Record<string, unknown>,
  jobId: string
): void {
  expect(body).toMatchObject({
    jobId,
    poll:
      `/gpt-access/capabilities/v1/backstage-booker/jobs/${jobId}/result`,
  });
  expect(body).not.toHaveProperty('jobReadToken');
  expect(body).not.toHaveProperty('jobReadTokenHeader');
  expect(body).not.toHaveProperty('stream');
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
  'ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED',
  'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY',
  'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY',
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
    findOrCreateGptJobMock.mockImplementation(async (options: {
      input: unknown;
    }) => ({
      job: {
        id: 'job-orchestrated',
        job_type: 'gpt',
        status: 'pending',
        input: options.input,
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    }));
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
        waitForResultMs: 30_000,
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
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ action: 'queryContinuity' }),
    }));
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'array action',
      {
        action: [null, ['', ['QueryContinuity']]],
        executionMode: 'async',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      },
    ],
    [
      'payload action',
      {
        executionMode: 'async',
        payload: {
          action: 'queryContinuity',
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      },
    ],
    [
      'payload operation',
      {
        executionMode: 'async',
        payload: {
          operation: 'queryContinuity',
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      },
    ],
  ] as const)(
    'server-binds a %s continuity alias before synchronous dispatch',
    async (_caseName, body) => {
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('generateBooking')
      );
      mockRouteGptRequest.mockResolvedValueOnce(
        buildBackstageContinuityQueryEnvelope()
      );

      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .send(body);

      expect(response.status).toBe(200);
      expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
      expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ action: 'queryContinuity' }),
      }));
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    }
  );

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
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ action: 'queryContinuity' }),
    }));
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

  it.each([
    ['incorrect bearer', `Bearer backstage-${'x'.repeat(48)}`, 401, 'UNAUTHORIZED_GPT_ACCESS'],
    ['malformed bearer', `Basic backstage-${'x'.repeat(48)}`, 401, 'UNAUTHORIZED_GPT_ACCESS'],
  ] as const)(
    'fails exact Booker requests closed for a presented %s before routing',
    async (_caseName, authorization, expectedStatus, expectedCode) => {
      const configuredToken = `backstage-${'a'.repeat(48)}`;
      process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = configuredToken;

      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .set('Authorization', authorization)
        .send({
          action: 'queryContinuity',
          payload: {
            universeId: 'my-universe-2k26',
            query: 'Who is the current champion?',
          },
        });

      expect(response.status).toBe(expectedStatus);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.body).toMatchObject({
        ok: false,
        error: { code: expectedCode },
      });
      expect(JSON.stringify(response.body)).not.toContain(configuredToken);
      expect(JSON.stringify(response.body)).not.toContain(authorization);
      expect(mockResolveGptRouting).not.toHaveBeenCalled();
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    }
  );

  it('fails exact Booker requests closed when a bearer is presented but dedicated authentication is unavailable', async () => {
    const presentedToken = `backstage-${'u'.repeat(48)}`;

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${presentedToken}`)
      .send({
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the current champion?',
        },
      });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'BACKSTAGE_BOOKER_AUTH_UNAVAILABLE' },
    });
    expect(JSON.stringify(response.body)).not.toContain(presentedToken);
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
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
    ['trailing-slash canonical ID', 'backstage-booker/'],
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
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x52).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        clientId: 'backstage-booker',
        authenticationType: 'managed-api-key',
        runtimeModel: 'pro',
        modelIdentityAssurance: 'openai-attested',
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
      poll: '/jobs/job-orchestrated/result',
      stream: '/jobs/job-orchestrated/stream',
      jobReadTokenHeader: 'x-arcanos-job-read-token',
    });
    expect(response.body.jobReadToken).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(
      findOrCreateGptJobMock.mock.calls[0]?.[0]?.createOptions?.autonomyState
    ).not.toHaveProperty('gptClientProvenance');
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('preserves an explicit async CORE query even when its text contains booking language', async () => {
    const prompt = 'Book six Raw matches for WWE as a hypothetical classification example.';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'query',
        executionMode: 'async',
        prompt,
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'queued',
      jobId: 'job-orchestrated',
    });
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]?.input).toMatchObject({
      gptId: 'arcanos-core',
      bypassIntentRouting: true,
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['array query', { action: [null, ['', ['query']]] }],
    ['payload operation query', { payload: { operation: 'query' } }],
  ] as const)(
    'persists the canonical query action for a %s alias',
    async (_caseName, actionFields) => {
      const response = await request(buildApp())
        .post('/gpt/arcanos-core')
        .send({
          ...actionFields,
          executionMode: 'async',
          prompt: 'Explain deterministic finite automata.',
        });

      expect(response.status).toBe(202);
      expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
      expect(findOrCreateGptJobMock.mock.calls[0]?.[0]?.input).toMatchObject({
        gptId: 'arcanos-core',
        body: expect.objectContaining({ action: 'query' }),
        bypassIntentRouting: true,
        routeHint: 'query',
      });
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }
  );

  it('recognizes a nested query_and_wait alias without queueing duplicate work', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        payload: { action: [null, ['query_and_wait']] },
        prompt: 'Analyze this deployment timeout.',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query_and_wait',
      status: 'completed',
    });
    expect(executeDirectGptActionMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'query_and_wait',
    }));
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it.each(['ask', 'chat'] as const)(
    'rejects an async CORE %s alias that would auto-route to Booker before plaintext persistence',
    async (action) => {
      const privatePrompt = `private-${action}-booking-handoff: book six Raw matches for WWE.`;

      const response = await request(buildApp())
        .post('/gpt/arcanos-core')
        .send({ action, executionMode: 'async', prompt: privatePrompt });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        error: { code: 'BACKSTAGE_ASYNC_CANONICAL_ROUTE_REQUIRED' },
      });
      expect(JSON.stringify(response.body)).not.toContain(privatePrompt);
      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }
  );

  it('rejects a default async core-to-Booker handoff before persisting plaintext', async () => {
    const privatePrompt =
      'private-core-booking-handoff-sentinel: book six Raw matches for WWE.';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        executionMode: 'async',
        prompt: privatePrompt,
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_ASYNC_CANONICAL_ROUTE_REQUIRED',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(privatePrompt);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('protects a bounded-small explicit async booking without granting Notion authorization', async () => {
    const privatePrompt = 'private-small-async-booking-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x72).toString('base64');
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'false';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        executionMode: 'async',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      });

    expect(response.status).toBe(202);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    const queuedInput = findOrCreateGptJobMock.mock.calls[0]?.[0]?.input;
    expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: {
        body: { action: 'generateBooking' },
        protectedBackstage: {
          action: 'generateBooking',
          universeId: 'my-universe-2k26',
          notionEnrichmentAuthorized: false,
        },
      },
    });
  });

  it('protects a bounded-small idempotent booking even without explicit async mode', async () => {
    const privatePrompt = 'private-small-idempotent-booking-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x73).toString('base64');
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'false';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Idempotency-Key', 'small-booking-idempotency-key')
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      });

    expect(response.status).toBe(202);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    const queuedInput = findOrCreateGptJobMock.mock.calls[0]?.[0]?.input;
    expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: { protectedBackstage: { action: 'generateBooking' } },
    });
  });

  it.each([
    {
      label: 'an explicit async body mode',
      path: '/gpt/backstage-booker',
      headers: {},
      bodyOverrides: { executionMode: 'async' },
    },
    {
      label: 'a Prefer respond-async header',
      path: '/gpt/backstage-booker',
      headers: { Prefer: 'respond-async' },
      bodyOverrides: {},
    },
    {
      label: 'async query and wait hints',
      path: '/gpt/backstage-booker?executionMode=async&waitForResultMs=1200&pollIntervalMs=50',
      headers: {},
      bodyOverrides: {},
    },
    {
      label: 'an Idempotency-Key header',
      path: '/gpt/backstage-booker',
      headers: { 'Idempotency-Key': 'literal-booking-request-local' },
      bodyOverrides: {},
    },
  ])('keeps authenticated no-provider booking request-local with $label', async ({
    path,
    headers,
    bodyOverrides,
  }) => {
    const accessToken = `backstage-${'f'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x78).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: 'LITERAL-BOOKING-OK',
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-23T12:00:00.000Z',
      },
    });

    let pendingRequest = request(buildApp())
      .post(path)
      .set('Authorization', `Bearer ${accessToken}`);
    for (const [name, value] of Object.entries(headers)) {
      pendingRequest = pendingRequest.set(name, value);
    }
    const response = await pendingRequest.send({
      action: 'generateBooking',
      payload: {
        universeId: 'literal-request-local-universe',
        prompt: 'Write exactly this token and nothing else: LITERAL-BOOKING-OK',
      },
      ...bodyOverrides,
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('keeps an authenticated no-provider booking out of the provider fast path', async () => {
    const accessToken = `backstage-${'g'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x79).toString('base64');
    process.env.GPT_FAST_PATH_ENABLED = 'true';
    process.env.GPT_FAST_PATH_GPT_ALLOWLIST = 'backstage-booker';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: 'LITERAL-FALLBACK-OK',
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-23T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        prompt: 'Write exactly this text and nothing else: LITERAL-FALLBACK-PROMPT',
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_provider_not_required'
    );
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('uses the nested canonical prompt instead of a literal message alias when deciding to queue', async () => {
    const accessToken = `backstage-${'h'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x7a).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'canonical-prompt-queue-universe',
          message: 'Write exactly this token and nothing else: ALIAS-MESSAGE-LITERAL',
          prompt: 'Book a complete six-match premium live event card.',
        },
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_expected_item_count'
    );
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('queues a complete low-count card instead of treating its components as compact output', async () => {
    const accessToken = `backstage-${'q'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6a).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'complete-low-count-card-universe',
          prompt: 'Give me one complete Raw card with three matches and two segments.',
        },
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_complete_booking_container'
    );
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      'detailed alternative cards',
      'detailed-alternative-cards-universe',
      'Give me three detailed alternative cards with full match lineups.',
    ],
    [
      'short alternative cards with nested matches',
      'nested-short-alternative-cards-universe',
      'Give me three short alternative cards, each with eight matches.',
    ],
    [
      'short alternative cards with next-sentence nested matches',
      'next-sentence-nested-alternative-cards-universe',
      'Give me three short alternative cards. Each has eight matches.',
    ],
    [
      'natural alternative-card request phrasing',
      'natural-alternative-cards-universe',
      'Answer directly. Can I get three alternative cards?',
    ],
    [
      'open-ended alternative-card request phrasing',
      'open-ended-alternative-cards-universe',
      'How about three alternative cards?',
    ],
    [
      'alternative cards with a per-card component list',
      'per-card-components-alternative-cards-universe',
      'Give me three short alternative cards, plus matches, storylines, finishes, and consequences for each.',
    ],
  ])('queues %s as booking containers', async (_caseName, universeId, prompt) => {
    const accessToken = `backstage-${'v'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6b).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        payload: {
          universeId,
          prompt,
        },
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_complete_booking_container'
    );
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('uses the nested canonical literal prompt instead of a heavy message alias', async () => {
    const accessToken = `backstage-${'i'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x7b).toString('base64');
    process.env.GPT_FAST_PATH_ENABLED = 'true';
    process.env.GPT_FAST_PATH_GPT_ALLOWLIST = 'backstage-booker';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: 'ALIAS-PROMPT-LITERAL',
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-23T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'canonical-prompt-literal-universe',
          message: 'Book a complete six-match premium live event card.',
          prompt: 'Write exactly this token and nothing else: ALIAS-PROMPT-LITERAL',
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_provider_not_required'
    );
    expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it.each([
    ['message', { message: 'Write exactly this token and nothing else: MESSAGE-ALIAS-OK' }],
    ['prompt', { prompt: 'Write exactly this token and nothing else: PROMPT-ALIAS-OK' }],
    ['userInput', { userInput: 'Write exactly this token and nothing else: USER-INPUT-ALIAS-OK' }],
    ['content', { content: 'Write exactly this token and nothing else: CONTENT-ALIAS-OK' }],
    ['text', { text: 'Write exactly this token and nothing else: TEXT-ALIAS-OK' }],
    ['query', { query: 'Write exactly this token and nothing else: QUERY-ALIAS-OK' }],
    ['messages', {
      messages: [{ role: 'user', content: 'Write exactly this token and nothing else: MESSAGES-ALIAS-OK' }],
    }],
  ])('keeps the flattened %s prompt alias request-local', async (_alias, promptBody) => {
    const accessToken = `backstage-${'j'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: 'alias result',
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-23T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ action: 'generateBooking', ...promptBody });

    expect(response.status).toBe(200);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_provider_not_required'
    );
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('queues an authenticated omitted-action booking before the provider fast path', async () => {
    const accessToken = `backstage-${'k'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x7c).toString('base64');
    process.env.GPT_FAST_PATH_ENABLED = 'true';
    process.env.GPT_FAST_PATH_GPT_ALLOWLIST = 'backstage-booker';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        universeId: 'omitted-action-fast-path-universe',
        prompt: 'Book a complete six-match premium live event card.',
      });

    expect(response.status).toBe(202);
    expect(response.headers['x-gpt-route-decision-reason']).toBe(
      'backstage_expected_item_count'
    );
    expect(response.headers['x-gpt-queue-bypassed']).toBe('false');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    const queuedInput = findOrCreateGptJobMock.mock.calls[0]?.[0]?.input;
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: {
        body: { action: 'generateBooking' },
        protectedBackstage: {
          action: 'generateBooking',
          universeId: 'omitted-action-fast-path-universe',
        },
      },
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('server-binds an omitted heavy booking action before protected enqueue', async () => {
    const accessToken = `backstage-${'o'.repeat(48)}`;
    const privatePrompt = 'private-default-action-booking-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x74).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        payload: {
          universeId: 'my-universe-2k26',
          prompt: `${privatePrompt}: return exactly six matches.`,
        },
      });

    expect(response.status).toBe(202);
    const queuedInput = findOrCreateGptJobMock.mock.calls[0]?.[0]?.input;
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: {
        body: { action: 'generateBooking' },
        protectedBackstage: { action: 'generateBooking' },
      },
    });
    expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('canonicalizes a nested booking action before protected enqueue', async () => {
    const accessToken = `backstage-${'n'.repeat(48)}`;
    const privatePrompt = 'private-nested-action-booking-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x76).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: [null, ['', ['GenerateBooking']]],
        executionMode: 'async',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      });

    expect(response.status).toBe(202);
    const queuedInput = findOrCreateGptJobMock.mock.calls[0]?.[0]?.input;
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: {
        body: { action: 'generateBooking' },
        protectedBackstage: {
          action: 'generateBooking',
          universeId: 'my-universe-2k26',
          notionEnrichmentAuthorized: true,
        },
      },
    });
    expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects conflicting top-level and payload booking actions before queue or model execution', async () => {
    const privatePrompt = 'private-conflicting-booking-action-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x77).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        executionMode: 'async',
        payload: {
          action: 'generateBookingWithHRC',
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Protected Backstage generation request identity is invalid.',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(privatePrompt);
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('fails closed when idempotency returns a legacy plaintext row for protected booking', async () => {
    const privatePrompt = 'private-legacy-plaintext-booking-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x75).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    findOrCreateGptJobMock.mockResolvedValueOnce({
      job: {
        id: 'job-legacy-plaintext',
        job_type: 'gpt',
        status: 'completed',
        input: {
          gptId: 'backstage-booker',
          body: {
            action: 'generateBooking',
            payload: { universeId: 'my-universe-2k26', prompt: privatePrompt },
          },
          requestPath: '/gpt/backstage-booker',
        },
        output: { ok: true, result: 'legacy plaintext result' },
      },
      created: false,
      deduped: true,
      dedupeReason: 'reused_completed_result',
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .send({
        action: 'generateBooking',
        executionMode: 'async',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'BACKSTAGE_ASYNC_UNAVAILABLE' },
    });
    expect(JSON.stringify(response.body)).not.toContain(privatePrompt);
    expect(JSON.stringify(response.body)).not.toContain('legacy plaintext result');
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

  it.each([
    'generateBooking',
    'generateBookingWithHRC',
  ] as const)(
    'queues authenticated heavy Booker %s exactly once and returns accepted promptly',
    async (action) => {
    const accessToken = `backstage-${'q'.repeat(48)}`;
    const privatePrompt = 'private-production-booking-prompt-sentinel';
    const spoofedClientId = 'attacker-client-provenance-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x54).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(buildBackstageRouting(action));
    planAutonomousWorkerJobMock.mockResolvedValueOnce({
      status: 'pending',
      retryCount: 0,
      maxRetries: 2,
      priority: 85,
      autonomyState: {
        planner: { reasons: [] },
        providerExecution: { providerModel: 'gpt-5.1' },
        gptClientProvenance: {
          clientId: spoofedClientId,
          runtimeModel: 'pro',
          modelIdentityAssurance: 'openai-attested',
        },
      },
      planningReasons: [],
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action,
        executionMode: 'sync',
        clientId: spoofedClientId,
        runtimeModel: 'pro',
        modelIdentityAssurance: 'openai-attested',
        clientReportedModelProfile: 'thinking',
        gptClientProvenance: {
          clientId: spoofedClientId,
          runtimeModel: 'pro',
        },
        payload: {
          universeId: 'my-universe-2k26',
          prompt: `${privatePrompt}: return exactly six matches.`,
        },
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'queued',
      jobId: 'job-orchestrated',
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    const createOptions = findOrCreateGptJobMock.mock.calls[0]?.[0] as {
      input: Record<string, unknown>;
      idempotencyScopeHash: string;
      createOptions: {
        correlationId?: string;
        autonomyState?: Record<string, unknown>;
      };
    };
    const serializedInput = JSON.stringify(createOptions.input);
    expect(createOptions.input).toMatchObject({
      gptId: 'backstage-booker',
      protectedBackstage: {
        action,
        universeId: 'my-universe-2k26',
      },
      requestId: expect.any(String),
      traceId: expect.any(String),
      correlationId: expect.any(String),
      routeHint: action,
      requestPath: '/gpt/backstage-booker',
    });
    expect(createOptions.createOptions.correlationId).toBe(createOptions.input.traceId);
    expect(createOptions.createOptions.autonomyState).toEqual({
      planner: { reasons: [] },
      providerExecution: { providerModel: 'gpt-5.1' },
      gptClientProvenance: {
        version: 1,
        source: 'gpt-client-registry',
        clientId: 'backstage-booker',
        gptId: 'backstage-booker',
        authenticationType: 'managed-api-key',
        registeredModelProfile: null,
        runtimeModel: null,
        modelIdentityAssurance: 'unknown',
      },
    });
    expect(
      (createOptions.createOptions.autonomyState?.gptClientProvenance as {
        runtimeModel?: unknown;
      }).runtimeModel
    ).toBeNull();
    expect(serializedInput).not.toContain(privatePrompt);
    expect(serializedInput).not.toContain(accessToken);
    expect(JSON.stringify(createOptions)).not.toContain(spoofedClientId);
    expect(JSON.stringify(createOptions)).not.toContain('"runtimeModel":"pro"');
    expect(serializedInput.toLowerCase()).not.toContain('authorization');
    expect(createOptions.input).not.toHaveProperty('body');
    expect(createOptions.input).not.toHaveProperty('prompt');
    expect(resolveAsyncGptWaitForResultMsMock)
      .toHaveBeenCalledWith(BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS);
    expect(resolveAsyncGptPollIntervalMsMock).toHaveBeenCalledWith(undefined);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-orchestrated',
      expect.objectContaining({
        waitForResultMs: BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS,
        pollIntervalMs: 250,
        signal: expect.any(AbortSignal),
      })
    );
    expectManagedBookerJobResponse(response.body, 'job-orchestrated');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }
  );

  it('projects an authenticated Booker route-timeout continuation onto the managed bearer lane', async () => {
    const accessToken = `backstage-${'y'.repeat(48)}`;
    const privatePrompt = 'private-route-timeout-booking-sentinel';
    const jobId = '55555555-5555-4555-8555-555555555555';
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x65).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    findOrCreateGptJobMock.mockImplementationOnce(async (options: { input: unknown }) => ({
      job: {
        id: jobId,
        job_type: 'gpt',
        status: 'pending',
        input: options.input,
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    }));
    const timeoutError = new Error('GPT route timeout after 60000ms');
    timeoutError.name = 'AbortError';
    waitForQueuedGptJobCompletionMock.mockRejectedValueOnce(timeoutError);

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: `${privatePrompt}: return exactly six matches.`,
        },
      });

    const managedPoll =
      `/gpt-access/capabilities/v1/backstage-booker/jobs/${jobId}/result`;
    expect(response.status).toBe(202);
    expectManagedBookerJobResponse(response.body, jobId);
    expect(response.body).toMatchObject({
      ok: true,
      status: 'timeout',
      timedOut: true,
      instruction:
        `Call getBackstageBookerJobResult with jobId ${jobId}; `
        + 'the configured Backstage Booker Bearer credential authenticates continuation.',
      directReturn: {
        requested: true,
        timedOut: true,
        waitForResultMs: BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS,
        pollIntervalMs: 250,
        poll: managedPoll,
        result: managedPoll,
      },
    });
    const serializedResponse = JSON.stringify(response.body);
    expect(serializedResponse).not.toContain(privatePrompt);
    expect(serializedResponse).not.toContain(accessToken);
    expect(serializedResponse).not.toContain('jobReadToken');
    expect(serializedResponse).not.toContain('"stream"');
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      jobId,
      expect.objectContaining({
        waitForResultMs: BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS,
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('does not create a protected Booker job when the client disconnects before planning finishes', async () => {
    const accessToken = `backstage-${'z'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6a).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    let releasePlanning!: (value: unknown) => void;
    const planningStarted = new Promise<void>((resolve) => {
      planAutonomousWorkerJobMock.mockImplementationOnce(() => new Promise((resolvePlan) => {
        releasePlanning = resolvePlan;
        resolve();
      }));
    });
    const connection = await startAbortableBookerPost({
      accessToken,
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      },
    });

    try {
      await planningStarted;
      connection.client.destroy();
      await Promise.all([
        connection.clientClosed,
        connection.serverResponseClosed,
      ]);
      releasePlanning({
        status: 'pending',
        retryCount: 0,
        maxRetries: 2,
        priority: 85,
        autonomyState: { planner: { reasons: [] } },
        planningReasons: [],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
      expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    } finally {
      await closeTestServer(connection.server);
    }
  });

  it('keeps an accepted protected Booker job after the client disconnects during the initial wait', async () => {
    const accessToken = `backstage-${'r'.repeat(48)}`;
    const jobId = '33333333-3333-4333-8333-333333333333';
    let durableJob: unknown = null;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x6b).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBookingWithHRC')
    );
    findOrCreateGptJobMock.mockImplementationOnce(async (options: { input: unknown }) => {
      durableJob = options.input;
      return {
        job: {
          id: jobId,
          job_type: 'gpt',
          status: 'pending',
          input: options.input,
        },
        created: true,
        deduped: false,
        dedupeReason: 'new_job',
      };
    });
    let observeAbort!: () => void;
    const waitingForResult = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    waitForQueuedGptJobCompletionMock.mockImplementationOnce((
      _id: string,
      options: { signal?: AbortSignal },
    ) => new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => {
        observeAbort();
        reject(options.signal?.reason);
      }, { once: true });
    }));
    const connection = await startAbortableBookerPost({
      accessToken,
      body: {
        action: 'generateBookingWithHRC',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six HRC matches for Raw.',
        },
      },
    });

    try {
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (waitForQueuedGptJobCompletionMock.mock.calls.length === 1) {
            resolve();
            return;
          }
          setImmediate(poll);
        };
        poll();
      });
      connection.client.destroy();
      await waitingForResult;
      await connection.clientClosed;

      expect(durableJob).not.toBeNull();
      expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
      expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
        jobId,
        expect.objectContaining({
          waitForResultMs: BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS,
          signal: expect.any(AbortSignal),
        })
      );
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    } finally {
      await closeTestServer(connection.server);
    }
  });

  it('projects a completed authenticated Booker job onto the managed bearer continuation lane', async () => {
    const accessToken = `backstage-${'v'.repeat(48)}`;
    const jobId = '11111111-1111-4111-8111-111111111111';
    let queuedInput: unknown;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x61).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    findOrCreateGptJobMock.mockImplementationOnce(async (options: { input: unknown }) => {
      queuedInput = options.input;
      return {
        job: {
          id: jobId,
          job_type: 'gpt',
          status: 'pending',
          input: options.input,
        },
        created: true,
        deduped: false,
        dedupeReason: 'new_job',
      };
    });
    waitForQueuedGptJobCompletionMock.mockImplementationOnce(async () => ({
      state: 'completed',
      job: {
        id: jobId,
        status: 'completed',
        input: queuedInput,
        output: protectBackstageQueuedGptJobOutput({
          jobId,
          rawInput: queuedInput,
          output: {
            ok: true,
            result: { booking: 'Six-match Raw card.' },
            _route: {
              gptId: 'backstage-booker',
              module: 'BACKSTAGE:BOOKER',
              action: 'generateBooking',
              route: 'backstage-booker',
              timestamp: '2026-08-26T12:00:00.000Z',
            },
          },
        }),
      },
    }));

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      });

    expect(response.status).toBe(200);
    expectManagedBookerJobResponse(response.body, jobId);
    expect(response.body.result).toEqual({ booking: 'Six-match Raw card.' });
  });

  it.each([
    ['invalid protected output', 'unavailable', 503, 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE'],
    ['invalid completed envelope', 'invalid', 500, 'ASYNC_GPT_JOB_OUTPUT_INVALID'],
  ] as const)(
    'projects %s without exposing a dynamic job capability',
    async (_caseName, outputKind, expectedStatus, expectedCode) => {
      const accessToken = `backstage-${'w'.repeat(48)}`;
      const jobId = '22222222-2222-4222-8222-222222222222';
      let queuedInput: unknown;
      process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
      process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
        Buffer.alloc(32, 0x62).toString('base64');
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('generateBooking')
      );
      findOrCreateGptJobMock.mockImplementationOnce(async (options: { input: unknown }) => {
        queuedInput = options.input;
        return {
          job: { id: jobId, job_type: 'gpt', status: 'pending', input: options.input },
          created: true,
          deduped: false,
          dedupeReason: 'new_job',
        };
      });
      waitForQueuedGptJobCompletionMock.mockImplementationOnce(async () => ({
        state: 'completed',
        job: {
          id: jobId,
          status: 'completed',
          input: queuedInput,
          output: outputKind === 'unavailable'
            ? { tampered: true }
            : protectBackstageQueuedGptJobOutput({
                jobId,
                rawInput: queuedInput,
                output: { ok: false },
              }),
        },
      }));

      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          action: 'generateBooking',
          executionMode: 'sync',
          payload: {
            universeId: 'my-universe-2k26',
            prompt: 'Return exactly six matches for Raw.',
          },
        });

      expect(response.status).toBe(expectedStatus);
      expect(response.body.error.code).toBe(expectedCode);
      expectManagedBookerJobResponse(response.body, jobId);
    }
  );

  it.each([
    ['failed', 500, 'ASYNC_GPT_JOB_FAILED'],
    ['cancelled', 409, 'ASYNC_GPT_JOB_CANCELLED'],
    ['expired', 410, 'ASYNC_GPT_JOB_EXPIRED'],
    ['missing', 500, 'ASYNC_GPT_JOB_MISSING'],
  ] as const)(
    'projects an authenticated Booker %s job response onto the managed bearer lane',
    async (state, expectedStatus, expectedCode) => {
      const accessToken = `backstage-${'t'.repeat(48)}`;
      const jobId = '33333333-3333-4333-8333-333333333333';
      process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
      process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
        Buffer.alloc(32, 0x63).toString('base64');
      mockResolveGptRouting.mockResolvedValueOnce(
        buildBackstageRouting('generateBooking')
      );
      findOrCreateGptJobMock.mockImplementationOnce(async (options: { input: unknown }) => ({
        job: { id: jobId, job_type: 'gpt', status: 'pending', input: options.input },
        created: true,
        deduped: false,
        dedupeReason: 'new_job',
      }));
      waitForQueuedGptJobCompletionMock.mockResolvedValueOnce({
        state,
        job: state === 'missing'
          ? null
          : {
              id: jobId,
              status: state,
              error_message: `private-${state}-sentinel`,
            },
      });

      const response = await request(buildApp())
        .post('/gpt/backstage-booker')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          action: 'generateBooking',
          executionMode: 'sync',
          payload: {
            universeId: 'my-universe-2k26',
            prompt: 'Return exactly six matches for Raw.',
          },
        });

      expect(response.status).toBe(expectedStatus);
      expect(response.body.error.code).toBe(expectedCode);
      expectManagedBookerJobResponse(response.body, jobId);
    }
  );

  it('projects waiter repository failure without exposing a dynamic job capability', async () => {
    const accessToken = `backstage-${'z'.repeat(48)}`;
    const jobId = '44444444-4444-4444-8444-444444444444';
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x64).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    findOrCreateGptJobMock.mockImplementationOnce(async (options: { input: unknown }) => ({
      job: { id: jobId, job_type: 'gpt', status: 'pending', input: options.input },
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    }));
    waitForQueuedGptJobCompletionMock.mockRejectedValueOnce(
      new MockJobRepositoryUnavailableError('private-waiter-repository-sentinel')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ASYNC_GPT_JOBS_UNAVAILABLE');
    expectManagedBookerJobResponse(response.body, jobId);
    expect(JSON.stringify(response.body)).not.toContain('private-waiter-repository-sentinel');
  });

  it.each([
    'yes',
    'TRUE',
    ' true ',
    'FALSE',
    ' false ',
    '1',
    '0',
    'no',
    '',
  ])('does not enable protected Booker queueing for non-exact flag value %j', async (flagValue) => {
    const accessToken = `backstage-${'s'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = flagValue;
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x57).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: 'Synchronous rollback result.',
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        route: 'backstage-booker',
        timestamp: '2026-08-23T12:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      });

    expect(response.status).toBe(200);
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('deduplicates equivalent protected Booker submissions with the stable authenticated actor identity', async () => {
    const accessToken = `backstage-${'d'.repeat(48)}`;
    const rotatedAccessToken = `backstage-${'e'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x55).toString('base64');
    process.env.GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS = '1';
    mockResolveGptRouting
      .mockResolvedValueOnce(buildBackstageRouting('generateBooking'))
      .mockResolvedValueOnce(buildBackstageRouting('generateBooking'));
    findOrCreateGptJobMock
      .mockImplementationOnce(async (options: { input: unknown }) => ({
        job: {
          id: 'job-orchestrated',
          job_type: 'gpt',
          status: 'pending',
          input: options.input,
        },
        created: true,
        deduped: false,
        dedupeReason: 'new_job',
      }))
      .mockImplementationOnce(async (options: { input: unknown }) => ({
        job: {
          id: 'job-orchestrated',
          job_type: 'gpt',
          status: 'pending',
          input: options.input,
        },
        created: false,
        deduped: true,
        dedupeReason: 'reused_inflight_job',
      }));
    const payload = {
      action: 'generateBooking',
      executionMode: 'sync',
      payload: {
        universeId: 'my-universe-2k26',
        prompt: 'Return exactly six matches for Raw week 18.',
      },
    };

    const first = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(payload);
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = rotatedAccessToken;
    const duplicate = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${rotatedAccessToken}`)
      .send(payload);

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(first.body).toMatchObject({
      jobId: 'job-orchestrated',
      poll:
        '/gpt-access/capabilities/v1/backstage-booker/jobs/job-orchestrated/result',
    });
    expect(duplicate.body).toMatchObject({
      jobId: 'job-orchestrated',
      deduped: true,
      poll:
        '/gpt-access/capabilities/v1/backstage-booker/jobs/job-orchestrated/result',
    });
    for (const acceptedResponse of [first.body, duplicate.body]) {
      expect(acceptedResponse).not.toHaveProperty('jobReadToken');
      expect(acceptedResponse).not.toHaveProperty('jobReadTokenHeader');
      expect(acceptedResponse).not.toHaveProperty('stream');
    }
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(2);
    const expectedStableScopeHash = buildGptIdempotencyScopeHash({
      surface: 'public-gpt',
      actorKey: BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY,
    });
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]?.idempotencyScopeHash)
      .toBe(expectedStableScopeHash);
    expect(findOrCreateGptJobMock.mock.calls[1]?.[0]?.idempotencyScopeHash)
      .toBe(expectedStableScopeHash);
    const expectedClientProvenance = {
      version: 1,
      source: 'gpt-client-registry',
      clientId: 'backstage-booker',
      gptId: 'backstage-booker',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      runtimeModel: null,
      modelIdentityAssurance: 'unknown',
    };
    for (const createCall of findOrCreateGptJobMock.mock.calls) {
      const serializedInput = JSON.stringify(createCall[0]?.input);
      expect(serializedInput).not.toContain(accessToken);
      expect(serializedInput).not.toContain(rotatedAccessToken);
      expect(
        createCall[0]?.createOptions?.autonomyState?.gptClientProvenance
      ).toEqual(expectedClientProvenance);
      const serializedCreateCall = JSON.stringify(createCall[0]);
      expect(serializedCreateCall).not.toContain(accessToken);
      expect(serializedCreateCall).not.toContain(rotatedAccessToken);
    }
    expect(
      findOrCreateGptJobMock.mock.calls[0]?.[0]
        ?.createOptions?.autonomyState?.gptClientProvenance
    ).toEqual(
      findOrCreateGptJobMock.mock.calls[1]?.[0]
        ?.createOptions?.autonomyState?.gptClientProvenance
    );
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]?.requestFingerprintHash)
      .toBe(findOrCreateGptJobMock.mock.calls[1]?.[0]?.requestFingerprintHash);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledTimes(2);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenNthCalledWith(
      2,
      'job-orchestrated',
      expect.objectContaining({
        waitForResultMs: BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS,
        pollIntervalMs: 250,
        signal: expect.any(AbortSignal),
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('deduplicates omitted and aliased Booker actions after canonical binding', async () => {
    const accessToken = `backstage-${'c'.repeat(48)}`;
    const idempotencyKey = 'canonical-booker-action-identity';
    const payload = {
      universeId: 'my-universe-2k26',
      prompt: 'Return exactly six matches for Raw week 18.',
    };
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x56).toString('base64');
    mockResolveGptRouting
      .mockResolvedValueOnce(buildBackstageRouting('generateBooking'))
      .mockResolvedValueOnce(buildBackstageRouting('generateBooking'));
    findOrCreateGptJobMock
      .mockImplementationOnce(async (options: { input: unknown }) => ({
        job: {
          id: 'job-canonical-action',
          job_type: 'gpt',
          status: 'pending',
          input: options.input,
        },
        created: true,
        deduped: false,
        dedupeReason: 'new_job',
      }))
      .mockImplementationOnce(async (options: { input: unknown }) => ({
        job: {
          id: 'job-canonical-action',
          job_type: 'gpt',
          status: 'pending',
          input: options.input,
        },
        created: false,
        deduped: true,
        dedupeReason: 'reused_inflight_job',
      }));

    const omitted = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ payload });
    const aliased = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ action: [null, ['GenerateBooking']], payload });

    expect(omitted.status).toBe(202);
    expect(aliased.status).toBe(202);
    expect(aliased.body).toMatchObject({
      jobId: 'job-canonical-action',
      deduped: true,
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(2);
    const firstOptions = findOrCreateGptJobMock.mock.calls[0]?.[0];
    const secondOptions = findOrCreateGptJobMock.mock.calls[1]?.[0];
    expect(firstOptions?.requestFingerprintHash)
      .toBe(secondOptions?.requestFingerprintHash);
    expect(firstOptions?.idempotencyScopeHash)
      .toBe(secondOptions?.idempotencyScopeHash);
    expect(parseQueuedGptJobInput(firstOptions?.input)).toMatchObject({
      ok: true,
      value: { body: { action: 'generateBooking' } },
    });
    expect(parseQueuedGptJobInput(secondOptions?.input)).toMatchObject({
      ok: true,
      value: { body: { action: 'generateBooking' } },
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('fails closed before queue or model execution when protected Booker queue configuration is missing', async () => {
    const accessToken = `backstage-${'m'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'BACKSTAGE_ASYNC_UNAVAILABLE' },
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('fails closed without a web model call when protected Booker job persistence is unavailable', async () => {
    const accessToken = `backstage-${'p'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x58).toString('base64');
    mockResolveGptRouting.mockResolvedValueOnce(
      buildBackstageRouting('generateBooking')
    );
    findOrCreateGptJobMock.mockRejectedValueOnce(
      new MockJobRepositoryUnavailableError('private-repository-failure-sentinel')
    );

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'BACKSTAGE_ASYNC_UNAVAILABLE' },
    });
    expect(JSON.stringify(response.body)).not.toContain('private-repository-failure-sentinel');
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('keeps the documented synchronous rollback and lightweight continuity policies deterministic', async () => {
    const accessToken = `backstage-${'r'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'false';
    mockResolveGptRouting
      .mockResolvedValueOnce(buildBackstageRouting('generateBooking'))
      .mockResolvedValueOnce(buildBackstageRouting('queryContinuity'));
    mockRouteGptRequest
      .mockResolvedValueOnce({
        ok: true,
        result: 'Legacy synchronous rollback result.',
        _route: {
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage-booker',
          timestamp: '2026-08-23T12:00:00.000Z',
        },
      })
      .mockResolvedValueOnce(buildBackstageContinuityQueryEnvelope());

    const rollback = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'generateBooking',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches for Raw.',
        },
      });
    process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
    const continuity = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        action: 'queryContinuity',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Who is the Raw champion?',
        },
      });

    expect(rollback.status).toBe(200);
    expect(continuity.status).toBe(200);
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(2);
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
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
    expect(
      findOrCreateGptJobMock.mock.calls[0]?.[0]?.createOptions?.autonomyState
    ).not.toHaveProperty('gptClientProvenance');
  });

  it('persists registered client provenance for an authenticated async query bridge without planner state', async () => {
    const accessToken = `backstage-${'i'.repeat(48)}`;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
    planAutonomousWorkerJobMock.mockResolvedValueOnce({
      status: 'pending',
      retryCount: 0,
      maxRetries: 2,
      priority: 85,
      planningReasons: [],
    });

    const response = await request(buildApp())
      .post('/gpt/backstage-booker')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-OpenAI-Model', 'caller-spoofed-header-model')
      .send({
        action: 'query',
        prompt: 'Generate a promo prompt.',
        executionMode: 'fast',
        clientId: 'caller-spoofed-client',
        runtimeModel: 'caller-spoofed-model',
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'query',
      status: 'queued',
      jobId: 'job-orchestrated',
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    const createCall = findOrCreateGptJobMock.mock.calls[0]?.[0] as {
      createOptions?: {
        autonomyState?: Record<string, unknown>;
      };
    };
    expect(createCall.createOptions?.autonomyState).toEqual({
      gptClientProvenance: {
        version: 1,
        source: 'gpt-client-registry',
        clientId: 'backstage-booker',
        gptId: 'backstage-booker',
        authenticationType: 'managed-api-key',
        registeredModelProfile: null,
        runtimeModel: null,
        modelIdentityAssurance: 'unknown',
      },
    });
    expect(JSON.stringify(createCall)).not.toContain(accessToken);
    expect(JSON.stringify(createCall)).not.toContain('caller-spoofed-header-model');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });
});
