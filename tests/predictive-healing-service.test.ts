import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: jest.fn(),
  recycleWorker: jest.fn(),
  scaleWorkersUp: jest.fn()
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: jest.fn(() => ({
    predictiveHealingEnabled: true,
    predictiveHealingDryRun: true,
    autoExecuteHealing: false
  }))
}));

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  activatePromptRouteDegradedMode: jest.fn(),
  activatePromptRouteReducedLatencyMode: jest.fn(),
  getPromptRouteMitigationState: jest.fn(() => ({
    active: false,
    mode: null,
    reason: null
  }))
}));

jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    getRollingRequestWindow: jest.fn()
  }
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: jest.fn(),
  healWorkerRuntime: jest.fn()
}));

jest.unstable_mockModule('../src/services/selfImprove/selfHealTelemetry.js', () => ({
  recordSelfHealEvent: jest.fn()
}));

const { evaluatePredictiveHealingRules } = await import('../src/services/selfImprove/predictiveHealingService.js');

function createObservation(overrides: Record<string, unknown> = {}) {
  return {
    collectedAt: '2026-03-26T12:00:00.000Z',
    source: 'test',
    windowMs: 300000,
    requestCount: 20,
    errorRate: 0.02,
    timeoutRate: 0.01,
    avgLatencyMs: 1000,
    p95LatencyMs: 1500,
    maxLatencyMs: 2400,
    degradedCount: 0,
    memory: {
      rssMb: 400,
      heapUsedMb: 180,
      heapTotalMb: 220,
      externalMb: 12,
      arrayBuffersMb: 4
    },
    workerHealth: {
      overallStatus: 'healthy',
      alertCount: 0,
      alerts: [],
      pending: 0,
      running: 1,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0,
      degradedWorkerIds: [],
      unhealthyWorkerIds: [],
      workers: []
    },
    workerRuntime: {
      enabled: true,
      started: true,
      configuredCount: 4,
      activeListeners: 4,
      maxActiveWorkers: 6,
      surgeWorkerCount: 0,
      workerIds: ['arcanos-worker-1', 'arcanos-worker-2']
    },
    promptRoute: {
      active: false,
      mode: null,
      reason: null
    },
    ...overrides
  };
}

describe('predictive healing rule evaluation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-26T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('recommends scale-up when latency rises across consecutive intervals', () => {
    const history = [
      createObservation({ collectedAt: '2026-03-26T11:57:00.000Z', avgLatencyMs: 900, p95LatencyMs: 1400 }),
      createObservation({ collectedAt: '2026-03-26T11:58:00.000Z', avgLatencyMs: 1300, p95LatencyMs: 1800 }),
      createObservation({ collectedAt: '2026-03-26T11:59:00.000Z', avgLatencyMs: 1700, p95LatencyMs: 2200 }),
      createObservation({ collectedAt: '2026-03-26T12:00:00.000Z', avgLatencyMs: 2100, p95LatencyMs: 2600 })
    ];

    const result = evaluatePredictiveHealingRules({
      observation: history[history.length - 1],
      history,
      config: {
        minObservations: 3,
        staleAfterMs: 300000,
        minConfidence: 0.6,
        errorRateThreshold: 0.18,
        latencyConsecutiveIntervals: 3,
        latencyRiseDeltaMs: 250,
        memoryThresholdMb: 900,
        memoryGrowthThresholdMb: 120,
        memorySustainedIntervals: 3,
        queuePendingThreshold: 5,
        queueVelocityThreshold: 2
      }
    });

    expect(result.trends.latencyRiseIntervals).toBeGreaterThanOrEqual(3);
    expect(result.decision.action).toBe('scale_workers_up');
    expect(result.decision.matchedRule).toBe('latency_rising_scale_up');
    expect(result.decision.safeToExecute).toBe(true);
  });

  it('refuses execution when data is stale', () => {
    const history = [
      createObservation({ collectedAt: '2026-03-26T11:40:00.000Z', errorRate: 0.3 })
    ];

    const result = evaluatePredictiveHealingRules({
      observation: history[0],
      history,
      config: {
        minObservations: 2,
        staleAfterMs: 60_000,
        minConfidence: 0.6,
        errorRateThreshold: 0.18,
        latencyConsecutiveIntervals: 3,
        latencyRiseDeltaMs: 250,
        memoryThresholdMb: 900,
        memoryGrowthThresholdMb: 120,
        memorySustainedIntervals: 3,
        queuePendingThreshold: 5,
        queueVelocityThreshold: 2
      }
    });

    expect(result.decision.action).toBe('none');
    expect(result.decision.staleData).toBe(true);
    expect(result.decision.reason).toContain('stale');
  });
});
