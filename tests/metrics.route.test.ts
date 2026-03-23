import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const request = (await import('supertest')).default;
const CURRENT_GPT_ROUTER_HASH = 'e02a4e9739fe4772aac59afe24a99f45348090434c90d7acb560d28c14bd4e2a';

async function buildApp() {
  jest.resetModules();
  const { resetAppMetricsForTests } = await import('../src/platform/observability/appMetrics.js');
  const { resetRuntimeDiagnosticsState } = await import('../src/services/runtimeDiagnosticsService.js');
  resetAppMetricsForTests();
  resetRuntimeDiagnosticsState();
  const { createApp } = await import('../src/app.js');
  return createApp();
}

describe('/metrics route', () => {
  const originalMetricsEnabled = process.env.METRICS_ENABLED;
  const originalMetricsAuthToken = process.env.METRICS_AUTH_TOKEN;
  const originalMetricsIncludeWorkerState = process.env.METRICS_INCLUDE_WORKER_STATE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDiagnosticsSharedMetrics = process.env.DIAGNOSTICS_SHARED_METRICS;
  const originalGptRouterHash = process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;

  beforeEach(() => {
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_INCLUDE_WORKER_STATE = 'false';
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
  });

  afterEach(() => {
    if (originalMetricsEnabled === undefined) {
      delete process.env.METRICS_ENABLED;
    } else {
      process.env.METRICS_ENABLED = originalMetricsEnabled;
    }

    if (originalMetricsAuthToken === undefined) {
      delete process.env.METRICS_AUTH_TOKEN;
    } else {
      process.env.METRICS_AUTH_TOKEN = originalMetricsAuthToken;
    }

    if (originalMetricsIncludeWorkerState === undefined) {
      delete process.env.METRICS_INCLUDE_WORKER_STATE;
    } else {
      process.env.METRICS_INCLUDE_WORKER_STATE = originalMetricsIncludeWorkerState;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalDiagnosticsSharedMetrics === undefined) {
      delete process.env.DIAGNOSTICS_SHARED_METRICS;
    } else {
      process.env.DIAGNOSTICS_SHARED_METRICS = originalDiagnosticsSharedMetrics;
    }

    if (originalGptRouterHash === undefined) {
      delete process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;
    } else {
      process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = originalGptRouterHash;
    }
  });

  it('exports prometheus metrics and excludes /metrics self-scrapes from HTTP counters', async () => {
    const app = await buildApp();

    const healthResponse = await request(app).get('/healthz');
    expect(healthResponse.status).toBe(200);

    const metricsResponse = await request(app).get('/metrics');

    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers['content-type']).toContain('text/plain');
    expect(metricsResponse.text).toContain('# HELP http_requests_total');
    expect(metricsResponse.text).toMatch(/http_requests_total\{[^}]*route="\/healthz"[^}]*method="GET"[^}]*status_code="200"[^}]*\} 1/);
    expect(metricsResponse.text).not.toContain('route="/metrics"');
    expect(metricsResponse.text).toContain('process_heap_used_bytes');
    expect(metricsResponse.text).toContain('worker_queue_depth');
    expect(metricsResponse.text).toContain('worker_queue_latency_ms');
  });

  it('requires a metrics token when METRICS_AUTH_TOKEN is configured', async () => {
    process.env.METRICS_AUTH_TOKEN = 'secret-token';
    const app = await buildApp();

    const forbiddenResponse = await request(app).get('/metrics');
    expect(forbiddenResponse.status).toBe(403);

    const allowedResponse = await request(app)
      .get('/metrics')
      .set('x-metrics-token', 'secret-token');
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.text).toContain('# HELP http_requests_total');
  });
});
