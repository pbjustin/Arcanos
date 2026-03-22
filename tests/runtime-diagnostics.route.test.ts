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
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalRailwayOpenAiApiKey = process.env.RAILWAY_OPENAI_API_KEY;
  const originalApiKey = process.env.API_KEY;
  const originalOpenAiKey = process.env.OPENAI_KEY;
  const originalDiagnosticsSharedMetrics = process.env.DIAGNOSTICS_SHARED_METRICS;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.OPENAI_API_KEY = '';
    process.env.RAILWAY_OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    process.env.OPENAI_KEY = '';
    process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
  });

  afterEach(() => {
    restoreEnvVar('NODE_ENV', originalNodeEnv);
    restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvVar('RAILWAY_OPENAI_API_KEY', originalRailwayOpenAiApiKey);
    restoreEnvVar('API_KEY', originalApiKey);
    restoreEnvVar('OPENAI_KEY', originalOpenAiKey);
    restoreEnvVar('DIAGNOSTICS_SHARED_METRICS', originalDiagnosticsSharedMetrics);
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
      active_routes: expect.anything(),
      registered_gpts: expect.anything(),
      requests_total: expect.any(Number),
      errors_total: expect.any(Number),
      error_rate: expect.anything(),
      avg_latency_ms: expect.anything(),
      recent_latency_ms: expect.anything(),
      modules: expect.any(Object)
    }));
    expect(gptDiagnosticsResponse.body).not.toHaveProperty('ok');
    expect(gptDiagnosticsResponse.body).not.toHaveProperty('result');
    if (Array.isArray(gptDiagnosticsResponse.body.active_routes)) {
      expect(gptDiagnosticsResponse.body.active_routes).toEqual(expect.arrayContaining([
        'GET /diagnostics',
        'POST /gpt/:gptId'
      ]));
    } else {
      expect(gptDiagnosticsResponse.body.active_routes).toBe('DATA NOT EXPOSED: active_routes');
    }
    if (Array.isArray(gptDiagnosticsResponse.body.registered_gpts)) {
      expect(gptDiagnosticsResponse.body.registered_gpts).toEqual(expect.arrayContaining([
        'arcanos-core',
        'core'
      ]));
    } else {
      expect(gptDiagnosticsResponse.body.registered_gpts).toBe('DATA NOT EXPOSED: registered_gpts');
    }

    const directAfterResponse = await request(app).get('/diagnostics');
    expect(directAfterResponse.status).toBe(200);
    expect(gptDiagnosticsResponse.body.requests_total).toBeGreaterThan(
      directBeforeResponse.body.requests_total
    );
    expect(directAfterResponse.body.requests_total).toBeGreaterThan(
      gptDiagnosticsResponse.body.requests_total
    );
  });

  it('parses diagnostics action from non-json request bodies', async () => {
    const app = await buildApp();

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('{"action":"diagnostics"}');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      uptime: expect.any(Number),
      requests_total: expect.any(Number),
      errors_total: expect.any(Number),
      modules: expect.any(Object)
    }));
    expect(response.body).not.toHaveProperty('ok');
    expect(response.body).not.toHaveProperty('result');
  });
});
