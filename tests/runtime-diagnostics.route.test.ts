import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const request = (await import('supertest')).default;

async function buildApp() {
  jest.resetModules();
  const { createApp } = await import('../src/app.js');
  const { resetRuntimeDiagnosticsState } = await import('../src/services/runtimeDiagnosticsService.js');
  resetRuntimeDiagnosticsState();
  return createApp();
}

describe('runtime diagnostics routes', () => {
  function restoreEnvVar(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
      return;
    }

    Reflect.set(process.env, name, value);
  }

  const originalNodeEnv = process.env.NODE_ENV;
  const originalDiagnosticsBearerToken = process.env.DIAGNOSTICS_BEARER_TOKEN;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalRailwayOpenAiApiKey = process.env.RAILWAY_OPENAI_API_KEY;
  const originalApiKey = process.env.API_KEY;
  const originalOpenAiKey = process.env.OPENAI_KEY;
  const originalDiagnosticsSharedMetrics = process.env.DIAGNOSTICS_SHARED_METRICS;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.DIAGNOSTICS_BEARER_TOKEN;
    process.env.OPENAI_API_KEY = '';
    process.env.RAILWAY_OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    process.env.OPENAI_KEY = '';
    process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
  });

  afterEach(() => {
    restoreEnvVar('NODE_ENV', originalNodeEnv);
    restoreEnvVar('DIAGNOSTICS_BEARER_TOKEN', originalDiagnosticsBearerToken);
    restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvVar('RAILWAY_OPENAI_API_KEY', originalRailwayOpenAiApiKey);
    restoreEnvVar('API_KEY', originalApiKey);
    restoreEnvVar('OPENAI_KEY', originalOpenAiKey);
    restoreEnvVar('DIAGNOSTICS_SHARED_METRICS', originalDiagnosticsSharedMetrics);
  });

  it('returns measurable health and diagnostics data from live app state', async () => {
    const app = await buildApp();

    const healthResponse = await request(app).get('/health');
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      uptime: expect.any(Number),
      memory: expect.objectContaining({
        rss_mb: expect.any(Number),
        heap_total_mb: expect.any(Number),
        heap_used_mb: expect.any(Number),
        external_mb: expect.any(Number),
        array_buffers_mb: expect.any(Number)
      })
    });

    const gptResponse = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Return exactly the string TEST_OK',
        action: 'query'
      });

    expect(gptResponse.status).toBe(200);
    expect(gptResponse.body.ok).toBe(true);
    expect(gptResponse.body._route).toEqual(expect.objectContaining({
      gptId: 'arcanos-core',
      module: 'ARCANOS:CORE',
      route: 'core'
    }));

    const missingRouteResponse = await request(app).get('/diagnostics-missing-route');
    expect(missingRouteResponse.status).toBe(404);

    const diagnosticsResponse = await request(app).get('/diagnostics');
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsResponse.body).toEqual(expect.objectContaining({
      uptime: expect.any(Number),
      memory: expect.objectContaining({
        rss_mb: expect.any(Number),
        heap_total_mb: expect.any(Number),
        heap_used_mb: expect.any(Number),
        external_mb: expect.any(Number),
        array_buffers_mb: expect.any(Number)
      }),
      requests_total: 3,
      errors_total: 1,
      error_rate: expect.any(Number),
      avg_latency_ms: expect.any(Number),
      recent_latency_ms: expect.any(Array),
      modules: expect.objectContaining({
        CORE: 'active',
        SIM: 'active',
        BOOKING: 'active'
      })
    }));
    expect(diagnosticsResponse.body.active_routes).toEqual(expect.arrayContaining([
      'GET /health',
      'GET /diagnostics',
      'POST /gpt/:gptId'
    ]));
    expect(diagnosticsResponse.body.registered_gpts).toEqual(expect.arrayContaining([
      'arcanos-core',
      'core',
      'backstage-booker',
      'hrc'
    ]));
    expect(diagnosticsResponse.body.recent_latency_ms).toHaveLength(3);
  }, 15000);

  it('allows unprotected diagnostics when no token is configured', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DIAGNOSTICS_BEARER_TOKEN;
    const app = await buildApp();

    const response = await request(app).get('/diagnostics');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      requests_total: 0,
      errors_total: 0,
      modules: expect.any(Object)
    }));
  });

  it('returns real diagnostics JSON through the GPT diagnostics action', async () => {
    const app = await buildApp();

    const directBeforeResponse = await request(app).get('/diagnostics');
    expect(directBeforeResponse.status).toBe(200);

    const gptDiagnosticsResponse = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        action: 'diagnostics'
      });

    expect(gptDiagnosticsResponse.status).toBe(200);
    expect(gptDiagnosticsResponse.body).toEqual(expect.objectContaining({
      uptime: expect.any(Number),
      memory: expect.objectContaining({
        rss_mb: expect.any(Number),
        heap_total_mb: expect.any(Number),
        heap_used_mb: expect.any(Number),
        external_mb: expect.any(Number),
        array_buffers_mb: expect.any(Number)
      }),
      active_routes: expect.any(Array),
      registered_gpts: expect.any(Array),
      requests_total: expect.any(Number),
      errors_total: expect.any(Number),
      error_rate: expect.any(Number),
      avg_latency_ms: expect.any(Number),
      recent_latency_ms: expect.any(Array),
      modules: expect.objectContaining({
        CORE: 'active'
      })
    }));
    expect(gptDiagnosticsResponse.body).not.toHaveProperty('ok');
    expect(gptDiagnosticsResponse.body).not.toHaveProperty('result');
    expect(gptDiagnosticsResponse.body.active_routes).toEqual(expect.arrayContaining([
      'GET /diagnostics',
      'POST /gpt/:gptId'
    ]));
    expect(gptDiagnosticsResponse.body.registered_gpts).toEqual(expect.arrayContaining([
      'arcanos-core',
      'core'
    ]));

    const directAfterResponse = await request(app).get('/diagnostics');
    expect(directAfterResponse.status).toBe(200);
    expect(gptDiagnosticsResponse.body.requests_total).toBeGreaterThan(
      directBeforeResponse.body.requests_total
    );
    expect(directAfterResponse.body.requests_total).toBeGreaterThan(
      gptDiagnosticsResponse.body.requests_total
    );
    expect(Array.isArray(gptDiagnosticsResponse.body.recent_latency_ms)).toBe(true);
    expect(Array.isArray(directAfterResponse.body.recent_latency_ms)).toBe(true);
    expect(gptDiagnosticsResponse.body.modules).toEqual(
      expect.objectContaining(directBeforeResponse.body.modules)
    );
  });

  it('enforces optional diagnostics bearer protection when configured', async () => {
    process.env.DIAGNOSTICS_BEARER_TOKEN = 'diagnostics-secret';
    const app = await buildApp();

    const forbiddenResponse = await request(app).get('/diagnostics');
    expect(forbiddenResponse.status).toBe(404);
    expect(forbiddenResponse.body).toEqual({
      error: 'Not Found'
    });

    const forbiddenGptDiagnosticsResponse = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        action: 'diagnostics'
      });
    expect(forbiddenGptDiagnosticsResponse.status).toBe(404);
    expect(forbiddenGptDiagnosticsResponse.body).toEqual({
      error: 'Not Found'
    });

    const allowedResponse = await request(app)
      .get('/diagnostics')
      .set('authorization', 'Bearer diagnostics-secret');

    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.body.requests_total).toBe(2);
    expect(allowedResponse.body.errors_total).toBe(2);

    const allowedGptDiagnosticsResponse = await request(app)
      .post('/gpt/arcanos-core')
      .set('authorization', 'Bearer diagnostics-secret')
      .send({
        action: 'diagnostics'
      });
    expect(allowedGptDiagnosticsResponse.status).toBe(200);
    expect(allowedGptDiagnosticsResponse.body).toEqual(expect.objectContaining({
      requests_total: 3,
      errors_total: 2
    }));
  });
});
