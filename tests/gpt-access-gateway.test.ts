import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const writePublicHealthResponseMock = jest.fn();
const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const transactionMock = jest.fn();
const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const getJobQueueSummaryMock = jest.fn();
const getWorkerControlHealthMock = jest.fn();
const getWorkerControlStatusMock = jest.fn();
const getWorkerRuntimeStatusMock = jest.fn();
const buildSafetySelfHealSnapshotMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const resolveGptRoutingMock = jest.fn();

class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}

jest.unstable_mockModule('../src/core/diagnostics.js', () => ({
  writePublicHealthResponse: writePublicHealthResponseMock
}));

jest.unstable_mockModule('../src/core/db/index.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock,
  query: queryMock,
  transaction: transactionMock
}));

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
  getJobById: getJobByIdMock,
  getJobQueueSummary: getJobQueueSummaryMock
}));

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: resolveGptRoutingMock
}));

jest.unstable_mockModule('../src/services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    getHealthSnapshot: jest.fn(() => ({
      status: 'ok',
      timestamp: '2026-04-27T10:00:00.000Z',
      uptime: 42,
      memory: {
        rss_mb: 1,
        heap_total_mb: 1,
        heap_used_mb: 1,
        external_mb: 0,
        array_buffers_mb: 0
      }
    }))
  }
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlHealth: getWorkerControlHealthMock,
  getWorkerControlStatus: getWorkerControlStatusMock
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: planAutonomousWorkerJobMock
}));

jest.unstable_mockModule('../src/services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: buildSafetySelfHealSnapshotMock
}));

jest.unstable_mockModule('../src/platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock
}));

const { default: gptAccessRouter } = await import('../src/routes/gpt-access.js');
const { createGptAccessAiJob, sanitizeGptAccessPayload } = await import('../src/services/gptAccessGateway.js');

const TEST_TOKEN = 'test-gpt-access-token';
const COMPLETED_JOB_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_JOB_ID = '22222222-2222-4222-8222-222222222222';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', gptAccessRouter);
  return app;
}

function authorized(requestBuilder: request.Test): request.Test {
  return requestBuilder.set('Authorization', `Bearer ${TEST_TOKEN}`);
}

function allowCreateJobs(scopes = 'jobs.create,jobs.result'): void {
  process.env.ARCANOS_GPT_ACCESS_SCOPES = scopes;
}

function buildNestedObject(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;

  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.child = next;
    cursor = next;
  }

  return root;
}

describe('/gpt-access gateway', () => {
  const previousToken = process.env.ARCANOS_GPT_ACCESS_TOKEN;
  const previousScopes = process.env.ARCANOS_GPT_ACCESS_SCOPES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ARCANOS_GPT_ACCESS_TOKEN = TEST_TOKEN;
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;
    getPoolMock.mockReturnValue({});
    isDatabaseConnectedMock.mockReturnValue(true);
    getWorkerControlStatusMock.mockResolvedValue({
      timestamp: '2026-04-27T10:00:00.000Z',
      mainApp: { connected: true },
      workerService: { queueSummary: { pending: 0 } }
    });
    getWorkerControlHealthMock.mockResolvedValue({
      overallStatus: 'healthy',
      alerts: []
    });
    getJobQueueSummaryMock.mockResolvedValue({
      pending: 0,
      running: 0,
      failed: 0
    });
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: true,
      started: true
    });
    buildSafetySelfHealSnapshotMock.mockReturnValue({
      status: 'ok',
      active: false
    });
    writePublicHealthResponseMock.mockImplementation(async (_req, res) => {
      res.json({ status: 'ok', service: 'arcanos-backend' });
    });
    resolveGptRoutingMock.mockResolvedValue({
      ok: true,
      plan: {
        matchedId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact'
      },
      _route: {
        gptId: 'arcanos-core',
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-27T10:00:00.000Z'
      }
    });
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
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        id: CREATED_JOB_ID,
        status: 'pending'
      },
      created: true,
      deduped: false,
      dedupeReason: 'new_job'
    });
  });

  afterEach(() => {
    if (previousToken === undefined) {
      delete process.env.ARCANOS_GPT_ACCESS_TOKEN;
    } else {
      process.env.ARCANOS_GPT_ACCESS_TOKEN = previousToken;
    }

    if (previousScopes === undefined) {
      delete process.env.ARCANOS_GPT_ACCESS_SCOPES;
    } else {
      process.env.ARCANOS_GPT_ACCESS_SCOPES = previousScopes;
    }
  });

  it('rejects missing bearer token', async () => {
    const response = await request(buildApp()).get('/gpt-access/health');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
  });

  it('rejects invalid bearer token', async () => {
    const response = await request(buildApp())
      .get('/gpt-access/health')
      .set('Authorization', 'Bearer wrong-token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
  });

  it('allows valid bearer token and returns gateway health', async () => {
    const response = await authorized(request(buildApp()).get('/gpt-access/health'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'arcanos-gpt-access',
      authRequired: true,
      version: '1.0.0'
    }));
  });

  it('enforces configured endpoint scopes after bearer auth succeeds', async () => {
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'runtime.read';

    const deniedResponse = await authorized(request(buildApp()).get('/gpt-access/health'));
    const allowedResponse = await authorized(request(buildApp()).get('/gpt-access/status'));

    expect(deniedResponse.status).toBe(403);
    expect(deniedResponse.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.body).toEqual({ status: 'ok', service: 'arcanos-backend' });
  });

  it('requires bearer auth before creating AI jobs', async () => {
    const response = await request(buildApp())
      .post('/gpt-access/jobs/create')
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('enforces the jobs.create scope before creating AI jobs', async () => {
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'jobs.result';

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('requires jobs.create to be explicitly configured instead of inheriting read defaults', async () => {
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects missing task text before enqueueing AI jobs', async () => {
    allowCreateJobs();

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        input: {
          purpose: 'documentation update prompt'
        }
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'task must be a non-empty string with at most 8000 characters.'
    });
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects unknown GPT IDs before enqueueing AI jobs', async () => {
    allowCreateJobs();
    resolveGptRoutingMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'UNKNOWN_GPT',
        message: "gptId 'unknown-gpt' is not registered"
      },
      _route: {
        gptId: 'unknown-gpt',
        timestamp: '2026-04-27T10:00:00.000Z'
      }
    });

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'unknown-gpt',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'Unknown or unauthorized gptId.'
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects invalid GPT ID formats before route resolution', async () => {
    allowCreateJobs();

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: '../arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'gptId must be a non-empty string with at most 128 characters.'
    });
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects overlong task text before enqueueing AI jobs', async () => {
    allowCreateJobs();

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'x'.repeat(8001)
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'task must be a non-empty string with at most 8000 characters.'
    });
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe extra properties before enqueueing AI jobs', async () => {
    allowCreateJobs();

    const unsafeTopLevelResponse = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        url: 'https://internal.example'
      });
    const unsafeNestedResponse = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        input: {
          headers: {
            authorization: 'Bearer secret'
          }
        }
      });

    expect(unsafeTopLevelResponse.status).toBe(400);
    expect(unsafeTopLevelResponse.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: "Unsafe field 'url' is not allowed for AI job creation."
    });
    expect(unsafeNestedResponse.status).toBe(400);
    expect(unsafeNestedResponse.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: "Unsafe field 'input.headers' is not allowed for AI job creation."
    });
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects excessively nested payloads before recursive schema parsing', async () => {
    allowCreateJobs();

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        input: buildNestedObject(80)
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'AI job request nesting depth must be 64 levels or fewer.'
    });
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('creates async AI jobs through the durable GPT queue without calling /gpt/:gptId', async () => {
    allowCreateJobs();
    let gptRouteCalled = false;
    const app = buildApp();
    app.post('/gpt/:gptId', (_req, res) => {
      gptRouteCalled = true;
      res.status(500).json({ error: 'unexpected gpt route' });
    });

    const response = await authorized(request(app).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt to update repository docs.',
        input: {
          purpose: 'documentation update prompt',
          includeSuccessCriteria: true,
          allowSubAgents: true
        },
        maxOutputTokens: 1200
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      jobId: CREATED_JOB_ID,
      traceId: expect.any(String),
      status: 'queued',
      deduped: false,
      resultEndpoint: '/gpt-access/jobs/result'
    });
    expect(gptRouteCalled).toBe(false);
    expect(resolveGptRoutingMock).toHaveBeenCalledWith('arcanos-core', response.body.traceId);
    expect(planAutonomousWorkerJobMock).toHaveBeenCalledTimes(1);
    const queuedInput = planAutonomousWorkerJobMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(queuedInput).toMatchObject({
      gptId: 'arcanos-core',
      prompt: 'Generate a Codex IDE prompt to update repository docs.',
      bypassIntentRouting: true,
      routeHint: 'query',
      requestPath: '/gpt-access/jobs/create',
      executionModeReason: 'gpt_access_create_ai_job'
    });
    expect(queuedInput.body).toMatchObject({
      action: 'query',
      prompt: 'Generate a Codex IDE prompt to update repository docs.',
      executionMode: 'async',
      maxWords: 1200,
      __arcanosSuppressPromptDebugTrace: true,
      payload: {
        source: 'gpt-access',
        maxOutputTokens: 1200,
        maxWords: 1200
      }
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      workerId: 'gpt-access',
      input: queuedInput,
      idempotencyOrigin: 'derived'
    }));
  });

  it('returns created AI job results through the existing GPT access job-result endpoint', async () => {
    allowCreateJobs();

    const createResponse = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });
    getJobByIdMock.mockResolvedValue({
      id: CREATED_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-27T10:00:00.000Z',
      updated_at: '2026-04-27T10:01:00.000Z',
      completed_at: '2026-04-27T10:01:00.000Z',
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      error_message: null,
      output: { answer: 'generated prompt' }
    });

    const resultResponse = await authorized(request(buildApp()).post('/gpt-access/jobs/result'))
      .send({
        jobId: createResponse.body.jobId,
        traceId: createResponse.body.traceId
      });

    expect(createResponse.status).toBe(202);
    expect(resultResponse.status).toBe(200);
    expect(resultResponse.body).toEqual(expect.objectContaining({
      ok: true,
      traceId: createResponse.body.traceId,
      jobId: CREATED_JOB_ID,
      status: 'completed',
      result: { answer: 'generated prompt' }
    }));
  });

  it('returns the same UUID jobId and deduped true for duplicate create requests', async () => {
    allowCreateJobs();
    findOrCreateGptJobMock
      .mockResolvedValueOnce({
        job: {
          id: CREATED_JOB_ID,
          status: 'pending'
        },
        created: true,
        deduped: false,
        dedupeReason: 'new_job'
      })
      .mockResolvedValueOnce({
        job: {
          id: CREATED_JOB_ID,
          status: 'pending'
        },
        created: false,
        deduped: true,
        dedupeReason: 'reused_inflight_job'
      });

    const firstResponse = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        idempotencyKey: 'client-retry-key'
      });
    const secondResponse = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        idempotencyKey: 'client-retry-key'
      });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstResponse.body).toEqual(expect.objectContaining({
      jobId: CREATED_JOB_ID,
      deduped: false,
      resultEndpoint: '/gpt-access/jobs/result'
    }));
    expect(secondResponse.body).toEqual(expect.objectContaining({
      jobId: CREATED_JOB_ID,
      deduped: true,
      resultEndpoint: '/gpt-access/jobs/result'
    }));
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(2);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      idempotencyOrigin: 'explicit',
      idempotencyKeyHash: expect.any(String)
    }));
  });

  it('returns 409 for explicit idempotency key conflicts', async () => {
    allowCreateJobs();
    findOrCreateGptJobMock.mockRejectedValueOnce(
      new MockIdempotencyKeyConflictError('Explicit idempotency key mapped to a different request.')
    );

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .set('Idempotency-Key', 'client-retry-key')
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_IDEMPOTENCY_CONFLICT',
      message: 'The supplied idempotency key is already bound to a different GPT request.'
    });
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
  });

  it('returns a structured unavailable error when durable AI jobs cannot be created', async () => {
    allowCreateJobs();
    findOrCreateGptJobMock.mockRejectedValueOnce(
      new MockJobRepositoryUnavailableError('Database not configured')
    );

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_JOBS_UNAVAILABLE',
      message: 'Durable GPT job persistence is unavailable.'
    });
  });

  it('logs AI job creation metadata without raw prompts or secrets', async () => {
    const fakeOpenAiCredential = 'sk-test-placeholder-value';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    const response = await createGptAccessAiJob(
      {
        gptId: 'arcanos-core',
        task: `Generate a Codex prompt and do not expose ${fakeOpenAiCredential}`,
        input: {
          token: 'Bearer live-token-value',
          purpose: 'documentation update prompt'
        }
      },
      {
        actorKey: 'test-actor',
        requestId: 'req-safe-log',
        traceId: 'trace-safe-log',
        logger
      }
    );
    const renderedLogs = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);

    expect(response.statusCode).toBe(202);
    expect(renderedLogs).toContain('trace-safe-log');
    expect(renderedLogs).toContain('createAiJob');
    expect(renderedLogs).toContain('arcanos-core');
    expect(renderedLogs).not.toContain(fakeOpenAiCredential);
    expect(renderedLogs).not.toContain('Generate a Codex prompt');
    expect(renderedLogs).not.toContain('live-token-value');
  });

  it('allows approved MCP tools only', async () => {
    const response = await authorized(request(buildApp()).post('/gpt-access/mcp'))
      .send({ tool: 'workers.status', args: {} });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      tool: 'workers.status'
    }));
    expect(getWorkerControlStatusMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown MCP tools', async () => {
    const response = await authorized(request(buildApp()).post('/gpt-access/mcp'))
      .send({ tool: 'deploy.rollback', args: {} });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(getWorkerControlStatusMock).not.toHaveBeenCalled();
  });

  it('rejects raw SQL and unknown db explain query keys', async () => {
    const rawSqlResponse = await authorized(request(buildApp()).post('/gpt-access/db/explain'))
      .send({ sql: 'SELECT * FROM job_data' });

    expect(rawSqlResponse.status).toBe(403);
    expect(rawSqlResponse.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');

    const unknownKeyResponse = await authorized(request(buildApp()).post('/gpt-access/db/explain'))
      .send({ queryKey: 'raw_mutation', params: {} });

    expect(unknownKeyResponse.status).toBe(403);
    expect(unknownKeyResponse.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('looks up job results directly without calling /gpt/:gptId', async () => {
    let gptRouteCalled = false;
    const app = buildApp();
    app.post('/gpt/:gptId', (_req, res) => {
      gptRouteCalled = true;
      res.status(500).json({ error: 'unexpected gpt route' });
    });
    getJobByIdMock.mockResolvedValue({
      id: COMPLETED_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-27T10:00:00.000Z',
      updated_at: '2026-04-27T10:01:00.000Z',
      completed_at: '2026-04-27T10:01:00.000Z',
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      error_message: null,
      output: { answer: 'stored output' }
    });

    const response = await authorized(request(app).post('/gpt-access/jobs/result'))
      .send({ jobId: COMPLETED_JOB_ID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      jobId: COMPLETED_JOB_ID,
      status: 'completed',
      result: { answer: 'stored output' }
    }));
    expect(getJobByIdMock).toHaveBeenCalledWith(COMPLETED_JOB_ID);
    expect(gptRouteCalled).toBe(false);
  });

  it('redacts obvious secrets from log-shaped payloads', () => {
    const fakeOpenAiCredential = 'sk-test-placeholder-value';
    const fakeJwt = ['eyJmock12345', 'eyJmock67890', 'eyJmock12345'].join('.');
    const sanitized = sanitizeGptAccessPayload({
      authorization: 'Bearer live-token-value',
      message: `Authorization: Bearer abcdefghijklmnop OPENAI_API_KEY=${fakeOpenAiCredential} DATABASE_URL=postgres://user:pass@host/db token=railway_abcdefghijklmnop ${fakeJwt} password=hunter2`,
      email: 'person@example.com',
      nested: {
        cookie: 'sessionid=secret-session'
      }
    });
    const rendered = JSON.stringify(sanitized);

    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('live-token-value');
    expect(rendered).not.toContain(fakeOpenAiCredential);
    expect(rendered).not.toContain(fakeJwt);
    expect(rendered).not.toContain('postgres://user:pass@host/db');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('person@example.com');
  });

  it('returns sanitized logs from the GPT access log query endpoint', async () => {
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'logs.read_sanitized';
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          worker_id: 'api',
          timestamp: '2026-04-27T10:00:00.000Z',
          level: 'info',
          message: 'prompt marker SECRET-PROMPT authorization=Bearer live-token OPENAI_API_KEY=sk-test-placeholder-value',
          metadata: {
            prompt: 'SECRET-PROMPT raw prompt text',
            cookie: 'sessionid=secret-session',
            nested: {
              database_url: 'postgres://user:pass@host/db'
            }
          }
        }
      ]
    });

    const response = await authorized(request(buildApp()).post('/gpt-access/logs/query'))
      .send({
        level: 'info',
        contains: 'SECRET-PROMPT',
        sinceMinutes: 5,
        limit: 1
      });
    const rendered = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      count: 1
    }));
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('[REDACTED_PROMPT]');
    expect(rendered).not.toContain('SECRET-PROMPT raw prompt text');
    expect(rendered).not.toContain('live-token');
    expect(rendered).not.toContain('sk-test-placeholder-value');
    expect(rendered).not.toContain('sessionid=secret-session');
    expect(rendered).not.toContain('postgres://user:pass@host/db');
  });

  it('returns a Custom GPT compatible OpenAPI document', async () => {
    const response = await authorized(request(buildApp()).get('/gpt-access/openapi.json'));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.servers).toEqual([
      { url: 'https://acranos-production.up.railway.app' }
    ]);
    expect(response.body.components.securitySchemes.bearerAuth).toEqual(expect.objectContaining({
      type: 'http',
      scheme: 'bearer'
    }));
    expect(response.body.paths['/gpt-access/jobs/create'].post.operationId).toBe('createAiJob');
    expect(response.body.paths['/gpt-access/jobs/create'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(response.body.paths['/gpt-access/jobs/create'].post.requestBody.content['application/json'].schema).toEqual({
      '$ref': '#/components/schemas/CreateAiJobRequest'
    });
    const createRequestSchema = response.body.components.schemas.CreateAiJobRequest;
    expect(createRequestSchema).toEqual(expect.objectContaining({
      required: ['gptId', 'task'],
      additionalProperties: false
    }));
    expect(Object.keys(createRequestSchema.properties)).toEqual([
      'gptId',
      'task',
      'input',
      'context',
      'maxOutputTokens',
      'idempotencyKey'
    ]);
    expect(Object.keys(createRequestSchema.properties)).not.toEqual(expect.arrayContaining([
      'sql',
      'target',
      'endpoint',
      'headers',
      'auth',
      'cookies',
      'proxy',
      'url'
    ]));
    expect(response.body.components.schemas.CreateAiJobResponse).toEqual(expect.objectContaining({
      required: ['ok', 'jobId', 'traceId', 'status', 'deduped', 'resultEndpoint'],
      additionalProperties: false
    }));
    expect(response.body.paths['/gpt-access/jobs/result'].post.operationId).toBe('getJobResult');
    expect(response.body.paths['/gpt-access/mcp'].post.operationId).toBe('arcanosMcpControl');
  });
});
