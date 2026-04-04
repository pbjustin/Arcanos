import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getConfigMock = jest.fn();
const scaleWorkersUpMock = jest.fn();
const recycleWorkerMock = jest.fn();
const healWorkerRuntimeMock = jest.fn();
const recordSelfHealEventMock = jest.fn();
const activateTrinitySelfHealingMitigationMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const runArcanosCoreQueryMock = jest.fn();
const getOpenAIServiceHealthMock = jest.fn();
const reinitializeOpenAIProviderMock = jest.fn();
const createSingleChatCompletionMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();

function createStructuredLoggerMock() {
  const channel = {
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
  getEnvVar: jest.fn()
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: structuredLoggerMock,
  aiLogger: structuredLoggerMock,
  apiLogger: structuredLoggerMock,
  dbLogger: structuredLoggerMock,
  workerLogger: structuredLoggerMock,
  default: structuredLoggerMock
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
    jest.useFakeTimers().setSystemTime(new Date('2026-03-26T12:00:00.000Z'));
    jest.clearAllMocks();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: null
    });
    runArcanosCoreQueryMock.mockReset();
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
      predictiveHealingEnabled: true,
      predictiveHealingDryRun: false,
      autoExecuteHealing: false,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
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
      predictiveHealingEnabled: false,
      predictiveHealingDryRun: true,
      autoExecuteHealing: false,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
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
      predictiveHealingEnabled: true,
      predictiveHealingDryRun: false,
      autoExecuteHealing: true,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
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
      predictiveHealingEnabled: true,
      predictiveHealingDryRun: false,
      autoExecuteHealing: true,
      predictiveHealingObservationHistoryLimit: 12,
      predictiveHealingAuditHistoryLimit: 25,
      predictiveHealingActionCooldownMs: 60000,
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
      aiFallbackReason: expect.stringContaining('quota'),
      aiProviderFailureCategory: 'insufficient_quota',
      aiProviderFailureStatus: 429,
      aiProviderCircuitBreakerState: 'OPEN'
    });
    expect(providerSnapshot).toMatchObject({
      configured: true,
      reachable: true,
      authenticated: true,
      completionHealthy: false,
      lastFailureCategory: 'insufficient_quota',
      lastFailureStatus: 429,
      circuitBreakerState: 'OPEN',
      circuitBreakerFailures: 5
    });
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AI_PROVIDER_CALL_ATTEMPT' }));
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AI_PROVIDER_CALL_FAILURE' }));
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CIRCUIT_BREAKER_OPENED' }));
  });

  it('promotes the first authentication fallback into provider reinitialization', async () => {
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
      action: 'reinitialize_ai_provider',
      target: 'ai_provider',
      matchedRule: 'ai_provider_authentication_reinitialize',
      safeToExecute: true
    });
    expect(result.decision.details).toMatchObject({
      aiFallbackReason: expect.stringContaining('Incorrect API key'),
      aiProviderFailureCategory: 'authentication',
      aiFallbackPromotedAction: 'reinitialize_ai_provider'
    });
    expect(reinitializeOpenAIProviderMock).toHaveBeenCalledWith({
      forceReload: true,
      ignoreBackoff: true,
      source: 'predictive_test_auth_failure'
    });
    expect(result.execution.status).toBe('executed');
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
});
