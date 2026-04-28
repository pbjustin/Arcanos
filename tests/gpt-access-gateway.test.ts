import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const writePublicHealthResponseMock = jest.fn();
const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const transactionMock = jest.fn();
const getJobByIdMock = jest.fn();
const getJobQueueSummaryMock = jest.fn();
const getWorkerControlHealthMock = jest.fn();
const getWorkerControlStatusMock = jest.fn();
const getWorkerRuntimeStatusMock = jest.fn();
const buildSafetySelfHealSnapshotMock = jest.fn();

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
  getJobById: getJobByIdMock,
  getJobQueueSummary: getJobQueueSummaryMock
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

jest.unstable_mockModule('../src/services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: buildSafetySelfHealSnapshotMock
}));

jest.unstable_mockModule('../src/platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock
}));

const { default: gptAccessRouter } = await import('../src/routes/gpt-access.js');
const { sanitizeGptAccessPayload } = await import('../src/services/gptAccessGateway.js');

const TEST_TOKEN = 'test-gpt-access-token';
const COMPLETED_JOB_ID = '11111111-1111-4111-8111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', gptAccessRouter);
  return app;
}

function authorized(requestBuilder: request.Test): request.Test {
  return requestBuilder.set('Authorization', `Bearer ${TEST_TOKEN}`);
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
    expect(response.body.paths['/gpt-access/jobs/result'].post.operationId).toBe('getJobResult');
    expect(response.body.paths['/gpt-access/mcp'].post.operationId).toBe('arcanosMcpControl');
  });
});
