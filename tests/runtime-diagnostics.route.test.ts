import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const request = (await import('supertest')).default;
const CURRENT_GPT_ROUTER_HASH = 'e02a4e9739fe4772aac59afe24a99f45348090434c90d7acb560d28c14bd4e2a';

async function buildApp() {
  jest.resetModules();
  const { createApp } = await import('../src/app.js');
  const { resetSafetyRuntimeStateForTests } = await import('../src/services/safety/runtimeState.js');
  const { resetRuntimeDiagnosticsState } = await import('../src/services/runtimeDiagnosticsService.js');
  resetSafetyRuntimeStateForTests();
  resetRuntimeDiagnosticsState();
  return createApp();
}

describe('runtime diagnostics routes', () => {
  jest.setTimeout(20_000);

  function restoreEnvVar(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
      return;
    }

    Reflect.set(process.env, name, value);
  }

  const originalNodeEnv = process.env.NODE_ENV;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalRailwayOpenAiApiKey = process.env.RAILWAY_OPENAI_API_KEY;
  const originalApiKey = process.env.API_KEY;
  const originalOpenAiKey = process.env.OPENAI_KEY;
  const originalDiagnosticsSharedMetrics = process.env.DIAGNOSTICS_SHARED_METRICS;
  const originalGptRouterHash = process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;
  const originalGptAccessToken = process.env.ARCANOS_GPT_ACCESS_TOKEN;
  const originalGptAccessScopes = process.env.ARCANOS_GPT_ACCESS_SCOPES;
  const originalGptAccessBaseUrl = process.env.ARCANOS_GPT_ACCESS_BASE_URL;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.OPENAI_API_KEY = '';
    process.env.RAILWAY_OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    process.env.OPENAI_KEY = '';
    process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
    process.env.ARCANOS_GPT_ACCESS_TOKEN = 'test-runtime-diagnostics-gpt-access-token';
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'runtime.read,workers.read,queue.read,jobs.result,mcp.approved_readonly,diagnostics.read';
    process.env.ARCANOS_GPT_ACCESS_BASE_URL = 'https://gateway.example.test';
  });

  afterEach(() => {
    restoreEnvVar('NODE_ENV', originalNodeEnv);
    restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvVar('RAILWAY_OPENAI_API_KEY', originalRailwayOpenAiApiKey);
    restoreEnvVar('API_KEY', originalApiKey);
    restoreEnvVar('OPENAI_KEY', originalOpenAiKey);
    restoreEnvVar('DIAGNOSTICS_SHARED_METRICS', originalDiagnosticsSharedMetrics);
    restoreEnvVar('SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG', originalGptRouterHash);
    restoreEnvVar('ARCANOS_GPT_ACCESS_TOKEN', originalGptAccessToken);
    restoreEnvVar('ARCANOS_GPT_ACCESS_SCOPES', originalGptAccessScopes);
    restoreEnvVar('ARCANOS_GPT_ACCESS_BASE_URL', originalGptAccessBaseUrl);
  });

  it('returns the live root response', async () => {
    const app = await buildApp();

    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toBe('ARCANOS is live');
  });

  it('mounts GPT Access metadata and protected diagnostics through the full app as JSON', async () => {
    const app = await buildApp();

    const openApiResponse = await request(app).get('/gpt-access/openapi.json');
    expect(openApiResponse.status).toBe(200);
    expect(openApiResponse.headers['content-type']).toContain('application/json');
    expect(openApiResponse.body.openapi).toBe('3.1.0');
    expect(openApiResponse.body.servers).toEqual([{ url: 'https://gateway.example.test' }]);
    expect(openApiResponse.body.paths['/gpt-access/status'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(JSON.stringify(openApiResponse.body)).not.toContain('test-runtime-diagnostics-gpt-access-token');

    const missingAuthResponse = await request(app).get('/gpt-access/status');
    expect(missingAuthResponse.status).toBe(401);
    expect(missingAuthResponse.headers['content-type']).toContain('application/json');
    expect(missingAuthResponse.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'UNAUTHORIZED_GPT_ACCESS',
        message: 'Missing GPT access bearer token.'
      }
    }));

    const invalidAuthResponse = await request(app)
      .get('/gpt-access/status')
      .set('Authorization', 'Bearer wrong-token');
    expect(invalidAuthResponse.status).toBe(401);
    expect(invalidAuthResponse.headers['content-type']).toContain('application/json');
    expect(invalidAuthResponse.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');

    const statusResponse = await request(app)
      .get('/gpt-access/status')
      .set('Authorization', 'Bearer test-runtime-diagnostics-gpt-access-token');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.headers['content-type']).toContain('application/json');
    expect(statusResponse.body).toEqual(expect.objectContaining({
      status: 'ok',
      service: 'arcanos-backend'
    }));
    const gptAccessPathKeys = Object.keys(openApiResponse.body.paths);
    expect(gptAccessPathKeys).toEqual(expect.arrayContaining([
      '/gpt-access/status',
      '/gpt-access/workers/status',
      '/gpt-access/jobs/result'
    ]));
    expect(gptAccessPathKeys.some((routePath) => routePath.includes('/gpt/{gptId}'))).toBe(false);

    const rendered = JSON.stringify([
      openApiResponse.body,
      missingAuthResponse.body,
      invalidAuthResponse.body,
      statusResponse.body
    ]);
    expect(rendered).not.toContain('ClientResponseError');
    expect(rendered).not.toContain('<html');
  });

  it('keeps local diagnostics on direct endpoints and blocks the GPT diagnostics action', async () => {
    const app = await buildApp();

    const directBeforeResponse = await request(app).get('/diagnostics');
    expect(directBeforeResponse.status).toBe(200);
    expect(directBeforeResponse.headers['x-response-bytes']).toBeTruthy();
    expect(directBeforeResponse.headers['x-response-truncated']).toBeUndefined();

    const gptDiagnosticsResponse = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        action: 'diagnostics'
      });

    expect(gptDiagnosticsResponse.status).toBe(400);
    expect(gptDiagnosticsResponse.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      action: 'diagnostics',
      route: '/gpt/:gptId',
      error: expect.objectContaining({
        code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        message: expect.stringContaining('/gpt-access/*')
      }),
      canonical: expect.objectContaining({
        status: '/gpt-access/status',
        workers: '/gpt-access/workers/status',
        workerHealth: '/gpt-access/worker-helper/health',
        queueInspect: '/gpt-access/queue/inspect',
        jobStatus: '/gpt-access/jobs/result',
        jobResult: '/gpt-access/jobs/result',
        gptAccessJobResult: '/gpt-access/jobs/result',
        mcp: '/gpt-access/mcp',
        selfHeal: '/gpt-access/self-heal/status'
      }),
      traceId: expect.any(String)
    }));
    expect(gptDiagnosticsResponse.body).not.toHaveProperty('result');

    const directAfterResponse = await request(app).get('/diagnostics');
    expect(directAfterResponse.status).toBe(200);
    expect(directAfterResponse.headers['x-response-bytes']).toBeTruthy();
    expect(directAfterResponse.headers['x-response-truncated']).toBeUndefined();
    expect(directAfterResponse.body.requests_total).toBeGreaterThan(
      directBeforeResponse.body.requests_total
    );
  });

  it('blocks diagnostics action from non-json request bodies', async () => {
    const app = await buildApp();

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('{"action":"diagnostics"}');

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      action: 'diagnostics',
      route: '/gpt/:gptId',
      error: expect.objectContaining({
        code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        message: expect.stringContaining('/gpt-access/*')
      }),
      traceId: expect.any(String)
    }));
    expect(response.body).not.toHaveProperty('result');
  });

  it('counts degraded timeout fallbacks as public diagnostic failures', async () => {
    const app = await buildApp();
    const { runtimeDiagnosticsService } = await import('../src/services/runtimeDiagnosticsService.js');

    runtimeDiagnosticsService.recordRequestCompletion(
      200,
      125,
      'POST /gpt/:gptId',
      {
        timeoutKind: 'pipeline_timeout',
        degradedModeReason: 'arcanos_core_static_timeout_fallback',
        bypassedSubsystems: ['trinity_intake', 'trinity_reasoning']
      }
    );

    const response = await request(app).get('/diagnostics');

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body.errors_total).toBeGreaterThanOrEqual(1);
    expect(response.body.error_rate).not.toBe(0);
    expect(response.body.top_error_routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: 'POST /gpt/:gptId',
          errorCount: expect.any(Number),
          timeoutCount: expect.any(Number)
        })
      ])
    );
  });

  it('returns the canonical public health contract from /health with legacy diagnostics fields preserved', async () => {
    const app = await buildApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ok',
      service: 'arcanos-backend',
      version: '1.0.0',
      gpt_routes: expect.any(Number),
      required_gpts: {
        required: expect.arrayContaining(['arcanos-core', 'core']),
        missing: []
      },
      openai_configured: false,
      uptime: expect.any(Number),
      memory: expect.objectContaining({
        rss_mb: expect.any(Number),
        heap_total_mb: expect.any(Number),
        heap_used_mb: expect.any(Number),
        external_mb: expect.any(Number),
        array_buffers_mb: expect.any(Number)
      }),
      response_bytes: expect.any(Number),
    }));
  });

  it('reports required GPT registration status from /healthz', async () => {
    const app = await buildApp();

    const response = await request(app).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ok',
      gpt_routes: expect.any(Number),
      required_gpts: {
        required: expect.arrayContaining(['arcanos-core', 'core']),
        missing: []
      }
    }));
  });
});
