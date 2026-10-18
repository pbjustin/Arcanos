import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getOpenAIServiceHealthMock = jest.fn(() => ({
  apiKey: {
    configured: true,
    status: 'valid',
    source: 'OPENAI_API_KEY'
  },
  client: {
    initialized: true,
    model: 'gpt-4.1',
    timeout: 8000,
    baseURL: 'https://api.openai.com/v1'
  },
  circuitBreaker: {
    state: 'CLOSED',
    failureCount: 0,
    lastFailureTime: 0,
    successCount: 0,
    lastOpenedAt: 0,
    lastHalfOpenAt: 0,
    lastClosedAt: 0,
    healthy: true,
    constants: {
      CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000
    }
  },
  cache: {
    enabled: true
  },
  lastHealthCheck: '2026-03-26T12:00:00.000Z',
  defaults: {
    maxTokens: 1024
  },
  providerRuntime: {
    configSource: 'OPENAI_API_KEY',
    configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
    lastReloadAt: '2026-03-26T11:59:00.000Z',
    reloadCount: 1,
    lastAttemptAt: '2026-03-26T12:00:00.000Z',
    lastSuccessAt: '2026-03-26T12:00:00.000Z',
    lastFailureAt: null,
    lastFailureReason: null,
    lastFailureCategory: null,
    lastFailureStatus: null,
    consecutiveFailures: 0,
    backoffMs: 0,
    nextRetryAt: null
  }
}));
const reinitializeOpenAIProviderMock = jest.fn();
const getStableWorkerRuntimeModeMock = jest.fn(() => ({
  requestedRunWorkers: false,
  resolvedRunWorkers: false,
  processKind: 'unknown',
  railwayServiceName: null,
  reason: 'requested'
}));
const isWorkerRuntimeSuppressedForServiceRoleMock = jest.fn((workerRuntimeMode) => (
  !workerRuntimeMode.resolvedRunWorkers
  && workerRuntimeMode.processKind === 'web'
));

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
  })),
  getEnvVar: jest.fn(),
  getStableWorkerRuntimeMode: getStableWorkerRuntimeModeMock,
  isWorkerRuntimeSuppressedForServiceRole: isWorkerRuntimeSuppressedForServiceRoleMock
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

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({
    client: null
  }))
}));

jest.unstable_mockModule('@services/arcanos-core.js', () => ({
  runArcanosCoreQuery: jest.fn()
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  createSingleChatCompletion: jest.fn()
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: getOpenAIServiceHealthMock,
  reinitializeOpenAIProvider: reinitializeOpenAIProviderMock
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: jest.fn(),
  healWorkerRuntime: jest.fn()
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  activateTrinitySelfHealingMitigation: jest.fn(),
  getTrinitySelfHealingMitigation: jest.fn(() => ({
    forceDirectAnswer: false,
    bypassFinalStage: false,
    activeAction: null,
    stage: null
  })),
  getTrinitySelfHealingStatus: jest.fn(() => ({
    enabled: true,
    config: {
      triggerThreshold: 3,
      maxAttempts: 3
    },
    snapshot: {
      intake: {
        observations: [],
        attempts: 0,
        activeAction: null,
        activeSinceMs: null,
        expiresAtMs: null,
        verificationSuccesses: 0,
        verificationFailures: 0,
        verifiedAtMs: null,
        cooldownUntilMs: null,
        failedActions: []
      },
      reasoning: {
        observations: [],
        attempts: 0,
        activeAction: null,
        activeSinceMs: null,
        expiresAtMs: null,
        verificationSuccesses: 0,
        verificationFailures: 0,
        verifiedAtMs: null,
        cooldownUntilMs: null,
        failedActions: []
      },
      final: {
        observations: [],
        attempts: 0,
        activeAction: null,
        activeSinceMs: null,
        expiresAtMs: null,
        verificationSuccesses: 0,
        verificationFailures: 0,
        verifiedAtMs: null,
        cooldownUntilMs: null,
        failedActions: []
      }
    }
  })),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn()
}));

jest.unstable_mockModule('../src/services/selfImprove/selfHealTelemetry.js', () => ({
  recordSelfHealEvent: jest.fn()
}));

const {
  evaluatePredictiveHealingRules,
  runPredictiveHealingFromLoop,
  resetPredictiveHealingStateForTests
} = await import('../src/services/selfImprove/predictiveHealingService.js');
const { getTrinitySelfHealingStatus } = await import('../src/services/selfImprove/selfHealingV2.js');
const { runArcanosCoreQuery } = await import('../src/services/arcanos-core.js');

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
    inactivity: {
      inactiveDegraded: false,
      reason: null,
      idleThresholdMs: 120000,
      maxInactivityMs: 0,
      lastActivityAt: null,
      lastProcessedJobAt: null,
      workerIds: []
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
    trinity: {
      enabled: true,
      activeStage: null,
      activeAction: null,
      verified: false,
      config: {
        triggerThreshold: 3,
        maxAttempts: 3
      },
      stages: {
        intake: {
          observationsInWindow: 0,
          attempts: 0,
          activeAction: null,
          verified: false,
          cooldownUntil: null,
          failedActions: []
        },
        reasoning: {
          observationsInWindow: 0,
          attempts: 0,
          activeAction: null,
          verified: false,
          cooldownUntil: null,
          failedActions: []
        },
        final: {
          observationsInWindow: 0,
          attempts: 0,
          activeAction: null,
          verified: false,
          cooldownUntil: null,
          failedActions: []
        }
      }
    },
    ...overrides
  };
}

describe('predictive healing rule evaluation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-26T12:00:00.000Z'));
    jest.clearAllMocks();
    resetPredictiveHealingStateForTests();
    reinitializeOpenAIProviderMock.mockResolvedValue({
      ok: true,
      skipped: false,
      reason: null,
      reloaded: true,
      runtime: {
        configSource: 'OPENAI_API_KEY',
        configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
        lastReloadAt: '2026-03-26T12:00:00.000Z',
        reloadCount: 2,
        lastAttemptAt: '2026-03-26T12:00:00.000Z',
        lastSuccessAt: '2026-03-26T12:00:00.000Z',
        lastFailureAt: null,
        lastFailureReason: null,
        lastFailureCategory: null,
        lastFailureStatus: null,
        consecutiveFailures: 0,
        backoffMs: 0,
        nextRetryAt: null
      }
    });
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

  it('recommends Trinity final-stage mitigation before the reactive threshold is exceeded', () => {
    const observation = createObservation({
      requestCount: 12,
      trinity: {
        ...createObservation().trinity,
        stages: {
          ...createObservation().trinity.stages,
          final: {
            observationsInWindow: 2,
            attempts: 0,
            activeAction: null,
            verified: false,
            cooldownUntil: null,
            failedActions: []
          }
        }
      }
    });

    const history = [
      createObservation({ collectedAt: '2026-03-26T11:58:00.000Z' }),
      createObservation({ collectedAt: '2026-03-26T11:59:00.000Z' }),
      observation
    ];

    const result = evaluatePredictiveHealingRules({
      observation,
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

    expect(result.decision.action).toBe('activate_trinity_mitigation');
    expect(result.decision.target).toBe('trinity:final');
    expect(result.decision.matchedRule).toBe('trinity_final_stage_preheal');
    expect(result.decision.details).toEqual(expect.objectContaining({
      stage: 'final',
      trinityAction: 'bypass_final_stage'
    }));
  });

  it('does not repair inactivity alone when no pending or stalled work exists', () => {
    const observation = createObservation({
      requestCount: 0,
      workerHealth: {
        ...createObservation().workerHealth,
        overallStatus: 'degraded',
        alertCount: 1,
        alerts: ['No worker receipts or processed jobs observed for 240000ms after startup.'],
        workers: [
          {
            workerId: 'async-queue',
            healthStatus: 'degraded',
            currentJobId: null,
            lastActivityAt: '2026-03-26T11:56:00.000Z',
            lastProcessedJobAt: null,
            inactivityMs: 240000,
            watchdog: {
              triggered: false,
              reason: 'No worker receipts or processed jobs observed for 240000ms after startup.',
              restartRecommended: true,
              idleThresholdMs: 120000
            }
          }
        ]
      },
      inactivity: {
        inactiveDegraded: true,
        reason: 'No worker receipts or processed jobs observed for 240000ms after startup.',
        idleThresholdMs: 120000,
        maxInactivityMs: 240000,
        lastActivityAt: '2026-03-26T11:56:00.000Z',
        lastProcessedJobAt: null,
        workerIds: ['async-queue']
      }
    });
    const history = [
      createObservation({ collectedAt: '2026-03-26T11:58:00.000Z', requestCount: 0 }),
      createObservation({ collectedAt: '2026-03-26T11:59:00.000Z', requestCount: 0 }),
      observation
    ];

    const result = evaluatePredictiveHealingRules({
      observation,
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

    expect(result.decision.action).toBe('none');
    expect(result.decision.safeToExecute).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it.each([0, 1000, 30000, 119999, 120000])('requires aged pending work for a supplied inactivity diagnosis (pending age: %s)', oldestPendingJobAgeMs => {
    const observation = createObservation({
      requestCount: 0,
      workerHealth: {
        ...createObservation().workerHealth,
        pending: 1,
        oldestPendingJobAgeMs,
        workers: [{ workerId: 'idle-slot', healthStatus: 'healthy', currentJobId: null }]
      },
      inactivity: {
        ...createObservation().inactivity,
        inactiveDegraded: true,
        reason: 'No activity while queue work remained pending.',
        maxInactivityMs: 240000,
        workerIds: ['idle-slot']
      }
    });

    const result = evaluatePredictiveHealingRules({ observation, history: [observation] });

    if (oldestPendingJobAgeMs >= 120000) {
      expect(result.decision).toMatchObject({
        action: 'heal_worker_runtime', matchedRule: 'inactive_worker_runtime_heal', safeToExecute: true
      });
    } else {
      expect(result.decision.action).toBe('none');
      expect(result.candidates).toEqual([]);
    }
  });

  it.each([0, 1000, 30000, 119999, 120000])('classifies actual pending age before inference for eight healthy idle workers (age: %s)', async oldestPendingJobAgeMs => {
    const observation = createObservation({ requestCount: 0 });
    const result = await runPredictiveHealingFromLoop({
      source: 'fresh-pending-idle-poll',
      observation: { requestWindow: observation as never, workerRuntime: observation.workerRuntime,
        trinityStatus: getTrinitySelfHealingStatus(),
        workerHealth: { overallStatus: 'healthy', alerts: [], settings: { watchdogIdleMs: 120000 },
          queueSummary: { pending: 1, running: 0, stalledRunning: 0, oldestPendingJobAgeMs },
          workers: Array.from({ length: 8 }, (_, index) => ({ workerId: `current-slot-${index + 1}`,
            healthStatus: 'healthy', operationalStatus: 'healthy', stale: false, currentJobId: null,
            claimAcceptance: 'accepting', lastHeartbeatAt: '2026-03-26T12:00:00.000Z',
            lastActivityAt: '2026-03-26T11:00:00.000Z', inactivityMs: 3600000,
            watchdog: { triggered: false, restartRecommended: false, idleThresholdMs: 120000 } }))
        } as never }
    });
    const agedBacklog = oldestPendingJobAgeMs >= 120000;
    expect(result.observation.inactivity?.inactiveDegraded).toBe(agedBacklog);
    if (agedBacklog) {
      expect(result.decision).toMatchObject({ action: 'heal_worker_runtime', matchedRule: 'inactive_worker_runtime_heal' });
    } else {
      expect(result.decision.action).toBe('none');
      expect(result.decision.details.aiEligibilityReason).toBe('no_actionable_incident');
    }
    expect(result.execution.attempted).toBe(false);
    expect(runArcanosCoreQuery).not.toHaveBeenCalled();
  });

  it('keeps one legitimate running job and seven healthy idle slots free of inactivity repair candidates', () => {
    const observation = createObservation({ requestCount: 0 });
    observation.workerHealth = {
      ...observation.workerHealth, pending: 0, running: 1, stalledRunning: 0,
      workers: Array.from({ length: 8 }, (_, index) => ({
        workerId: `slot-${index + 1}`, healthStatus: 'healthy',
        currentJobId: index === 0 ? 'legitimate-long-job' : null,
        stale: false, claimAcceptance: 'accepting', inactivityMs: 3_600_000,
        watchdog: { triggered: false, restartRecommended: false, idleThresholdMs: 120000 }
      }))
    };
    observation.inactivity = { ...observation.inactivity, inactiveDegraded: true,
      maxInactivityMs: 3_600_000, workerIds: Array.from({ length: 7 }, (_, index) => `slot-${index + 2}`) };

    const result = evaluatePredictiveHealingRules({ observation, history: [observation] });

    expect(result.decision.action).toBe('none');
    expect(result.decision.safeToExecute).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('does not infer an unavailable fleet from one stale row while a healthy worker can claim pending work', () => {
    const observation = createObservation({ requestCount: 0 });
    observation.workerHealth = { ...observation.workerHealth, pending: 1, running: 0,
      workers: [
        { workerId: 'stale-slot', healthStatus: 'healthy', stale: true, currentJobId: null },
        { workerId: 'current-slot', healthStatus: 'healthy', stale: false, currentJobId: null }
      ] };
    const result = evaluatePredictiveHealingRules({ observation, history: [observation] });
    expect(result.candidates).toEqual([]);
    expect(result.decision.action).toBe('none');
  });

  it.each([0, 1])('does not promote retained stale failures into live predictive inactivity, repairs or inference (pending: %s)', async pending => {
    const observation = createObservation({ requestCount: 0 });
    const result = await runPredictiveHealingFromLoop({
      source: 'mixed-retained-and-current-workers',
      observation: { requestWindow: observation as never, workerRuntime: observation.workerRuntime,
        trinityStatus: getTrinitySelfHealingStatus(),
        workerHealth: { overallStatus: 'healthy', alerts: [], settings: { watchdogIdleMs: 120000 },
          queueSummary: { pending, running: 0, stalledRunning: 0, oldestPendingJobAgeMs: 0 },
          workers: [
            { workerId: 'retained-dependency', healthStatus: 'unhealthy', operationalStatus: 'unhealthy',
              stale: true, currentJobId: null, claimAcceptance: 'dependency_failure', inactivityMs: 7200000,
              watchdog: { triggered: false, restartRecommended: true, idleThresholdMs: 120000 } },
            { workerId: 'retained-watchdog', healthStatus: 'unhealthy', operationalStatus: 'unhealthy',
              stale: true, currentJobId: null, inactivityMs: 7200000,
              watchdog: { triggered: true, restartRecommended: true, idleThresholdMs: 120000 } },
            ...Array.from({ length: 8 }, (_, index) => ({ workerId: `current-slot-${index + 1}`,
              healthStatus: 'healthy', operationalStatus: 'healthy', stale: false, currentJobId: null,
              claimAcceptance: 'accepting', lastActivityAt: '2026-03-26T12:00:00.000Z', inactivityMs: 0,
              watchdog: { triggered: false, restartRecommended: false, idleThresholdMs: 120000 } }))
          ] } as never }
    });
    expect(result.observation.workerHealth.unhealthyWorkerIds).toEqual([]);
    expect(result.observation.inactivity?.inactiveDegraded).toBe(false);
    expect(result.decision.action).toBe('none');
    expect(result.decision.details.aiEligibilityReason).toBe('no_actionable_incident');
    expect(result.execution.attempted).toBe(false);
    expect(runArcanosCoreQuery).not.toHaveBeenCalled();
  });

  it.each(['dependency', 'watchdog'])('retains a fresh %s predictive candidate beside a healthy peer', failure => {
    const observation = createObservation({ requestCount: 0 });
    observation.workerHealth = { ...observation.workerHealth, overallStatus: 'unhealthy', pending: 1, running: 0,
      alerts: failure === 'watchdog' ? ['Worker watchdog triggered.'] : [],
      workers: [
        { workerId: 'failed-current-slot', healthStatus: 'unhealthy', stale: false, currentJobId: null,
          claimAcceptance: failure === 'dependency' ? 'dependency_failure' : 'accepting',
          watchdog: { triggered: failure === 'watchdog', restartRecommended: false, idleThresholdMs: 120000 } },
        { workerId: 'healthy-current-slot', healthStatus: 'healthy', stale: false, currentJobId: null }
      ] };
    const result = evaluatePredictiveHealingRules({ observation, history: [observation] });
    expect(result.candidates).toContainEqual(expect.objectContaining({ action: 'heal_worker_runtime',
      matchedRule: failure === 'dependency' ? 'worker_dependency_failure' : 'worker_watchdog_reheal_runtime' }));
  });

  it.each([
    ['stalled jobs', { stalledRunning: 1, running: 1 }, {}, 'worker_stalled_jobs'],
    ['failed heartbeat', { pending: 1 }, { stale: true }, 'worker_heartbeat_or_availability_failure'],
    ['offline worker', { pending: 1 }, { healthStatus: 'offline' }, 'worker_heartbeat_or_availability_failure'],
    ['dependency failure', {}, { claimAcceptance: 'dependency_failure' }, 'worker_dependency_failure']
  ])('retains %s diagnosis when the separate listener runtime is disabled', (_label, queue, worker, matchedRule) => {
    const observation = createObservation({
      requestCount: 0,
      workerRuntime: { ...createObservation().workerRuntime, enabled: false, started: false, activeListeners: 0 },
      workerHealth: {
        ...createObservation().workerHealth,
        running: 0,
        ...queue,
        workers: [{ workerId: 'durable-slot', healthStatus: 'healthy', currentJobId: 'running-job', ...worker }]
      }
    });

    const result = evaluatePredictiveHealingRules({ observation, history: [observation] });

    expect(result.decision).toMatchObject({ action: 'heal_worker_runtime', matchedRule, safeToExecute: true });
  });

  it('uses current operational health instead of retained failure status for eight idle workers', async () => {
    const observation = createObservation({ requestCount: 0 });
    const result = await runPredictiveHealingFromLoop({
      source: 'synthetic-operational-health',
      observation: {
        requestWindow: observation as never,
        workerRuntime: observation.workerRuntime,
        trinityStatus: getTrinitySelfHealingStatus(),
        workerHealth: {
          overallStatus: 'healthy', alerts: [],
          queueSummary: { pending: 0, running: 0, stalledRunning: 0 },
          settings: { watchdogIdleMs: 120000 },
          workers: Array.from({ length: 8 }, (_, index) => ({
            workerId: `slot-${index + 1}`,
            healthStatus: index === 0 ? 'unhealthy' : 'healthy',
            operationalStatus: 'healthy',
            currentJobId: null,
            stale: false,
            claimAcceptance: 'accepting',
            lastHeartbeatAt: '2026-03-26T12:00:00.000Z',
            lastActivityAt: '2026-03-26T11:00:00.000Z',
            inactivityMs: 3600000,
            watchdog: { triggered: false, restartRecommended: false, idleThresholdMs: 120000 }
          }))
        } as never
      }
    });

    expect(result.observation.workerHealth.unhealthyWorkerIds).toEqual([]);
    expect(result.observation.workerHealth.workers).toHaveLength(8);
    expect(result.observation.inactivity?.inactiveDegraded).toBe(false);
    expect(result.decision.action).toBe('none');
    expect(result.execution.attempted).toBe(false);
    expect(runArcanosCoreQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['heartbeat', 1, true, 'accepting', 'degraded', 'worker_heartbeat_or_availability_failure'],
    ['dependency', 0, false, 'dependency_failure', 'unhealthy', 'worker_dependency_failure']
  ])('carries explicit %s evidence from control health into predictive candidates', async (_label, pending, stale, claimAcceptance, operationalStatus, matchedRule) => {
    const observation = createObservation({ requestCount: 0 });
    const result = await runPredictiveHealingFromLoop({
      source: 'synthetic-worker-failure',
      observation: {
        requestWindow: observation as never,
        workerRuntime: { ...observation.workerRuntime, enabled: false, started: false, activeListeners: 0 },
        trinityStatus: getTrinitySelfHealingStatus(),
        workerHealth: {
          overallStatus: operationalStatus, alerts: [],
          queueSummary: { pending, running: 0, stalledRunning: 0 },
          settings: { watchdogIdleMs: 120000 },
          workers: Array.from({ length: 8 }, (_, index) => ({
            workerId: `slot-${index + 1}`, healthStatus: 'healthy', operationalStatus,
            currentJobId: null, stale, claimAcceptance,
            lastHeartbeatAt: '2026-03-26T11:58:00.000Z',
            lastActivityAt: '2026-03-26T12:00:00.000Z', inactivityMs: 0,
            watchdog: { triggered: false, restartRecommended: false, idleThresholdMs: 120000 }
          }))
        } as never
      }
    });

    expect(result.decision).toMatchObject({ action: 'heal_worker_runtime', matchedRule });
    expect(result.observation.workerHealth.workers[0]).toMatchObject({ stale, claimAcceptance });
    expect(runArcanosCoreQuery).not.toHaveBeenCalled();
  });
});
