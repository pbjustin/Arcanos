import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getConfigMock = jest.fn();
const scaleWorkersUpMock = jest.fn();
const recycleWorkerMock = jest.fn();
const healWorkerRuntimeMock = jest.fn();
const recordSelfHealEventMock = jest.fn();
const activateTrinitySelfHealingMitigationMock = jest.fn();
const activatePromptRouteReducedLatencyModeMock = jest.fn();
const activatePromptRouteDegradedModeMock = jest.fn();
const getKillSwitchStatusMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const runArcanosCoreQueryMock = jest.fn();
const getOpenAIServiceHealthMock = jest.fn();
const reinitializeOpenAIProviderMock = jest.fn();
const createSingleChatCompletionMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
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

function createStructuredLoggerMock() {
  const channel = {
    debug: jest.fn(),
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    child: jest.fn()
  };
  channel.child.mockReturnValue(channel);
  return channel;
}

const structuredLoggerMock = createStructuredLoggerMock();

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: jest.fn(),
  scaleWorkersUp: scaleWorkersUpMock,
  recycleWorker: recycleWorkerMock
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock,
  getEnvVar: jest.fn(),
  getStableWorkerRuntimeMode: getStableWorkerRuntimeModeMock,
  isWorkerRuntimeSuppressedForServiceRole: isWorkerRuntimeSuppressedForServiceRoleMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  LogLevel: {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error'
  },
  getConfiguredLogLevel: jest.fn(() => 'info'),
  logger: structuredLoggerMock,
  aiLogger: structuredLoggerMock,
  apiLogger: structuredLoggerMock,
  dbLogger: structuredLoggerMock,
  workerLogger: structuredLoggerMock,
  default: structuredLoggerMock
}));

jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  getKillSwitchStatus: getKillSwitchStatusMock
}));

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  activatePromptRouteDegradedMode: activatePromptRouteDegradedModeMock,
  activatePromptRouteReducedLatencyMode: activatePromptRouteReducedLatencyModeMock,
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
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock
}));

jest.unstable_mockModule('@services/arcanos-core.js', () => ({
  runArcanosCoreQuery: runArcanosCoreQueryMock
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  createSingleChatCompletion: createSingleChatCompletionMock
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: getOpenAIServiceHealthMock,
  reinitializeOpenAIProvider: reinitializeOpenAIProviderMock
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: jest.fn(),
  healWorkerRuntime: healWorkerRuntimeMock
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  activateTrinitySelfHealingMitigation: activateTrinitySelfHealingMitigationMock,
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
  recordSelfHealEvent: recordSelfHealEventMock
}));

// Real admission transitions, isolated local persistence; no Redis or provider I/O.
const { createSelfHealingInferenceCoordinator } = await import('../src/services/selfImprove/selfHealingInferenceAdmission.js');
const inferenceStates = new Map<string, string>();
let afterInferenceReservation: (() => void) | null = null;
function createPurposeCoordinator(purpose: string) {
  const relatedPurpose = purpose === 'diagnosis' ? 'provider_probe' : 'diagnosis';
  return createSelfHealingInferenceCoordinator({
    async read() { return { rawState: inferenceStates.get(purpose) ?? null,
      relatedRawState: inferenceStates.get(relatedPurpose) ?? null, nowMs: Date.now() }; },
    async compareAndSet(expected, replacement, relatedExpected) {
      if ((inferenceStates.get(purpose) ?? null) !== expected
        || (inferenceStates.get(relatedPurpose) ?? null) !== relatedExpected) return false;
      inferenceStates.set(purpose, replacement);
      return true;
    }
  });
}
const admissionCoordinators = {
  diagnosis: createPurposeCoordinator('diagnosis'),
  provider_probe: createPurposeCoordinator('provider_probe')
};
jest.unstable_mockModule('../src/services/selfImprove/selfHealingInferenceAdmission.js', () => ({
  reserveSelfHealingInference: async policy => {
    const purpose = policy.purpose ?? 'diagnosis';
    const result = await admissionCoordinators[purpose].reserve(policy);
    afterInferenceReservation?.();
    return result.allowed ? { ...result, reservation: { ...result.reservation, purpose } } : result;
  },
  completeSelfHealingInference: (reservation, result) =>
    admissionCoordinators[reservation.purpose ?? 'diagnosis'].complete(reservation, result)
}));

const {
  buildPredictiveHealingAIProviderStatusSnapshot,
  buildPredictiveHealingStatusSnapshot,
  probePredictiveHealingAIProvider,
  resetPredictiveHealingStateForTests,
  runPredictiveHealingDecision,
  runPredictiveHealingFromLoop
} = await import('../src/services/selfImprove/predictiveHealingService.js');

function createObservation(overrides: Record<string, unknown> = {}) {
  return {
    collectedAt: '2026-03-26T12:00:00.000Z',
    source: 'test',
    windowMs: 300000,
    requestCount: 30,
    errorRate: 0.02,
    timeoutRate: 0,
    avgLatencyMs: 2400,
    p95LatencyMs: 3200,
    maxLatencyMs: 4100,
    degradedCount: 0,
    memory: {
      rssMb: 500,
      heapUsedMb: 220,
      heapTotalMb: 280,
      externalMb: 16,
      arrayBuffersMb: 6
    },
    workerHealth: {
      overallStatus: 'degraded',
      alertCount: 0,
      alerts: [],
      pending: 8,
      running: 1,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 5000,
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

function toLoopObservation(observation = createObservation()) {
  return {
    collectedAt: observation.collectedAt,
    requestWindow: {
      windowMs: observation.windowMs,
      requestCount: observation.requestCount,
      errorRate: observation.errorRate,
      timeoutRate: observation.timeoutRate,
      avgLatencyMs: observation.avgLatencyMs,
      p95LatencyMs: observation.p95LatencyMs,
      maxLatencyMs: observation.maxLatencyMs,
      degradedCount: observation.degradedCount,
      routes: [],
      serverErrorCount: Math.round(observation.requestCount * observation.errorRate),
      clientErrorCount: 0,
      pipelineTimeoutCount: 0,
      timeoutCount: Math.round(observation.requestCount * observation.timeoutRate)
    },
    workerHealth: {
      overallStatus: observation.workerHealth.overallStatus,
      alerts: observation.workerHealth.alerts,
      workers: observation.workerHealth.workers,
      queueSummary: {
        pending: observation.workerHealth.pending,
        running: observation.workerHealth.running,
        delayed: observation.workerHealth.delayed,
        stalledRunning: observation.workerHealth.stalledRunning,
        oldestPendingJobAgeMs: observation.workerHealth.oldestPendingJobAgeMs
      }
    },
    workerRuntime: observation.workerRuntime,
    trinityStatus: {
      enabled: observation.trinity.enabled,
      config: {
        triggerThreshold: observation.trinity.config.triggerThreshold,
        maxAttempts: observation.trinity.config.maxAttempts
      },
      snapshot: {
        intake: {
          observations: new Array(observation.trinity.stages.intake.observationsInWindow).fill(0),
          attempts: observation.trinity.stages.intake.attempts,
          activeAction: observation.trinity.stages.intake.activeAction,
          activeSinceMs: null,
          expiresAtMs: null,
          verificationSuccesses: observation.trinity.stages.intake.verified ? 1 : 0,
          verificationFailures: 0,
          verifiedAtMs: observation.trinity.stages.intake.verified ? Date.now() : null,
          cooldownUntilMs: observation.trinity.stages.intake.cooldownUntil
            ? Date.parse(observation.trinity.stages.intake.cooldownUntil)
            : null,
          failedActions: observation.trinity.stages.intake.failedActions
        },
        reasoning: {
          observations: new Array(observation.trinity.stages.reasoning.observationsInWindow).fill(0),
          attempts: observation.trinity.stages.reasoning.attempts,
          activeAction: observation.trinity.stages.reasoning.activeAction,
          activeSinceMs: null,
          expiresAtMs: null,
          verificationSuccesses: observation.trinity.stages.reasoning.verified ? 1 : 0,
          verificationFailures: 0,
          verifiedAtMs: observation.trinity.stages.reasoning.verified ? Date.now() : null,
          cooldownUntilMs: observation.trinity.stages.reasoning.cooldownUntil
            ? Date.parse(observation.trinity.stages.reasoning.cooldownUntil)
            : null,
          failedActions: observation.trinity.stages.reasoning.failedActions
        },
        final: {
          observations: new Array(observation.trinity.stages.final.observationsInWindow).fill(0),
          attempts: observation.trinity.stages.final.attempts,
          activeAction: observation.trinity.stages.final.activeAction,
          activeSinceMs: null,
          expiresAtMs: null,
          verificationSuccesses: observation.trinity.stages.final.verified ? 1 : 0,
          verificationFailures: 0,
          verifiedAtMs: observation.trinity.stages.final.verified ? Date.now() : null,
          cooldownUntilMs: observation.trinity.stages.final.cooldownUntil
            ? Date.parse(observation.trinity.stages.final.cooldownUntil)
            : null,
          failedActions: observation.trinity.stages.final.failedActions
        }
      }
    },
    workerHealthError: null
  };
}

describe('predictive healing execution', () => {
  beforeEach(() => {
    inferenceStates.clear();
    afterInferenceReservation = null;
    jest.useFakeTimers().setSystemTime(new Date('2026-03-26T12:00:00.000Z'));
    jest.clearAllMocks();
    getKillSwitchStatusMock.mockResolvedValue({ frozen: false, autonomyLevel: 3 });
    getStableWorkerRuntimeModeMock.mockReturnValue({
      requestedRunWorkers: false, resolvedRunWorkers: false, processKind: 'unknown',
      railwayServiceName: null, reason: 'requested'
    });
    activatePromptRouteReducedLatencyModeMock.mockReturnValue({ applied: true, rolledBack: false, reason: 'applied', state: {} });
    activatePromptRouteDegradedModeMock.mockReturnValue({ applied: true, rolledBack: false, reason: 'applied', state: {} });
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: {}
    });
    runArcanosCoreQueryMock.mockReset();
    runArcanosCoreQueryMock.mockResolvedValue({
      result: JSON.stringify({
        selectedCandidateIndex: 0,
        chooseNoAction: false,
        reason: 'Select the highest-priority candidate.',
        safeToExecute: true,
        confidence: 0.9
      }),
      activeModel: 'gpt-4.1',
      fallbackFlag: false,
      fallbackSummary: {
        fallbackReasons: []
      },
      routingStages: []
    });
    createSingleChatCompletionMock.mockReset();
    getOpenAIServiceHealthMock.mockReturnValue({
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
        lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
        healthy: true,
        constants: {
          CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000
        }
      },
      cache: {
        enabled: true
      },
      lastHealthCheck: '2026-03-26T11:59:30.000Z',
      defaults: {
        maxTokens: 1024
      },
      providerRuntime: {
        configSource: 'OPENAI_API_KEY',
        configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
        lastReloadAt: '2026-03-26T11:59:00.000Z',
        reloadCount: 1,
        lastAttemptAt: '2026-03-25T00:00:00.000Z',
        lastSuccessAt: '2026-03-25T00:00:00.000Z',
        lastFailureAt: null,
        lastFailureReason: null,
        lastFailureCategory: null,
        lastFailureStatus: null,
        consecutiveFailures: 0,
        backoffMs: 0,
        nextRetryAt: null
      }
    });
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
    getConfigMock.mockReturnValue({
      openaiApiKey: 'test-synthetic-offline-credential',
      selfImproveEnabled: true, selfImproveActuatorMode: 'daemon',
      selfImproveAutonomyLevel: 3, selfImproveFrozen: false,
      predictiveHealingEnabled: true,
      predictiveHealingDryRun: false,
      autoExecuteHealing: false,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
      predictiveHealingAiIdleCooldownMs: 21600000,
      predictiveHealingAiActiveCooldownMs: 1800000,
      predictiveHealingAiFailureCooldownMs: 21600000,
      predictiveScaleUpStep: 1,
      predictiveHealingMinObservations: 3,
      predictiveHealingStaleAfterMs: 300000,
      predictiveHealingMinConfidence: 0.6,
      predictiveErrorRateThreshold: 0.18,
      predictiveLatencyConsecutiveIntervals: 3,
      predictiveLatencyRiseDeltaMs: 250,
      predictiveMemoryThresholdMb: 900,
      predictiveMemoryGrowthThresholdMb: 120,
      predictiveMemorySustainedIntervals: 3,
      predictiveQueuePendingThreshold: 5,
      predictiveQueueVelocityThreshold: 2,
      runWorkers: true,
      workerApiTimeoutMs: 10000
    });
    scaleWorkersUpMock.mockResolvedValue({
      supported: true,
      applied: true,
      deltaRequested: 1,
      deltaApplied: 1,
      activeWorkerCount: 5,
      maxActiveWorkers: 6,
      workerIds: ['arcanos-worker-1', 'arcanos-worker-2', 'arcanos-worker-surge-1'],
      message: 'Scaled worker runtime by 1 listener(s).'
    });
    recycleWorkerMock.mockResolvedValue({
      supported: true,
      applied: true,
      workerId: 'arcanos-worker-1',
      activeWorkerCount: 4,
      workerIds: ['arcanos-worker-1', 'arcanos-worker-2'],
      message: 'Recycled worker arcanos-worker-1.'
    });
    healWorkerRuntimeMock.mockResolvedValue({
      restart: {
        started: true,
        message: 'Workers started successfully.'
      },
      runtime: {
        started: true
      }
    });
    activateTrinitySelfHealingMitigationMock.mockReturnValue({
      applied: true,
      rolledBack: false,
      stage: 'final',
      action: 'bypass_final_stage',
      reason: 'applied',
      activeAction: 'bypass_final_stage',
      verified: false,
      expiresAtMs: Date.now() + 600000
    });
    resetPredictiveHealingStateForTests();
  });

  afterEach(() => {
    delete process.env.SELF_HEAL_LOOP_INTERVAL_MS;
    delete process.env.PREDICTIVE_HEALING_INTERVAL_MS;
    jest.useRealTimers();
  });

  it('executes a scale-up action when explicitly requested', async () => {
    const history = [
      createObservation({ collectedAt: '2026-03-26T11:57:00.000Z', avgLatencyMs: 900, p95LatencyMs: 1200, workerHealth: { ...createObservation().workerHealth, pending: 4 } }),
      createObservation({ collectedAt: '2026-03-26T11:58:00.000Z', avgLatencyMs: 1400, p95LatencyMs: 1700, workerHealth: { ...createObservation().workerHealth, pending: 6 } }),
      createObservation({ collectedAt: '2026-03-26T11:59:00.000Z', avgLatencyMs: 1900, p95LatencyMs: 2500, workerHealth: { ...createObservation().workerHealth, pending: 7 } }),
      createObservation({ collectedAt: '2026-03-26T12:00:00.000Z', avgLatencyMs: 2400, p95LatencyMs: 3200, workerHealth: { ...createObservation().workerHealth, pending: 8 } })
    ];

    let lastResult;
    for (const observation of history.slice(0, 3)) {
      lastResult = await runPredictiveHealingDecision({
        source: 'predictive_test_seed',
        observation
      });
      expect(['skipped', 'refused']).toContain(lastResult.execution.status);
    }

    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_execute',
      observation: history[3],
      execute: true
    });
    expect(scaleWorkersUpMock).toHaveBeenCalledWith(1);
    expect(result.decision.action).toBe('scale_workers_up');
    expect(result.execution.status).toBe('executed');
  });

  it('records a failed execution when heal actuator throws', async () => {
    healWorkerRuntimeMock.mockRejectedValue(new Error('runtime restart failed'));

    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_failure',
      observation: createObservation({
        errorRate: 0.28,
        requestCount: 40
      }),
      execute: true
    });

    expect(result.decision.action).toBe('heal_worker_runtime');
    expect(result.execution.status).toBe('failed');
    expect(result.execution.message).toContain('runtime restart failed');
    expect(recordSelfHealEventMock).toHaveBeenCalled();
  });

  it('dispatches one repair when concurrent decisions finish authorization together', async () => {
    let authorize!: (controls: { frozen: boolean; autonomyLevel: number }) => void;
    const authorization = new Promise<{ frozen: boolean; autonomyLevel: number }>(resolve => { authorize = resolve; });
    getKillSwitchStatusMock.mockReturnValue(authorization);
    let finishRepair!: (result: unknown) => void;
    healWorkerRuntimeMock.mockReturnValueOnce(new Promise(resolve => { finishRepair = resolve; }));
    const observation = createObservation({ errorRate: 0.28, requestCount: 40 });
    const requests = [
      runPredictiveHealingDecision({ source: 'concurrent_first', observation, execute: true }),
      runPredictiveHealingDecision({ source: 'concurrent_second', observation, execute: true })
    ];
    for (let index = 0; index < 30 && getKillSwitchStatusMock.mock.calls.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(getKillSwitchStatusMock).toHaveBeenCalledTimes(2);
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
    authorize({ frozen: false, autonomyLevel: 3 });
    for (let index = 0; index < 30 && healWorkerRuntimeMock.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(healWorkerRuntimeMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_001);
    const whilePending = await runPredictiveHealingDecision({
      source: 'concurrent_later', observation, execute: true
    });
    expect(whilePending.execution).toMatchObject({ attempted: false, status: 'cooldown' });
    expect(whilePending.execution.message).toContain('already in flight');
    expect(healWorkerRuntimeMock).toHaveBeenCalledTimes(1);
    finishRepair({ restart: { started: true, message: 'Synthetic repair completed.' }, runtime: { started: true } });
    const results = await Promise.all(requests);
    expect(healWorkerRuntimeMock).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.execution.status).sort()).toEqual(['cooldown', 'executed']);
  });

  it('charges a failed repair cooldown and releases its reservation for a later authorized retry', async () => {
    healWorkerRuntimeMock.mockRejectedValueOnce(new Error('synthetic uncertain repair'));
    const observation = createObservation({ errorRate: 0.28, requestCount: 40 });
    const failed = await runPredictiveHealingDecision({ source: 'failed_attempt', observation, execute: true });
    expect(failed.execution).toMatchObject({ attempted: true, status: 'failed' });
    const blocked = await runPredictiveHealingDecision({ source: 'failed_attempt_retry', observation, execute: true });
    expect(blocked.execution).toMatchObject({ attempted: false, status: 'cooldown', cooldownRemainingMs: 60_000 });
    expect(healWorkerRuntimeMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_001);
    const retried = await runPredictiveHealingDecision({ source: 'after_failed_cooldown', observation, execute: true });
    expect(retried.execution.status).toBe('executed');
    expect(healWorkerRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it('does not reserve an action when current authorization refuses execution', async () => {
    const observation = createObservation({ errorRate: 0.28, requestCount: 40 });
    getKillSwitchStatusMock.mockResolvedValueOnce({ frozen: true, autonomyLevel: 3 });
    const refused = await runPredictiveHealingDecision({ source: 'frozen_attempt', observation, execute: true });
    expect(refused.execution).toMatchObject({ attempted: false, status: 'refused' });
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
    const allowed = await runPredictiveHealingDecision({ source: 'authorized_attempt', observation, execute: true });
    expect(allowed.execution.status).toBe('executed');
    expect(healWorkerRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ selfImproveEnabled: false }, 'self_improve_execution_disabled'],
    [{ selfImproveActuatorMode: 'pr_bot' }, 'self_improve_execution_disabled'],
    [{ selfImproveAutonomyLevel: 0 }, 'insufficient_autonomy'],
    [{ selfImproveFrozen: true }, 'self_improve_frozen'],
    [{ predictiveHealingEnabled: false }, 'predictive_execution_disabled'],
    [{ predictiveHealingDryRun: true }, 'predictive_dry_run_enforced'],
    [{ autoExecuteHealing: false }, 'predictive_auto_execute_disabled']
  ])('honors configuration restriction applied during authorization: %j', async (restriction, message) => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), autoExecuteHealing: true });
    let authorize!: (controls: { frozen: boolean; autonomyLevel: number }) => void;
    getKillSwitchStatusMock.mockReturnValueOnce(new Promise(resolve => { authorize = resolve; }));
    const pending = runPredictiveHealingDecision({
      source: 'policy_changed_during_authorization', allowAutoExecute: true,
      observation: createObservation({ errorRate: 0.28, requestCount: 40 })
    });
    for (let index = 0; index < 30 && getKillSwitchStatusMock.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(getKillSwitchStatusMock).toHaveBeenCalledTimes(1);
    getConfigMock.mockReturnValue({ ...getConfigMock(), ...restriction });
    authorize({ frozen: false, autonomyLevel: 3 });
    expect((await pending).execution).toMatchObject({ attempted: false, status: 'refused', message });
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ selfImproveEnabled: false }, 'self_improve_execution_disabled'],
    [{ selfImproveActuatorMode: 'host' }, 'self_improve_execution_disabled'],
    [{ selfImproveFrozen: true }, 'self_improve_frozen'],
    [{ selfImproveAutonomyLevel: 2 }, 'insufficient_autonomy'],
    [{ predictiveHealingEnabled: false }, 'predictive_execution_disabled']
  ])('refuses predictive effects under restrictive current configuration %j', async (restriction, reason) => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), ...restriction });
    const result = await runPredictiveHealingDecision({
      source: 'policy_fixture', execute: true,
      observation: createObservation({ errorRate: 0.28, requestCount: 40 })
    });
    expect(result.execution).toMatchObject({ attempted: false, status: 'refused', message: reason });
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
    expect(scaleWorkersUpMock).not.toHaveBeenCalled();
    expect(activateTrinitySelfHealingMitigationMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ frozen: true, autonomyLevel: 3 }, 'self_improve_frozen'],
    [{ frozen: false, autonomyLevel: 1 }, 'insufficient_autonomy']
  ])('honors effective emergency restrictions after advisor completion %j', async (controls, reason) => {
    getKillSwitchStatusMock.mockResolvedValue(controls);
    const result = await runPredictiveHealingDecision({
      source: 'kill_switch_fixture', execute: true,
      observation: createObservation({ errorRate: 0.28, requestCount: 40 })
    });
    expect(result.execution).toMatchObject({ status: 'refused', message: reason });
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('does not allow caller dryRun false to override configured dry-run', async () => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), predictiveHealingDryRun: true });
    const result = await runPredictiveHealingDecision({
      source: 'dry_run_fixture', execute: true, dryRun: false,
      observation: createObservation({ errorRate: 0.28, requestCount: 40 })
    });
    expect(result.featureFlags.dryRun).toBe(true);
    expect(result.execution).toMatchObject({ attempted: false, status: 'dry_run', mode: 'dry_run' });
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('rejects cancellation arriving during the final authorization read', async () => {
    const cancellation = new AbortController();
    getKillSwitchStatusMock.mockImplementation(async () => {
      cancellation.abort();
      return { frozen: false, autonomyLevel: 3 };
    });
    const result = await runPredictiveHealingDecision({
      source: 'cancellation_fixture', execute: true, signal: cancellation.signal,
      observation: createObservation({ errorRate: 0.28, requestCount: 40 })
    });
    expect(result.execution).toMatchObject({ status: 'refused', message: 'coordinator_cancelled' });
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('blocks a worker-owned prompt mitigation without reporting execution', async () => {
    getStableWorkerRuntimeModeMock.mockReturnValue({
      requestedRunWorkers: false, resolvedRunWorkers: true, processKind: 'worker',
      railwayServiceName: null, reason: 'process_kind_worker'
    });
    const result = await runPredictiveHealingDecision({
      source: 'cross_process_fixture', execute: true, observation: createObservation()
    });
    expect(result.decision.action).toBe('mark_node_degraded');
    expect(result.execution).toMatchObject({
      attempted: false, status: 'unsupported', message: 'cross_process_prompt_route_unavailable'
    });
    expect(activatePromptRouteReducedLatencyModeMock).not.toHaveBeenCalled();
    expect(activatePromptRouteDegradedModeMock).not.toHaveBeenCalled();
  });

  it('never reports an unapplied local prompt command as executed', async () => {
    activatePromptRouteReducedLatencyModeMock.mockReturnValue({
      applied: false, rolledBack: false, reason: 'already_active', state: {}
    });
    const result = await runPredictiveHealingDecision({
      source: 'unapplied_command_fixture', execute: true, observation: createObservation()
    });
    expect(result.decision.action).toBe('mark_node_degraded');
    expect(result.execution).toMatchObject({
      attempted: false, status: 'skipped', recoveryOutcome: { status: 'not_executed' }
    });
  });

  it('makes no provider calls or repairs across twenty healthy idle ticks with eight workers', async () => {
    const base = createObservation();
    for (let tick = 0; tick < 20; tick += 1) {
      const observation = createObservation({
        collectedAt: new Date().toISOString(), requestCount: 0, errorRate: 0,
        timeoutRate: 0, avgLatencyMs: 0, p95LatencyMs: 0, maxLatencyMs: 0, degradedCount: 0,
        workerHealth: {
          ...base.workerHealth, overallStatus: 'healthy', pending: 0, running: 0,
          delayed: 0, stalledRunning: 0, alerts: [], alertCount: 0,
          degradedWorkerIds: [], unhealthyWorkerIds: [],
          workers: Array.from({ length: 8 }, (_, index) => ({
            workerId: `idle-${index}`, healthStatus: 'healthy', currentJobId: null,
            inactivityMs: 24 * 60 * 60_000, lastActivityAt: '2026-03-25T12:00:00.000Z',
            watchdog: { triggered: false, restartRecommended: false, reason: null, idleThresholdMs: 120_000 }
          }))
        }
      });
      const result = await runPredictiveHealingFromLoop({
        source: 'predictive_self_heal_loop', observation: toLoopObservation(observation)
      });
      expect(result.decision.action).toBe('none');
      expect(result.execution.attempted).toBe(false);
      jest.setSystemTime(Date.now() + 30_000);
    }
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
    expect(recycleWorkerMock).not.toHaveBeenCalled();
  });

  it('keeps a recent diagnosis authoritative when provider health still reports yesterday', async () => {
    const observation = createObservation({ errorRate: 0.8 });
    await runPredictiveHealingDecision({ source: 'stale_provider_first', observation });
    jest.setSystemTime(Date.now() + 30_000);
    const result = await runPredictiveHealingDecision({
      source: 'stale_provider_second', observation: { ...observation, collectedAt: new Date().toISOString() }
    });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(buildPredictiveHealingAIProviderStatusSnapshot().lastAttemptAt).toBe('2026-03-26T12:00:00.000Z');
    expect(result.decision.details.aiUsed).toBe(false);
  });

  it('does not automatically diagnose an incident when predictive healing is disabled', async () => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), predictiveHealingEnabled: false });
    await runPredictiveHealingDecision({
      source: 'disabled_predictive', observation: createObservation({ errorRate: 0.8 })
    });
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
  });

  it('does not diagnose an idle window even when provider health reports a recent successful probe', async () => {
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: {}
    });
    runArcanosCoreQueryMock.mockResolvedValue({
      result: JSON.stringify({
        selectedCandidateIndex: null,
        chooseNoAction: true,
        reason: 'No action required.',
        safeToExecute: false,
        confidence: 0.12
      }),
      activeModel: 'gpt-4.1',
      fallbackFlag: false,
      fallbackSummary: {
        fallbackReasons: []
      }
    });
    const idleObservation = createObservation({
      requestCount: 0,
      errorRate: 0,
      timeoutRate: 0,
      degradedCount: 0,
      workerHealth: {
        ...createObservation().workerHealth,
        overallStatus: 'healthy',
        pending: 0,
        running: 0,
        alertCount: 0,
        stalledRunning: 0
      },
      trinity: {
        ...createObservation().trinity,
        activeAction: null
      }
    });

    await runPredictiveHealingDecision({
      source: 'predictive_test_idle_cooldown_first',
      observation: idleObservation
    });
    getOpenAIServiceHealthMock.mockReturnValue({
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
        lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
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
    });
    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_idle_cooldown_second',
      observation: idleObservation
    });
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(result.decision.advisor).toBe('rules_fallback_v1');
    expect(result.decision.details).toMatchObject({
      aiUsed: false,
      aiEligibilityReason: 'no_actionable_incident'
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'self_heal.ai_diagnosis.skipped',
      expect.objectContaining({
        source: 'predictive_test_idle_cooldown_second',
        reason: 'no_actionable_incident'
      })
    );
  });

  it('emits a structured audit log for healthy no-op decisions', async () => {
    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_healthy',
      observation: createObservation({
        requestCount: 8,
        avgLatencyMs: 250,
        p95LatencyMs: 400,
        workerHealth: { ...createObservation().workerHealth, pending: 0 }
      })
    });

    expect(result.decision.action).toBe('none');
    expect(result.execution.status).toBe('refused');
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'predictive_healing.audit',
      expect.objectContaining({
        module: 'predictive-healing',
        operation: 'decision',
        source: 'predictive_test_healthy'
      }),
      expect.objectContaining({
        observation: expect.objectContaining({
          requestCount: 8,
          avgLatencyMs: 250
        }),
        decision: expect.objectContaining({
          action: 'none'
        }),
        execution: expect.objectContaining({
          status: 'refused'
        })
      })
    );
  });

  it('skips the background automation loop when predictive healing is disabled', async () => {
    getConfigMock.mockReturnValue({
      selfImproveEnabled: true, selfImproveActuatorMode: 'daemon',
      selfImproveAutonomyLevel: 3, selfImproveFrozen: false,
      predictiveHealingEnabled: false,
      predictiveHealingDryRun: true,
      autoExecuteHealing: false,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
      predictiveHealingAiIdleCooldownMs: 21600000,
      predictiveHealingAiActiveCooldownMs: 1800000,
      predictiveHealingAiFailureCooldownMs: 21600000,
      predictiveScaleUpStep: 1,
      predictiveHealingMinObservations: 3,
      predictiveHealingStaleAfterMs: 300000,
      predictiveHealingMinConfidence: 0.6,
      predictiveErrorRateThreshold: 0.18,
      predictiveLatencyConsecutiveIntervals: 3,
      predictiveLatencyRiseDeltaMs: 250,
      predictiveMemoryThresholdMb: 900,
      predictiveMemoryGrowthThresholdMb: 120,
      predictiveMemorySustainedIntervals: 3,
      predictiveQueuePendingThreshold: 5,
      predictiveQueueVelocityThreshold: 2,
      runWorkers: true,
      workerApiTimeoutMs: 10000
    });

    const result = await runPredictiveHealingFromLoop({
      source: 'predictive_self_heal_loop',
      observation: toLoopObservation(
        createObservation({
          avgLatencyMs: 2600,
          p95LatencyMs: 3400,
          workerHealth: { ...createObservation().workerHealth, pending: 9 }
        })
      )
    });

    expect(result.featureFlags.enabled).toBe(false);
    expect(result.decision.action).not.toBe('none');
    expect(result.execution.status).toBe('skipped');
    expect(result.execution.mode).toBe('recommend_only');
    expect(result.execution.message).toContain('recommended only');
    expect(scaleWorkersUpMock).not.toHaveBeenCalled();
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'trigger',
        trigger: 'predictive'
      })
    );
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'noop',
        trigger: 'predictive',
        reason: expect.stringContaining('recommended only')
      })
    );
    expect(buildPredictiveHealingStatusSnapshot().recentAuditCount).toBe(1);
  });

  it('summarizes automated loop decisions and outcomes in status output', async () => {
    process.env.PREDICTIVE_HEALING_INTERVAL_MS = '15000';
    getConfigMock.mockReturnValue({
      selfImproveEnabled: true, selfImproveActuatorMode: 'daemon',
      selfImproveAutonomyLevel: 3, selfImproveFrozen: false,
      predictiveHealingEnabled: true,
      predictiveHealingDryRun: false,
      autoExecuteHealing: true,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
      predictiveHealingAiIdleCooldownMs: 21600000,
      predictiveHealingAiActiveCooldownMs: 1800000,
      predictiveHealingAiFailureCooldownMs: 21600000,
      predictiveScaleUpStep: 1,
      predictiveHealingMinObservations: 3,
      predictiveHealingStaleAfterMs: 300000,
      predictiveHealingMinConfidence: 0.6,
      predictiveErrorRateThreshold: 0.18,
      predictiveLatencyConsecutiveIntervals: 3,
      predictiveLatencyRiseDeltaMs: 250,
      predictiveMemoryThresholdMb: 900,
      predictiveMemoryGrowthThresholdMb: 120,
      predictiveMemorySustainedIntervals: 3,
      predictiveQueuePendingThreshold: 5,
      predictiveQueueVelocityThreshold: 2,
      runWorkers: true,
      workerApiTimeoutMs: 10000
    });

    const history = [
      createObservation({
        collectedAt: '2026-03-26T11:57:00.000Z',
        avgLatencyMs: 900,
        p95LatencyMs: 1200,
        workerHealth: { ...createObservation().workerHealth, pending: 4 }
      }),
      createObservation({
        collectedAt: '2026-03-26T11:58:00.000Z',
        avgLatencyMs: 1400,
        p95LatencyMs: 1800,
        workerHealth: { ...createObservation().workerHealth, pending: 6 }
      }),
      createObservation({
        collectedAt: '2026-03-26T11:59:00.000Z',
        avgLatencyMs: 1900,
        p95LatencyMs: 2500,
        workerHealth: { ...createObservation().workerHealth, pending: 7 }
      }),
      createObservation({
        collectedAt: '2026-03-26T12:00:00.000Z',
        avgLatencyMs: 2400,
        p95LatencyMs: 3200,
        workerHealth: { ...createObservation().workerHealth, pending: 8 }
      })
    ];

    for (const observation of history) {
      await runPredictiveHealingFromLoop({
        source: 'predictive_self_heal_loop',
        observation: toLoopObservation(observation)
      });
    }

    const snapshot = buildPredictiveHealingStatusSnapshot();
    expect(scaleWorkersUpMock).toHaveBeenCalledWith(1);
    expect(snapshot.automation).toEqual(expect.objectContaining({
      active: true,
      autoExecuteReady: true,
      cooldownMs: 60000,
      pollIntervalMs: 15000,
      minConfidence: 0.6,
      lastLoopDecisionAt: '2026-03-26T12:00:00.000Z',
      lastLoopAction: 'scale_workers_up',
      lastLoopResult: 'cooldown',
      lastAutoExecutionAt: '2026-03-26T11:59:00.000Z',
      lastAutoExecutionAction: 'scale_workers_up',
      lastAutoExecutionResult: 'executed'
    }));
    expect(snapshot.recentExecutionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'predictive_self_heal_loop',
        action: 'scale_workers_up',
        result: 'executed',
        mode: 'auto_execute',
        recoveryStatus: 'pending_observation'
      })
    ]));
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'predictive_healing.audit',
      expect.objectContaining({
        module: 'predictive-healing',
        operation: 'decision',
        source: 'predictive_self_heal_loop'
      }),
      expect.objectContaining({
        observation: expect.objectContaining({
          requestCount: 30,
          avgLatencyMs: 2400
        }),
        decision: expect.objectContaining({
          action: 'scale_workers_up',
          matchedRule: 'latency_rising_scale_up'
        }),
        execution: expect.objectContaining({
          mode: 'auto_execute',
          status: 'cooldown'
        })
      })
    );
  });

  it('does not heal the worker runtime when the queue is idle but one worker processed recently', async () => {
    const result = await runPredictiveHealingFromLoop({
      source: 'predictive_self_heal_loop',
      observation: toLoopObservation(
        createObservation({
          requestCount: 0,
          workerHealth: {
            ...createObservation().workerHealth,
            overallStatus: 'degraded',
            alertCount: 7,
            alerts: ['No worker receipts or processed jobs observed for 151385ms after startup.'],
            pending: 0,
            running: 0,
            workers: [
              {
                workerId: 'async-queue-slot-2',
                healthStatus: 'degraded',
                currentJobId: null,
                lastActivityAt: '2026-03-26T11:57:29.000Z',
                lastProcessedJobAt: null,
                inactivityMs: 151000,
                watchdog: {
                  triggered: false,
                  reason: 'No worker receipts or processed jobs observed for 151000ms after startup.',
                  restartRecommended: true,
                  idleThresholdMs: 120000,
                },
              },
              {
                workerId: 'async-queue-slot-3',
                healthStatus: 'degraded',
                currentJobId: null,
                lastActivityAt: '2026-03-26T11:57:31.000Z',
                lastProcessedJobAt: null,
                inactivityMs: 149000,
                watchdog: {
                  triggered: false,
                  reason: 'No worker receipts or processed jobs observed for 149000ms after startup.',
                  restartRecommended: true,
                  idleThresholdMs: 120000,
                },
              },
              {
                workerId: 'async-queue-slot-1',
                healthStatus: 'healthy',
                currentJobId: null,
                lastActivityAt: '2026-03-26T11:59:35.000Z',
                lastProcessedJobAt: '2026-03-26T11:59:35.000Z',
                inactivityMs: 25000,
                watchdog: {
                  triggered: false,
                  reason: null,
                  restartRecommended: false,
                  idleThresholdMs: 120000,
                },
              },
            ],
          },
          workerRuntime: {
            enabled: false,
            started: false,
            configuredCount: 4,
            activeListeners: 0,
            maxActiveWorkers: 6,
            surgeWorkerCount: 0,
            workerIds: [],
          },
        }),
      ),
    });

    const snapshot = buildPredictiveHealingStatusSnapshot();
    const latestObservation = snapshot.recentObservations.at(-1);

    expect(result.decision.action).not.toBe('heal_worker_runtime');
    expect(latestObservation?.inactivity).toEqual(expect.objectContaining({
      inactiveDegraded: false,
      lastActivityAt: '2026-03-26T11:59:35.000Z',
      lastProcessedJobAt: '2026-03-26T11:59:35.000Z',
    }));
  });

  it('executes Trinity mitigation when predictive rules select a Trinity stage pre-heal', async () => {
    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_trinity_execute',
      observation: createObservation({
        requestCount: 14,
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
      }),
      execute: true
    });

    expect(result.decision.action).toBe('activate_trinity_mitigation');
    expect(result.decision.target).toBe('trinity:final');
    expect(activateTrinitySelfHealingMitigationMock).toHaveBeenCalledWith({
      stage: 'final',
      action: 'bypass_final_stage',
      reason: 'predictive_healing:trinity_final_stage_preheal'
    });
    expect(result.execution.status).toBe('executed');
  });

  it('captures Trinity predictive automation in loop status history', async () => {
    getConfigMock.mockReturnValue({
      selfImproveEnabled: true, selfImproveActuatorMode: 'daemon',
      selfImproveAutonomyLevel: 3, selfImproveFrozen: false,
      predictiveHealingEnabled: true,
      predictiveHealingDryRun: false,
      autoExecuteHealing: true,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
      predictiveHealingAiIdleCooldownMs: 21600000,
      predictiveHealingAiActiveCooldownMs: 1800000,
      predictiveHealingAiFailureCooldownMs: 21600000,
      predictiveScaleUpStep: 1,
      predictiveHealingMinObservations: 3,
      predictiveHealingStaleAfterMs: 300000,
      predictiveHealingMinConfidence: 0.6,
      predictiveErrorRateThreshold: 0.18,
      predictiveLatencyConsecutiveIntervals: 3,
      predictiveLatencyRiseDeltaMs: 250,
      predictiveMemoryThresholdMb: 900,
      predictiveMemoryGrowthThresholdMb: 120,
      predictiveMemorySustainedIntervals: 3,
      predictiveQueuePendingThreshold: 5,
      predictiveQueueVelocityThreshold: 2,
      runWorkers: true,
      workerApiTimeoutMs: 10000
    });

    const seededObservations = [
      createObservation({ collectedAt: '2026-03-26T11:58:00.000Z' }),
      createObservation({ collectedAt: '2026-03-26T11:59:00.000Z' }),
      createObservation({
        collectedAt: '2026-03-26T12:00:00.000Z',
        requestCount: 14,
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
      })
    ];

    for (const observation of seededObservations) {
      await runPredictiveHealingFromLoop({
        source: 'predictive_self_heal_loop',
        observation: toLoopObservation(observation)
      });
    }

    const snapshot = buildPredictiveHealingStatusSnapshot();
    expect(snapshot.automation.lastLoopAction).toBe('activate_trinity_mitigation');
    expect(snapshot.automation.lastLoopResult).toBe('executed');
    expect(snapshot.recentExecutionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'activate_trinity_mitigation',
        target: 'trinity:final',
        matchedRule: 'trinity_final_stage_preheal',
        result: 'executed'
      })
    ]));
  });

  it('records provider failure diagnostics when the AI completion path exhausts quota', async () => {
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: { models: { list: jest.fn() } }
    });
    runArcanosCoreQueryMock.mockRejectedValue(Object.assign(new Error('You exceeded your current quota.'), {
      status: 429
    }));
    getOpenAIServiceHealthMock
      .mockReturnValueOnce({
        apiKey: { configured: true, status: 'valid', source: 'OPENAI_API_KEY' },
        client: { initialized: true, model: 'gpt-4.1', timeout: 8000, baseURL: 'https://api.openai.com/v1' },
        circuitBreaker: {
          state: 'CLOSED',
          failureCount: 0,
          lastFailureTime: 0,
          successCount: 0,
          lastOpenedAt: 0,
          lastHalfOpenAt: 0,
          lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
          healthy: true,
          constants: { CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000 }
        },
        cache: { enabled: true },
        lastHealthCheck: '2026-03-26T11:59:30.000Z',
        defaults: { maxTokens: 1024 },
        providerRuntime: {
          configSource: 'OPENAI_API_KEY',
          configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
          lastReloadAt: '2026-03-26T11:59:00.000Z',
          reloadCount: 1,
          lastAttemptAt: '2026-03-25T00:00:00.000Z',
          lastSuccessAt: '2026-03-25T00:00:00.000Z',
          lastFailureAt: null,
          lastFailureReason: null,
          lastFailureCategory: null,
          lastFailureStatus: null,
          consecutiveFailures: 0,
          backoffMs: 0,
          nextRetryAt: null
        }
      })
      .mockReturnValueOnce({
        apiKey: { configured: true, status: 'valid', source: 'OPENAI_API_KEY' },
        client: { initialized: true, model: 'gpt-4.1', timeout: 8000, baseURL: 'https://api.openai.com/v1' },
        circuitBreaker: {
          state: 'CLOSED',
          failureCount: 0,
          lastFailureTime: 0,
          successCount: 0,
          lastOpenedAt: 0,
          lastHalfOpenAt: 0,
          lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
          healthy: true,
          constants: { CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000 }
        },
        cache: { enabled: true },
        lastHealthCheck: '2026-03-26T11:59:30.000Z',
        defaults: { maxTokens: 1024 },
        providerRuntime: {
          configSource: 'OPENAI_API_KEY',
          configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
          lastReloadAt: '2026-03-26T11:59:00.000Z',
          reloadCount: 1,
          lastAttemptAt: '2026-03-25T00:00:00.000Z',
          lastSuccessAt: '2026-03-25T00:00:00.000Z',
          lastFailureAt: null,
          lastFailureReason: null,
          lastFailureCategory: null,
          lastFailureStatus: null,
          consecutiveFailures: 0,
          backoffMs: 0,
          nextRetryAt: null
        }
      })
      .mockReturnValue({
        apiKey: { configured: true, status: 'valid', source: 'OPENAI_API_KEY' },
        client: { initialized: true, model: 'gpt-4.1', timeout: 8000, baseURL: 'https://api.openai.com/v1' },
        circuitBreaker: {
          state: 'OPEN',
          failureCount: 5,
          lastFailureTime: Date.parse('2026-03-26T12:00:00.000Z'),
          successCount: 0,
          lastOpenedAt: Date.parse('2026-03-26T12:00:00.000Z'),
          lastHalfOpenAt: 0,
          lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
          healthy: false,
          constants: { CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000 }
        },
        cache: { enabled: true },
        lastHealthCheck: '2026-03-26T12:00:00.000Z',
        defaults: { maxTokens: 1024 },
        providerRuntime: {
          configSource: 'OPENAI_API_KEY',
          configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
          lastReloadAt: '2026-03-26T11:59:00.000Z',
          reloadCount: 1,
          lastAttemptAt: '2026-03-26T12:00:00.000Z',
          lastSuccessAt: null,
          lastFailureAt: '2026-03-26T12:00:00.000Z',
          lastFailureReason: 'Quota exceeded',
          lastFailureCategory: 'rate_limited',
          lastFailureStatus: 429,
          consecutiveFailures: 1,
          backoffMs: 1000,
          nextRetryAt: '2026-03-26T12:00:01.000Z'
        }
      });

    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_quota_failure',
      observation: createObservation()
    });
    const providerSnapshot = buildPredictiveHealingAIProviderStatusSnapshot();

    expect(result.decision.advisor).toBe('rules_fallback_v1');
    expect(result.decision.details).toMatchObject({
      aiFallbackReason: expect.stringMatching(/quota|provider_failure_backoff/i),
      aiProviderFailureCategory: expect.stringMatching(/^(rate_limited|insufficient_quota)$/),
      aiProviderFailureStatus: 429,
      aiProviderCircuitBreakerState: 'OPEN'
    });
    expect(providerSnapshot).toMatchObject({
      configured: true,
      reachable: true,
      authenticated: true,
      completionHealthy: false,
      lastFailureCategory: expect.stringMatching(/^(rate_limited|insufficient_quota)$/),
      lastFailureStatus: 429,
      circuitBreakerState: 'OPEN',
      circuitBreakerFailures: 5
    });
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AI_PROVIDER_CALL_ATTEMPT' }));
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AI_PROVIDER_CALL_FAILURE' }));
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CIRCUIT_BREAKER_OPENED' }));
  });

  it('does not manufacture provider reinitialization from a no-incident diagnosis', async () => {
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: { models: { list: jest.fn() } }
    });
    runArcanosCoreQueryMock.mockRejectedValue(Object.assign(
      new Error('401 Incorrect API key provided: sk-test'),
      { status: 401 }
    ));
    getOpenAIServiceHealthMock
      .mockReturnValueOnce({
        apiKey: { configured: true, status: 'valid', source: 'OPENAI_API_KEY' },
        client: { initialized: true, model: 'gpt-4.1', timeout: 8000, baseURL: 'https://api.openai.com/v1' },
        circuitBreaker: {
          state: 'CLOSED',
          failureCount: 0,
          lastFailureTime: 0,
          successCount: 0,
          lastOpenedAt: 0,
          lastHalfOpenAt: 0,
          lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
          healthy: true,
          constants: { CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000 }
        },
        cache: { enabled: true },
        lastHealthCheck: '2026-03-26T11:59:30.000Z',
        defaults: { maxTokens: 1024 },
        providerRuntime: {
          configSource: 'OPENAI_API_KEY',
          configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
          lastReloadAt: '2026-03-26T11:59:00.000Z',
          reloadCount: 1,
          lastAttemptAt: '2026-03-26T11:59:30.000Z',
          lastSuccessAt: '2026-03-26T11:59:30.000Z',
          lastFailureAt: null,
          lastFailureReason: null,
          lastFailureCategory: null,
          lastFailureStatus: null,
          consecutiveFailures: 0,
          backoffMs: 0,
          nextRetryAt: null
        }
      })
      .mockReturnValue({
        apiKey: { configured: true, status: 'valid', source: 'OPENAI_API_KEY' },
        client: { initialized: true, model: 'gpt-4.1', timeout: 8000, baseURL: 'https://api.openai.com/v1' },
        circuitBreaker: {
          state: 'CLOSED',
          failureCount: 1,
          lastFailureTime: Date.parse('2026-03-26T12:00:00.000Z'),
          successCount: 0,
          lastOpenedAt: 0,
          lastHalfOpenAt: 0,
          lastClosedAt: Date.parse('2026-03-26T11:59:30.000Z'),
          healthy: true,
          constants: { CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000 }
        },
        cache: { enabled: true },
        lastHealthCheck: '2026-03-26T12:00:00.000Z',
        defaults: { maxTokens: 1024 },
        providerRuntime: {
          configSource: 'OPENAI_API_KEY',
          configVersion: 'OPENAI_API_KEY|10|1234|https://api.openai.com/v1|gpt-4.1',
          lastReloadAt: '2026-03-26T11:59:00.000Z',
          reloadCount: 1,
          lastAttemptAt: '2026-03-26T12:00:00.000Z',
          lastSuccessAt: null,
          lastFailureAt: '2026-03-26T12:00:00.000Z',
          lastFailureReason: '401 Incorrect API key provided: sk-test',
          lastFailureCategory: 'authentication',
          lastFailureStatus: 401,
          consecutiveFailures: 1,
          backoffMs: 1000,
          nextRetryAt: '2026-03-26T12:00:01.000Z'
        }
      });

    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_auth_failure',
      observation: createObservation({
        requestCount: 1,
        errorRate: 0,
        timeoutRate: 0,
        avgLatencyMs: 120,
        p95LatencyMs: 150,
        maxLatencyMs: 180,
        workerHealth: {
          ...createObservation().workerHealth,
          overallStatus: 'healthy',
          pending: 0,
          running: 0
        }
      }),
      execute: true
    });

    expect(result.decision).toMatchObject({
      advisor: 'rules_fallback_v1',
      action: 'none',
      safeToExecute: false
    });
    expect(result.decision.details).toMatchObject({
      aiFallbackReason: 'no_actionable_incident',
      aiProviderFailureCategory: 'authentication'
    });
    expect(reinitializeOpenAIProviderMock).not.toHaveBeenCalled();
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(result.execution.attempted).toBe(false);
  });

  it('does not attempt authentication on a quiet observation with no incident', async () => {
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: {}
    });
    runArcanosCoreQueryMock
      .mockRejectedValueOnce(Object.assign(new Error('Incorrect API key provided'), { status: 401 }))
      .mockResolvedValue({
        result: JSON.stringify({
          selectedCandidateIndex: null,
          chooseNoAction: true,
          reason: 'No action required.',
          safeToExecute: false,
          confidence: 0.1
        }),
        activeModel: 'gpt-4.1',
        fallbackFlag: false,
        fallbackSummary: {
          fallbackReasons: []
        }
      });

    await runPredictiveHealingDecision({
      source: 'predictive_test_auth_failure_first',
      observation: createObservation({
        requestCount: 0,
        workerHealth: {
          ...createObservation().workerHealth,
          pending: 0,
          running: 0,
          alertCount: 0
        }
      })
    });
    const result = await runPredictiveHealingDecision({
      source: 'predictive_test_auth_failure_second',
      observation: createObservation({
        requestCount: 0,
        workerHealth: {
          ...createObservation().workerHealth,
          pending: 0,
          running: 0,
          alertCount: 0
        }
      })
    });

    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(result.decision.details).toMatchObject({
      aiEligibilityReason: 'no_actionable_incident'
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'self_heal.ai_diagnosis.skipped',
      expect.objectContaining({
        source: 'predictive_test_auth_failure_second',
        reason: 'no_actionable_incident'
      })
    );
  });

  it('separates auth reachability from completion health in the provider probe', async () => {
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: {
        models: {
          list: jest.fn().mockResolvedValue({ data: [] })
        }
      }
    });
    createSingleChatCompletionMock.mockRejectedValue(
      Object.assign(new Error('You exceeded your current quota.'), { status: 429 })
    );

    const probe = await probePredictiveHealingAIProvider();

    expect(probe).toMatchObject({
      configured: true,
      clientInitialized: true,
      reachable: true,
      authenticated: true,
      completionHealthy: false,
      failureCategory: 'insufficient_quota',
      failureStatus: 429
    });
  });

  it('latches revoked credentials after one incident diagnosis across twenty retries and local state resets', async () => {
    runArcanosCoreQueryMock.mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));
    for (let tick = 0; tick < 20; tick += 1) {
      const result = await runPredictiveHealingDecision({
        source: 'auth_retry', observation: createObservation({ collectedAt: new Date().toISOString(), errorRate: 0.8 })
      });
      expect(result.execution.attempted).toBe(false);
      jest.setSystemTime(Date.now() + 7 * 60 * 60_000);
      // Process-local status cannot unlock the shared credential latch.
      resetPredictiveHealingStateForTests();
    }
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(reinitializeOpenAIProviderMock).not.toHaveBeenCalled();
  });

  it('returns deterministic diagnosis without a key and does not record a provider attempt', async () => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), openaiApiKey: undefined });
    await runPredictiveHealingDecision({ source: 'missing_key', observation: createObservation({ errorRate: 0.8 }) });
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(recordSelfHealEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'AI_PROVIDER_CALL_ATTEMPT' }));
  });

  it('admits manual diagnosis explicitly while predictive automation and repair execution are disabled', async () => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), predictiveHealingEnabled: false, selfImproveEnabled: false });
    const result = await runPredictiveHealingDecision({
      source: 'authorized_operator', inferenceAuthorization: 'manual',
      observation: createObservation({ errorRate: 0.8 })
    });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(result.execution.attempted).toBe(false);
  });

  it('admits diagnosis when repair execution is disabled and keeps repair authority independent', async () => {
    getConfigMock.mockReturnValue({ ...getConfigMock(), selfImproveEnabled: false, autoExecuteHealing: false });
    const result = await runPredictiveHealingDecision({ source: 'diagnosis_only', observation: createObservation({ errorRate: 0.8 }) });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(result.execution.attempted).toBe(false);
  });

  it('does not duplicate concurrent inference and permits retry only after the active cooldown', async () => {
    let finish!: (value: unknown) => void;
    const response = { result: JSON.stringify({ selectedCandidateIndex: null, chooseNoAction: true, reason: 'Observe.', safeToExecute: false }),
      activeModel: 'gpt-4.1', fallbackFlag: false, fallbackSummary: { fallbackReasons: [] } };
    runArcanosCoreQueryMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const observation = createObservation({ errorRate: 0.8 });
    const first = runPredictiveHealingDecision({ source: 'parallel_first', observation });
    for (let flush = 0; flush < 10 && !finish; flush += 1) await Promise.resolve();
    const second = await runPredictiveHealingDecision({ source: 'parallel_second', observation });
    expect(second.decision.details.aiCooldownReason).toBe('in_flight');
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    finish(response);
    await first;
    jest.setSystemTime(Date.now() + 1_799_999);
    await runPredictiveHealingDecision({ source: 'before_expiry', observation: { ...observation, collectedAt: new Date().toISOString() } });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 1);
    await runPredictiveHealingDecision({ source: 'after_expiry', observation: { ...observation, collectedAt: new Date().toISOString() } });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(2);
  });

  it('applies the failure cooldown to unsuccessful diagnoses independently of old provider health', async () => {
    runArcanosCoreQueryMock.mockRejectedValueOnce(new Error('provider error'));
    const observation = createObservation({ errorRate: 0.8 });
    await runPredictiveHealingDecision({ source: 'failed_provider', observation });
    jest.setSystemTime(Date.now() + 30 * 60_000);
    const retry = await runPredictiveHealingDecision({ source: 'failed_provider_retry', observation: { ...observation, collectedAt: new Date().toISOString() } });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(retry.decision.details).toMatchObject({ aiCooldownReason: 'provider_failure_backoff', aiCooldownMs: 21_600_000 });
    jest.setSystemTime(Date.now() + 6 * 60 * 60_000);
    await runPredictiveHealingDecision({ source: 'failure_expired', observation: { ...observation, collectedAt: new Date().toISOString() } });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(2);
  });

  it('retains the circuit breaker and never invokes AI for simulations', async () => {
    getOpenAIServiceHealthMock.mockReturnValue({ ...getOpenAIServiceHealthMock(), circuitBreaker: {
      ...getOpenAIServiceHealthMock().circuitBreaker, state: 'OPEN', lastFailureTime: Date.now()
    } });
    await runPredictiveHealingDecision({ source: 'circuit', observation: createObservation({ errorRate: 0.8 }) });
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    await runPredictiveHealingDecision({ source: 'simulation', inferenceAuthorization: 'manual', dryRun: true,
      observation: createObservation({ errorRate: 0.8 }), simulate: { errorRate: 0.9 } });
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
  });

  it('bounds explicit provider probes and retains authentication failure without retrying', async () => {
    const list = jest.fn().mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    await probePredictiveHealingAIProvider();
    await probePredictiveHealingAIProvider();
    expect(list).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletionMock).not.toHaveBeenCalled();
  });

  it.each(['diagnosis', 'provider_probe'])('shares a durable %s authentication rejection with the other purpose without waiting for health telemetry', async firstPurpose => {
    const list = jest.fn().mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    runArcanosCoreQueryMock.mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));
    const observation = createObservation({ errorRate: 0.8 });
    if (firstPurpose === 'diagnosis') {
      await runPredictiveHealingDecision({ source: 'cross_purpose_auth', observation });
      resetPredictiveHealingStateForTests();
      expect((await probePredictiveHealingAIProvider()).failureReason).toBe('authentication_blocked');
      expect(list).not.toHaveBeenCalled();
      expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    } else {
      await probePredictiveHealingAIProvider();
      resetPredictiveHealingStateForTests();
      const denied = await runPredictiveHealingDecision({ source: 'cross_purpose_auth', observation });
      expect(denied.decision.details.aiCooldownReason).toBe('provider_failure_backoff');
      expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(1);
    }
    expect(getOpenAIServiceHealthMock().providerRuntime.authenticationBlocked).not.toBe(true);
    expect(createSingleChatCompletionMock).not.toHaveBeenCalled();
    expect(inferenceStates.size).toBe(1);
  });

  it('admits two explicit probes 60 seconds apart independently of diagnosis and keeps the rolling cap', async () => {
    const list = jest.fn().mockResolvedValue({ data: [] });
    const create = jest.fn().mockResolvedValue({ output_text: 'ok' });
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list }, responses: { create } } });
    createSingleChatCompletionMock.mockImplementation((client, params) => client.responses.create({
      model: params.model, input: 'synthetic probe', max_output_tokens: params.max_completion_tokens
    }));
    await runPredictiveHealingDecision({ source: 'diagnosis_before_probe', observation: createObservation({ errorRate: 0.8 }) });
    expect((await probePredictiveHealingAIProvider()).completionHealthy).toBe(true);
    jest.setSystemTime(Date.now() + 59_999);
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('cooldown');
    jest.setSystemTime(Date.now() + 1);
    expect((await probePredictiveHealingAIProvider()).completionHealthy).toBe(true);
    jest.setSystemTime(Date.now() + 60_000);
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('budget_exhausted');
    expect(list).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_output_tokens: 16, stream: false }),
      expect.objectContaining({ maxRetries: 0, timeout: 30_000 }));
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('allows explicit verification of a rotated synthetic credential after 60 seconds without resetting the probe budget', async () => {
    const list = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Invalid API key'), { status: 401 }))
      .mockResolvedValue({ data: [] });
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    createSingleChatCompletionMock.mockResolvedValue({});
    await probePredictiveHealingAIProvider();
    getConfigMock.mockReturnValue({ ...getConfigMock(), openaiApiKey: 'test-synthetic-rotated-credential' });
    jest.setSystemTime(Date.now() + 59_999);
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('cooldown');
    jest.setSystemTime(Date.now() + 1);
    expect((await probePredictiveHealingAIProvider()).completionHealthy).toBe(true);
    jest.setSystemTime(Date.now() + 60_000);
    getConfigMock.mockReturnValue({ ...getConfigMock(), openaiApiKey: 'test-synthetic-another-credential' });
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('budget_exhausted');
    getConfigMock.mockReturnValue({ ...getConfigMock(), openaiApiKey: 'test-synthetic-offline-credential' });
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('authentication_blocked');
    expect(list).toHaveBeenCalledTimes(2);
    expect(createSingleChatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('does not release an uncertain probe on cooldown expiry, process reset or credential rotation', async () => {
    const list = jest.fn().mockResolvedValue({ data: [] });
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    createSingleChatCompletionMock.mockRejectedValue(new Error('Provider request timed out'));
    await probePredictiveHealingAIProvider();
    jest.setSystemTime(Date.now() + 7 * 60 * 60_000);
    resetPredictiveHealingStateForTests();
    getConfigMock.mockReturnValue({ ...getConfigMock(), openaiApiKey: 'test-synthetic-rotated-credential' });
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('in_flight');
    expect(list).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Connection error.'), Object.assign(new Error('Server failed after acceptance'), { status: 500 })])(
    'retains an ambiguous paid probe transport failure instead of retrying: %s', async failure => {
      const list = jest.fn().mockResolvedValue({ data: [] });
      const create = jest.fn().mockRejectedValue(failure);
      getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list }, responses: { create } } });
      createSingleChatCompletionMock.mockImplementation(client => client.responses.create({ model: 'gpt-4.1', input: 'synthetic probe' }));
      await probePredictiveHealingAIProvider();
      jest.setSystemTime(Date.now() + 7 * 60 * 60_000);
      expect((await probePredictiveHealingAIProvider()).failureReason).toBe('in_flight');
      expect(create).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['diagnosis', 'provider_probe'])('refuses a credential changed while %s admission was awaiting Redis', async purpose => {
    const list = jest.fn().mockResolvedValue({ data: [] });
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    afterInferenceReservation = () => getConfigMock.mockReturnValue({
      ...getConfigMock(), openaiApiKey: 'test-synthetic-rotated-during-admission'
    });
    if (purpose === 'diagnosis') {
      const result = await runPredictiveHealingDecision({ source: 'credential_race', observation: createObservation({ errorRate: 0.8 }) });
      expect(result.decision.details.aiFallbackReason).toBe('inference_credential_changed');
    } else {
      expect((await probePredictiveHealingAIProvider()).failureReason).toBe('inference_credential_changed');
    }
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(createSingleChatCompletionMock).not.toHaveBeenCalled();
    const state = JSON.parse(inferenceStates.get(purpose)!);
    expect(state.inFlight).toBe(null);
    expect(state.attemptTimestampsMs).toHaveLength(1);
  });

  it('completes a reservation when local client initialization throws before transport', async () => {
    getOpenAIClientOrAdapterMock.mockImplementationOnce(() => { throw new Error('Synthetic strict client unconfigured'); });
    const result = await runPredictiveHealingDecision({ source: 'client_initialization', observation: createObservation({ errorRate: 0.8 }) });
    expect(result.decision.details.aiFallbackReason).toBe('openai_client_unavailable');
    const state = JSON.parse(inferenceStates.get('diagnosis')!);
    expect(state.inFlight).toBe(null);
    expect(state.lastFailureMs).toBe(Date.now());
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
  });

  it.each(['authentication', 'circuit'])('keeps the %s gate ahead of explicit probe admission', async gate => {
    const list = jest.fn().mockResolvedValue({ data: [] });
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    const health = getOpenAIServiceHealthMock();
    getOpenAIServiceHealthMock.mockReturnValue({ ...health,
      providerRuntime: { ...health.providerRuntime, authenticationBlocked: gate === 'authentication' },
      circuitBreaker: { ...health.circuitBreaker,
        state: gate === 'circuit' ? 'OPEN' : 'CLOSED', lastFailureTime: Date.now() }
    });
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('provider_authentication_or_circuit_blocked');
    expect(list).not.toHaveBeenCalled();
    expect(createSingleChatCompletionMock).not.toHaveBeenCalled();
    expect(inferenceStates.size).toBe(0);
  });

  it('permits the breaker to own a half-open retry after its reset window expires', async () => {
    getOpenAIServiceHealthMock.mockReturnValue({ ...getOpenAIServiceHealthMock(), circuitBreaker: {
      ...getOpenAIServiceHealthMock().circuitBreaker, state: 'OPEN', lastFailureTime: Date.now() - 30_000
    } });
    await runPredictiveHealingDecision({ source: 'half_open_retry', observation: createObservation({ errorRate: 0.8 }) });
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
  });

  it('recovery: a successful diagnosis supersedes an older provider failure before returning to healthy idle', async () => {
    const priorHealth = getOpenAIServiceHealthMock();
    getOpenAIServiceHealthMock.mockReturnValue({ ...priorHealth, providerRuntime: {
      ...priorHealth.providerRuntime,
      lastFailureAt: '2026-03-26T11:00:00.000Z', lastFailureCategory: 'network',
      lastFailureReason: 'fetch failed', lastFailureStatus: null
    } });
    await runPredictiveHealingDecision({ source: 'recovery_diagnosis', observation: createObservation({ errorRate: 0.8 }) });
    expect(buildPredictiveHealingAIProviderStatusSnapshot()).toMatchObject({
      lastFailureAt: '2026-03-26T11:00:00.000Z', lastFailureCategory: null,
      reachable: true, authenticated: true, completionHealthy: true
    });
    jest.setSystemTime(Date.now() + 7 * 60 * 60_000);
    const observation = createObservation({ collectedAt: new Date().toISOString(), requestCount: 0,
      errorRate: 0, avgLatencyMs: 0, p95LatencyMs: 0, maxLatencyMs: 0 });
    observation.workerHealth = { ...observation.workerHealth, overallStatus: 'healthy', pending: 0, running: 0 };
    const idle = await runPredictiveHealingDecision({ source: 'recovery_idle', observation });
    expect(idle.decision.action).toBe('none');
    expect(idle.execution.attempted).toBe(false);
    expect(runArcanosCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(reinitializeOpenAIProviderMock).not.toHaveBeenCalled();
    getOpenAIServiceHealthMock.mockReturnValue({ ...priorHealth, providerRuntime: {
      ...priorHealth.providerRuntime, lastFailureAt: new Date().toISOString(),
      lastFailureCategory: 'network', lastFailureReason: 'new fetch failed', lastFailureStatus: null
    } });
    expect(buildPredictiveHealingAIProviderStatusSnapshot()).toMatchObject({
      lastFailureCategory: 'network', reachable: false, completionHealthy: false
    });
  });

  it('recovery: a successful manual probe clears its earlier transient failure without an idle diagnosis', async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({});
    getOpenAIClientOrAdapterMock.mockReturnValue({ client: { models: { list } } });
    await probePredictiveHealingAIProvider();
    expect(buildPredictiveHealingAIProviderStatusSnapshot().lastFailureCategory).toBe('network');
    jest.setSystemTime(Date.now() + 59_999);
    expect((await probePredictiveHealingAIProvider()).failureReason).toBe('cooldown');
    expect(list).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 1);
    createSingleChatCompletionMock.mockResolvedValue({});
    const probe = await probePredictiveHealingAIProvider();
    expect(probe.failureCategory).toBe(null);
    expect(buildPredictiveHealingAIProviderStatusSnapshot()).toMatchObject({
      lastFailureCategory: null, reachable: true, authenticated: true, completionHealthy: true
    });
    const observation = createObservation({ collectedAt: new Date().toISOString(), requestCount: 0,
      errorRate: 0, avgLatencyMs: 0, p95LatencyMs: 0, maxLatencyMs: 0 });
    observation.workerHealth = { ...observation.workerHealth, overallStatus: 'healthy', pending: 0, running: 0 };
    const idle = await runPredictiveHealingDecision({ source: 'recovery_probe_idle', observation });
    expect(idle.decision.action).toBe('none');
    expect(runArcanosCoreQueryMock).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(createSingleChatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('recovery: a failure sharing the last success millisecond remains unhealthy', async () => {
    const health = getOpenAIServiceHealthMock();
    getOpenAIServiceHealthMock.mockReturnValue({ ...health, providerRuntime: {
      ...health.providerRuntime, lastSuccessAt: new Date().toISOString(),
      lastFailureAt: new Date().toISOString(), lastFailureCategory: 'network',
      lastFailureReason: 'fetch failed', lastFailureStatus: null
    } });
    resetPredictiveHealingStateForTests();
    expect(buildPredictiveHealingAIProviderStatusSnapshot()).toMatchObject({
      lastFailureCategory: 'network', reachable: false, completionHealthy: false
    });
  });
});
