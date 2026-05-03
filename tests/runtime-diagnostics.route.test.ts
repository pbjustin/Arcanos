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

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.OPENAI_API_KEY = '';
    process.env.RAILWAY_OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    process.env.OPENAI_KEY = '';
    process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
  });

  afterEach(() => {
    restoreEnvVar('NODE_ENV', originalNodeEnv);
    restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvVar('RAILWAY_OPENAI_API_KEY', originalRailwayOpenAiApiKey);
    restoreEnvVar('API_KEY', originalApiKey);
    restoreEnvVar('OPENAI_KEY', originalOpenAiKey);
    restoreEnvVar('DIAGNOSTICS_SHARED_METRICS', originalDiagnosticsSharedMetrics);
    restoreEnvVar('SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG', originalGptRouterHash);
  });

  it('returns the live root response', async () => {
    const app = await buildApp();

    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toBe('ARCANOS is live');
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
