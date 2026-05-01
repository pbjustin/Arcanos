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
const getModulesForRegistryMock = jest.fn();
const getModuleMetadataMock = jest.fn();
const dispatchModuleActionMock = jest.fn();

class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}
class MockModuleNotFoundError extends Error {}
class MockModuleActionNotFoundError extends Error {}

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

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  getModulesForRegistry: getModulesForRegistryMock,
  getModuleMetadata: getModuleMetadataMock,
  dispatchModuleAction: dispatchModuleActionMock,
  ModuleNotFoundError: MockModuleNotFoundError,
  ModuleActionNotFoundError: MockModuleActionNotFoundError
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

function buildApp(options: { trustProxy?: boolean } = {}) {
  const app = express();
  if (options.trustProxy) {
    app.set('trust proxy', true);
  }
  app.use(express.json());
  app.use('/', gptAccessRouter);
  return app;
}

function authorized(requestBuilder: request.Test): request.Test {
  return requestBuilder.set('Authorization', `Bearer ${TEST_TOKEN}`);
}

function confirmed(requestBuilder: request.Test): request.Test {
  return requestBuilder.set('x-confirmed', 'yes');
}

function allowCreateJobs(scopes = 'jobs.create,jobs.result'): void {
  process.env.ARCANOS_GPT_ACCESS_SCOPES = scopes;
}

function allowCapabilityRead(scopes = 'capabilities.read'): void {
  process.env.ARCANOS_GPT_ACCESS_SCOPES = scopes;
}

function allowCapabilityRun(scopes = 'capabilities.run', allowedModuleActions = 'ARCANOS:CORE:query'): void {
  process.env.ARCANOS_GPT_ACCESS_SCOPES = scopes;
  process.env.MCP_ALLOW_MODULE_ACTIONS = allowedModuleActions;
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
  const previousModuleActionAllowlist = process.env.MCP_ALLOW_MODULE_ACTIONS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ARCANOS_GPT_ACCESS_TOKEN = TEST_TOKEN;
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;
    delete process.env.MCP_ALLOW_MODULE_ACTIONS;
    getModulesForRegistryMock.mockReturnValue([
      {
        id: 'ARCANOS:CORE',
        description: 'Core runtime capability',
        route: 'core',
        actions: ['query', 'diagnostics']
      }
    ]);
    getModuleMetadataMock.mockImplementation((capabilityId: unknown) => {
      if (capabilityId !== 'ARCANOS:CORE' && capabilityId !== 'core') {
        return null;
      }

      return {
        name: 'ARCANOS:CORE',
        description: 'Core runtime capability',
        route: 'core',
        actions: ['query', 'diagnostics'],
        defaultAction: 'query',
        defaultTimeoutMs: 30000
      };
    });
    dispatchModuleActionMock.mockResolvedValue({
      message: 'capability ran'
    });
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

    if (previousModuleActionAllowlist === undefined) {
      delete process.env.MCP_ALLOW_MODULE_ACTIONS;
    } else {
      process.env.MCP_ALLOW_MODULE_ACTIONS = previousModuleActionAllowlist;
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

  it('lists capabilities from the existing module registry without implementation details', async () => {
    allowCapabilityRead();

    const response = await authorized(request(buildApp()).get('/gpt-access/capabilities/v1'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      capabilities: [
        {
          id: 'ARCANOS:CORE',
          description: 'Core runtime capability',
          route: 'core',
          actions: ['diagnostics', 'query']
        }
      ]
    });
    expect(getModulesForRegistryMock).toHaveBeenCalledTimes(1);
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain('gptIds');
    expect(rendered).not.toContain('handler');
    expect(rendered).not.toContain('function');
  });

  it('inspects a known registered capability', async () => {
    allowCapabilityRead();

    const response = await authorized(request(buildApp()).get('/gpt-access/capabilities/v1/ARCANOS%3ACORE'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      exists: true,
      capability: {
        id: 'ARCANOS:CORE',
        name: 'ARCANOS:CORE',
        description: 'Core runtime capability',
        route: 'core',
        actions: ['diagnostics', 'query'],
        defaultAction: 'query',
        defaultTimeoutMs: 30000
      }
    });
    expect(getModuleMetadataMock).toHaveBeenCalledWith('ARCANOS:CORE');
  });

  it('returns exists false when inspecting an unknown capability', async () => {
    allowCapabilityRead();

    const response = await authorized(request(buildApp()).get('/gpt-access/capabilities/v1/arcanos-core'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      exists: false,
      capability: null
    });
    expect(getModuleMetadataMock).toHaveBeenCalledWith('arcanos-core');
  });

  it('returns direct JSON for compatibility module aliases', async () => {
    allowCapabilityRead();

    const listResponse = await authorized(request(buildApp()).get('/gpt-access/modules'));
    const detailResponse = await authorized(request(buildApp()).get('/gpt-access/modules/core'));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual(expect.objectContaining({
      ok: true,
      capabilities: expect.any(Array)
    }));
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body).toEqual(expect.objectContaining({
      ok: true,
      exists: true,
      capability: expect.objectContaining({ id: 'ARCANOS:CORE' })
    }));
    expect(getModuleMetadataMock).toHaveBeenCalledWith('core');
  });

  it('requires capabilities.read to be explicitly configured before discovery', async () => {
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;

    const response = await authorized(request(buildApp()).get('/gpt-access/capabilities/v1'));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(getModulesForRegistryMock).not.toHaveBeenCalled();
  });

  it('rejects capability runs without a non-empty action before dispatch', async () => {
    allowCapabilityRun();

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({ payload: {} });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'action must be a non-empty string.'
    });
    expect(dispatchModuleActionMock).not.toHaveBeenCalled();
  });

  it('rejects capability run bodies with unsupported top-level fields', async () => {
    allowCapabilityRun();

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({
        action: 'query',
        payload: {},
        gptId: 'arcanos-core'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'request body may only include action and payload.'
    });
    expect(dispatchModuleActionMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe capability payload control fields before dispatch', async () => {
    allowCapabilityRun();

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({
        action: 'query',
        payload: {
          prompt: 'status',
          options: {
            overrideAuditSafe: true
          }
        }
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'payload contains fields that are not allowed for capability execution.'
    });
    expect(dispatchModuleActionMock).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before dispatching allowlisted capability actions', async () => {
    allowCapabilityRun();

    const response = await authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run'))
      .send({
        action: 'query',
        payload: {}
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(dispatchModuleActionMock).not.toHaveBeenCalled();
  });

  it('runs capability actions through the existing module dispatch boundary', async () => {
    allowCapabilityRun();
    dispatchModuleActionMock.mockResolvedValueOnce({
      message: 'capability ran',
      authorization: 'Bearer abcdefghijklmnop'
    });

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({
        action: 'query',
        payload: {
          prompt: 'status'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        message: 'capability ran'
      })
    }));
    expect(getModuleMetadataMock).toHaveBeenCalledWith('core');
    expect(dispatchModuleActionMock).toHaveBeenCalledWith('ARCANOS:CORE', 'query', {
      prompt: 'status'
    });
    expect(JSON.stringify(response.body)).not.toContain('abcdefghijklmnop');
  });

  it('denies capability runs when the module action is not allowlisted', async () => {
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'capabilities.run';
    delete process.env.MCP_ALLOW_MODULE_ACTIONS;

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({
        action: 'query',
        payload: {}
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
      message: 'Capability action is not allowlisted for GPT Access execution.'
    });
    expect(dispatchModuleActionMock).not.toHaveBeenCalled();
  });

  it('maps typed module dispatch misses to not found responses', async () => {
    allowCapabilityRun();
    dispatchModuleActionMock.mockRejectedValueOnce(new MockModuleNotFoundError('Module not found: ARCANOS:CORE'));

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({
        action: 'query',
        payload: {}
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_CAPABILITY_NOT_FOUND',
      message: 'Capability or action not found.'
    });
  });

  it('requires capabilities.run to be explicitly configured before running actions', async () => {
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;

    const response = await confirmed(authorized(request(buildApp()).post('/gpt-access/capabilities/v1/core/run')))
      .send({
        action: 'query',
        payload: {}
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(dispatchModuleActionMock).not.toHaveBeenCalled();
  });

  it('uses the existing module registry functions instead of caching a second registry', async () => {
    allowCapabilityRead();

    getModulesForRegistryMock
      .mockReturnValueOnce([
        {
          id: 'first-capability',
          description: null,
          route: 'first',
          actions: ['query']
        }
      ])
      .mockReturnValueOnce([
        {
          id: 'second-capability',
          description: null,
          route: 'second',
          actions: ['query']
        }
      ]);

    const firstResponse = await authorized(request(buildApp()).get('/gpt-access/capabilities/v1'));
    const secondResponse = await authorized(request(buildApp()).get('/gpt-access/capabilities/v1'));

    expect(firstResponse.body.capabilities[0].id).toBe('first-capability');
    expect(secondResponse.body.capabilities[0].id).toBe('second-capability');
    expect(getModulesForRegistryMock).toHaveBeenCalledTimes(2);
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

  it('requires bearer auth before reading AI job results', async () => {
    const response = await request(buildApp())
      .post('/gpt-access/jobs/result')
      .send({
        jobId: COMPLETED_JOB_ID
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('enforces the jobs.result scope before reading AI job results', async () => {
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'jobs.create';

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/result'))
      .send({
        jobId: COMPLETED_JOB_ID
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_ACCESS_SCOPE_DENIED');
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('sanitizes worker status payloads returned through GPT Access', async () => {
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'workers.read';
    getWorkerControlStatusMock.mockResolvedValueOnce({
      workerService: {
        health: {
          workers: [{
            workerId: 'worker-1',
            lastError: 'Authorization: Bearer abcdefghijklmnop DATABASE_URL=postgres://user:pass@host/db'
          }]
        },
        recentFailedJobs: [{
          id: 'job-1',
          error_message: 'OPENAI_API_KEY=sk-test-placeholder-value'
        }]
      }
    });
    getWorkerControlHealthMock.mockResolvedValueOnce({
      overallStatus: 'degraded',
      alerts: [`${'token'}=railway_abcdefghijklmnop`]
    });

    const statusResponse = await authorized(request(buildApp()).get('/gpt-access/workers/status'));
    const healthResponse = await authorized(request(buildApp()).get('/gpt-access/worker-helper/health'));

    expect(statusResponse.status).toBe(200);
    expect(healthResponse.status).toBe(200);
    const rendered = JSON.stringify({
      status: statusResponse.body,
      health: healthResponse.body
    });
    expect(rendered).not.toContain('abcdefghijklmnop');
    expect(rendered).not.toContain('postgres://user:pass@host/db');
    expect(rendered).not.toContain('sk-test-placeholder-value');
    expect(rendered).toContain('[REDACTED');
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
      message: 'Unsafe field is not allowed for AI job creation.'
    });
    expect(unsafeNestedResponse.status).toBe(400);
    expect(unsafeNestedResponse.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'Unsafe field is not allowed for AI job creation.'
    });
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe AI job fields in nested objects, arrays, and prototype keys', async () => {
    allowCreateJobs();
    const unsafeRequests = [
      {
        input: {
          command: 'rm -rf /'
        }
      },
      {
        input: {
          tools: [
            {
              shell: 'powershell'
            }
          ]
        }
      },
      {
        input: {
          steps: [
            {
              exec: 'node -e process.exit(1)'
            }
          ]
        }
      },
      {
        input: {
          credentials: {
            ' Token ': 'Bearer live-token-value'
          }
        }
      },
      {
        input: {
          Password: 'do-not-log'
        }
      },
      {
        input: {
          nested: {
            SECRET: 'sk-test-placeholder-value'
          }
        }
      }
    ];

    for (const unsafeRequest of unsafeRequests) {
      const response = await authorized(request(buildApp()).post('/gpt-access/jobs/create'))
        .send({
          gptId: 'arcanos-core',
          task: 'Generate a Codex IDE prompt.',
          ...unsafeRequest
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('GPT_ACCESS_VALIDATION_ERROR');
      expect(response.body.error.message).toBe('Unsafe field is not allowed for AI job creation.');
    }
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();

    const prototypeInput: Record<string, unknown> = {};
    Object.defineProperty(prototypeInput, '__proto__', {
      enumerable: true,
      configurable: true,
      value: {
        polluted: true
      }
    });
    const constructorResponse = await createGptAccessAiJob(
      {
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        input: {
          constructor: {
            prototype: {
              polluted: true
            }
          }
        }
      },
      { actorKey: 'test-actor' }
    );
    const protoResponse = await createGptAccessAiJob(
      {
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        input: prototypeInput
      },
      { actorKey: 'test-actor' }
    );

    expect(constructorResponse.statusCode).toBe(400);
    expect(protoResponse.statusCode).toBe(400);
    expect(JSON.stringify({ constructorResponse, protoResponse })).not.toContain('polluted');
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('does not echo attacker-controlled unsafe field paths in errors or logs', async () => {
    allowCreateJobs();
    const secretKeySegment = 'sk-test-secret-in-key-name';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    const response = await createGptAccessAiJob(
      {
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.',
        input: {
          [secretKeySegment]: {
            url: 'https://internal.example/metadata'
          }
        }
      },
      {
        actorKey: 'test-actor',
        requestId: 'req-unsafe-path',
        traceId: 'trace-unsafe-path',
        logger
      }
    );
    const rendered = JSON.stringify({
      response,
      logs: [
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls
      ]
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'Unsafe field is not allowed for AI job creation.'
    });
    expect(rendered).toContain('url');
    expect(rendered).not.toContain(secretKeySegment);
    expect(rendered).not.toContain('https://internal.example/metadata');
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
      input: {
        requestPath: '/gpt-access/jobs/create',
        executionModeReason: 'gpt_access_create_ai_job'
      },
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
      input: {
        requestPath: '/gpt-access/jobs/create',
        executionModeReason: 'gpt_access_create_ai_job'
      },
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

  it('does not expose non-gateway or non-GPT job outputs through GPT Access result polling', async () => {
    getJobByIdMock.mockResolvedValue({
      id: COMPLETED_JOB_ID,
      job_type: 'dag-node',
      status: 'completed',
      input: {
        dagId: 'dag-1'
      },
      created_at: '2026-04-27T10:00:00.000Z',
      updated_at: '2026-04-27T10:01:00.000Z',
      completed_at: '2026-04-27T10:01:00.000Z',
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      error_message: null,
      output: { answer: 'should not leak' }
    });

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/result'))
      .send({ jobId: COMPLETED_JOB_ID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      jobId: COMPLETED_JOB_ID,
      status: 'not_found',
      result: null
    }));
    expect(JSON.stringify(response.body)).not.toContain('should not leak');
  });

  it('returns unavailable instead of not_found when result storage is disconnected', async () => {
    isDatabaseConnectedMock.mockReturnValueOnce(false);

    const response = await authorized(request(buildApp()).post('/gpt-access/jobs/result'))
      .send({ jobId: COMPLETED_JOB_ID });

    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_JOBS_UNAVAILABLE',
      message: 'Durable GPT job persistence is unavailable.'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
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
    expect(response.body.paths['/gpt-access/capabilities/v1'].get.operationId).toBe('listCapabilitiesV1');
    expect(response.body.paths['/gpt-access/capabilities/v1'].get.responses['200'].content['application/json'].schema).toEqual({
      '$ref': '#/components/schemas/CapabilitiesV1Response'
    });
    expect(response.body.paths['/gpt-access/capabilities/v1/{id}'].get.operationId).toBe('getCapabilityV1');
    expect(response.body.paths['/gpt-access/capabilities/v1/{id}/run'].post.operationId).toBe('runCapabilityV1');
    expect(response.body.paths['/gpt-access/capabilities/v1/{id}/run'].post.requestBody.content['application/json'].schema).toEqual({
      '$ref': '#/components/schemas/CapabilityRunRequest'
    });
    expect(response.body.paths['/gpt-access/modules'].get.operationId).toBe('listGptAccessModulesAlias');
    expect(response.body.paths['/gpt-access/modules/{id}'].get.operationId).toBe('getGptAccessModuleAlias');
    expect(response.body.components.schemas.CapabilityRunRequest).toEqual(expect.objectContaining({
      required: ['action'],
      additionalProperties: false
    }));
    expect(response.body.components.schemas.CapabilityRunRequest.properties.action).toEqual({
      type: 'string',
      minLength: 1,
      pattern: '.*\\S.*'
    });
    expect(response.body.components.schemas.CapabilitiesV1Response).toEqual(expect.objectContaining({
      required: ['ok', 'capabilities'],
      additionalProperties: false
    }));
    expect(response.body.paths['/gpt-access/jobs/result'].post.operationId).toBe('getJobResult');
    expect(response.body.paths['/gpt-access/mcp'].post.operationId).toBe('arcanosMcpControl');
  });

  it('rate limits invalid bearer attempts by client address, not rotating token value', async () => {
    const app = buildApp();
    let lastResponse: request.Response | null = null;

    for (let index = 0; index < 121; index += 1) {
      lastResponse = await request(app)
        .post('/gpt-access/jobs/create')
        .set('Authorization', `Bearer invalid-token-${index}`)
        .set('X-Forwarded-For', '203.0.113.240')
        .send({
          gptId: 'arcanos-core',
          task: 'Generate a Codex IDE prompt.'
        });
    }

    expect(lastResponse?.status).toBe(429);
    expect(lastResponse?.body).toEqual(expect.objectContaining({
      error: 'Rate limit exceeded',
      message: 'Too many requests for gpt-access. Try again later.'
    }));
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('uses Express client IP semantics for GPT Access rate limiting behind trusted proxies', async () => {
    const app = buildApp({ trustProxy: true });

    for (let index = 0; index < 120; index += 1) {
      await request(app)
        .post('/gpt-access/jobs/create')
        .set('Authorization', `Bearer invalid-token-${index}`)
        .set('X-Forwarded-For', '203.0.113.240')
        .send({
          gptId: 'arcanos-core',
          task: 'Generate a Codex IDE prompt.'
        });
    }

    const sameClientResponse = await request(app)
      .post('/gpt-access/jobs/create')
      .set('Authorization', `Bearer ${'invalid-token-same-client'}`)
      .set('X-Forwarded-For', '203.0.113.240')
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });
    const differentClientResponse = await request(app)
      .post('/gpt-access/jobs/create')
      .set('Authorization', `Bearer ${'invalid-token-different-client'}`)
      .set('X-Forwarded-For', '203.0.113.241')
      .send({
        gptId: 'arcanos-core',
        task: 'Generate a Codex IDE prompt.'
      });

    expect(sameClientResponse.status).toBe(429);
    expect(differentClientResponse.status).toBe(401);
  });
});
