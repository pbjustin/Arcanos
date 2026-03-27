import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getConfigMock = jest.fn();
const scaleWorkersUpMock = jest.fn();
const recycleWorkerMock = jest.fn();
const healWorkerRuntimeMock = jest.fn();
const recordSelfHealEventMock = jest.fn();

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: jest.fn(),
  scaleWorkersUp: scaleWorkersUpMock,
  recycleWorker: recycleWorkerMock
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock
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
  healWorkerRuntime: healWorkerRuntimeMock
}));

jest.unstable_mockModule('../src/services/selfImprove/selfHealTelemetry.js', () => ({
  recordSelfHealEvent: recordSelfHealEventMock
}));

const {
  buildPredictiveHealingStatusSnapshot,
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
    workerHealthError: null
  };
}

describe('predictive healing execution', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-26T12:00:00.000Z'));
    jest.clearAllMocks();
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
      predictiveQueueVelocityThreshold: 2
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
    resetPredictiveHealingStateForTests();
  });

  afterEach(() => {
    delete process.env.SELF_HEAL_LOOP_INTERVAL_MS;
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
      predictiveQueueVelocityThreshold: 2
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

    expect(result.decision.action).toBe('none');
    expect(result.execution.status).toBe('skipped');
    expect(result.execution.message).toContain('disabled');
    expect(scaleWorkersUpMock).not.toHaveBeenCalled();
    expect(recordSelfHealEventMock).not.toHaveBeenCalled();
    expect(buildPredictiveHealingStatusSnapshot().recentAuditCount).toBe(0);
  });

  it('summarizes automated loop decisions and outcomes in status output', async () => {
    process.env.SELF_HEAL_LOOP_INTERVAL_MS = '15000';
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
      predictiveQueueVelocityThreshold: 2
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
  });
});
