import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getWorkerControlHealthMock = jest.fn(async () => ({
  queueSummary: {
    pending: 2,
    running: 1,
    delayed: 0,
    failed: 0,
    completed: 4,
    stalledRunning: 0,
    oldestPendingJobAgeMs: 250
  },
  operationalHealth: {
    overallStatus: 'healthy',
    recentFailed: 0,
    workerHeartbeatAgeMs: 500,
    staleWorkers: 0
  },
  historicalDebt: {
    retryExhaustedJobs: 0,
    deadLetterJobs: 0
  },
  alerts: [],
  diagnosticAlerts: [],
  workers: []
}));
const getOpenAIServiceHealthMock = jest.fn(() => ({
  circuitBreaker: {
    state: 'open',
    failureCount: 2
  }
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlHealth: getWorkerControlHealthMock
}));
jest.unstable_mockModule('../src/services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: getOpenAIServiceHealthMock
}));

const metricsModule =
  await import('../src/platform/observability/appMetrics.js');
const {
  configureDefaultAppMetricsRuntimeProviders
} = await import('../src/services/appMetricsRuntimeProviders.js');

describe('app metrics runtime provider composition', () => {
  const originalIncludeWorkerState =
    process.env.METRICS_INCLUDE_WORKER_STATE;

  beforeEach(() => {
    process.env.METRICS_INCLUDE_WORKER_STATE = 'true';
    metricsModule.resetAppMetricsForTests();
    configureDefaultAppMetricsRuntimeProviders();
    getWorkerControlHealthMock.mockClear();
    getOpenAIServiceHealthMock.mockClear();
  });

  afterEach(() => {
    if (originalIncludeWorkerState === undefined) {
      delete process.env.METRICS_INCLUDE_WORKER_STATE;
      return;
    }
    process.env.METRICS_INCLUDE_WORKER_STATE =
      originalIncludeWorkerState;
  });

  it('binds worker and provider readers without coupling the registry to services', async () => {
    const metricsText = await metricsModule.getMetricsText();

    expect(getWorkerControlHealthMock).toHaveBeenCalledTimes(1);
    expect(getOpenAIServiceHealthMock).toHaveBeenCalledTimes(1);
    expect(metricsText).toMatch(
      /worker_queue_depth\{[^}]*state="pending"[^}]*\} 2/
    );
    expect(metricsText).toMatch(
      /ai_circuit_breaker_state\{[^}]*state="open"[^}]*\} 1/
    );
    expect(metricsText).toMatch(/ai_circuit_breaker_failures\{[^}]*\} 2/);
  });
});
