import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@services/safety/runtimeState.js', () => ({
  activateUnsafeCondition: jest.fn(() => ({})),
  buildUnsafeToProceedPayload: jest.fn(() => ({})),
  clearUnsafeCondition: jest.fn(() => false),
  clearUnsafeConditionsByQuarantine: jest.fn(() => 0),
  getActiveQuarantines: jest.fn(() => []),
  getActiveUnsafeConditions: jest.fn(() => []),
  getSafetyRuntimeSnapshot: jest.fn(() => ({
    conditions: [],
    counters: {
      duplicateSuppressions: 0,
      healthyCycles: {},
      heartbeatMisses: {},
      quarantineActivations: 0,
      workerFailures: {},
    },
    quarantines: [],
    trustedHashes: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  getTrustedHash: jest.fn(() => undefined),
  hasUnsafeBlockingConditions: jest.fn(() => false),
  incrementHeartbeatMiss: jest.fn(() => 0),
  incrementHealthyCycle: jest.fn(() => 0),
  incrementWorkerFailure: jest.fn(() => 0),
  reconcileAutoRecoverableQuarantinesForProcessStart: jest.fn(() => 0),
  recordDuplicateSuppression: jest.fn(() => 0),
  registerQuarantine: jest.fn(() => ({})),
  releaseQuarantine: jest.fn(() => false),
  resetFailureSignals: jest.fn(),
  resetSafetyRuntimeStateForTests: jest.fn(),
  setTrustedHash: jest.fn(),
}));

const request = (await import('supertest')).default;
const CURRENT_GPT_ROUTER_HASH = '8bf52c870195f165b17397ca16e87361fa401553fa10f86ebdbcc857a4fbba58';

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
  jest.setTimeout(20_000);

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
    jest.restoreAllMocks();
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
    expect(metricsResponse.text).toContain('worker_alert_recommendations');
  });

  it('preserves metrics credential extraction without disclosing rejected values', async () => {
    const credential = ['phase2a', 'metrics', 'sécurité'].join('-');
    const wrongSameLength = `${credential.slice(0, -1)}x`;
    const wrongDifferentLength = `${credential}x`;
    process.env.METRICS_AUTH_TOKEN = `  ${credential}  `;
    const app = await buildApp();

    const missing = await request(app).get('/metrics');
    const wrongLength = await request(app)
      .get('/metrics')
      .set('x-metrics-token', wrongDifferentLength);
    const wrongSame = await request(app)
      .get('/metrics')
      .set('authorization', wrongSameLength);
    const customHeader = await request(app)
      .get('/metrics')
      .set('x-metrics-token', `  ${credential}  `);
    const bearerHeader = await request(app)
      .get('/metrics')
      .set('authorization', `bearer   ${credential}  `);
    const bareAuthorization = await request(app)
      .get('/metrics')
      .set('authorization', credential);

    expect([missing.status, wrongLength.status, wrongSame.status]).toEqual([403, 403, 403]);
    expect([customHeader.status, bearerHeader.status, bareAuthorization.status]).toEqual([200, 200, 200]);
    expect(customHeader.text).toContain('# HELP http_requests_total');

    const rejectedOutput = JSON.stringify([
      { body: missing.body, headers: missing.headers, text: missing.text },
      { body: wrongLength.body, headers: wrongLength.headers, text: wrongLength.text },
      { body: wrongSame.body, headers: wrongSame.headers, text: wrongSame.text },
    ]);
    expect(
      [credential, wrongSameLength, wrongDifferentLength]
        .some((value) => rejectedOutput.includes(value)),
    ).toBe(false);
  });
});
