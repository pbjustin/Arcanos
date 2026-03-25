import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getConfigMock = jest.fn();
const runSelfImproveCycleMock = jest.fn();
const getTrinitySelfHealingStatusMock = jest.fn();
const activateTrinitySelfHealingMitigationMock = jest.fn();
const rollbackTrinitySelfHealingMitigationMock = jest.fn();
const getPromptRouteMitigationStateMock = jest.fn();
const activatePromptRouteDegradedModeMock = jest.fn();
const rollbackPromptRouteDegradedModeMock = jest.fn();
const resetPromptRouteMitigationStateForTestsMock = jest.fn();
const getWorkerControlHealthMock = jest.fn();
const healWorkerRuntimeMock = jest.fn();
const getWorkerRuntimeStatusMock = jest.fn();
const getRollingRequestWindowMock = jest.fn();
const getRequestWindowSinceMock = jest.fn();
const getTelemetrySnapshotMock = jest.fn();
const getOpenAIServiceHealthMock = jest.fn();
const recoverStaleJobsMock = jest.fn();
const getWorkerAutonomySettingsMock = jest.fn();

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock
}));

jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({
  runSelfImproveCycle: runSelfImproveCycleMock
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingStatus: getTrinitySelfHealingStatusMock,
  activateTrinitySelfHealingMitigation: activateTrinitySelfHealingMitigationMock,
  rollbackTrinitySelfHealingMitigation: rollbackTrinitySelfHealingMitigationMock
}));

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  getPromptRouteMitigationState: getPromptRouteMitigationStateMock,
  activatePromptRouteDegradedMode: activatePromptRouteDegradedModeMock,
  rollbackPromptRouteDegradedMode: rollbackPromptRouteDegradedModeMock,
  resetPromptRouteMitigationStateForTests: resetPromptRouteMitigationStateForTestsMock
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: getWorkerControlHealthMock,
  healWorkerRuntime: healWorkerRuntimeMock
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock
}));

jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    getRollingRequestWindow: getRollingRequestWindowMock,
    getRequestWindowSince: getRequestWindowSinceMock
  }
}));

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: getTelemetrySnapshotMock,
  recordLogEvent: jest.fn(),
  recordTraceEvent: jest.fn(),
  markOperation: jest.fn(),
  onTelemetry: jest.fn(),
  resetTelemetry: jest.fn()
}));

jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: getOpenAIServiceHealthMock
}));

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  recoverStaleJobs: recoverStaleJobsMock
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomySettings: getWorkerAutonomySettingsMock
}));

const {
  getSelfHealingLoopStatus,
  resetSelfHealingLoopStateForTests,
  runSelfHealingLoop,
  startSelfHealingLoop
} = await import('../src/services/selfImprove/selfHealingLoop.js');

function createConfig(overrides: Record<string, unknown> = {}) {
  return {
    selfImproveEnabled: false,
    selfImproveActuatorMode: 'pr_bot',
    selfImproveFrozen: false,
    selfImproveAutonomyLevel: 0,
    ...overrides
  };
}

function createWorkerRuntime(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    model: 'gpt-4o',
    configuredCount: 4,
    started: true,
    activeListeners: 1,
    workerIds: ['arcanos-worker-1'],
    totalDispatched: 0,
    ...overrides
  };
}

function createWorkerHealth(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-03-25T12:00:00.000Z',
    overallStatus: 'healthy',
    queueSummary: {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0
    },
    workers: [],
    alerts: [],
    settings: {
      heartbeatIntervalMs: 1000,
      leaseMs: 5000,
      defaultMaxRetries: 3,
      retryBackoffBaseMs: 1000,
      retryBackoffMaxMs: 5000,
      staleAfterMs: 60000
    },
    queueSemantics: {
      failedCountMode: 'retained_terminal_jobs',
      failedCountDescription: 'retained failures',
      activeFailureSignals: ['running']
    },
    retryPolicy: {
      defaultMaxRetries: 3,
      retryBackoffBaseMs: 1000,
      retryBackoffMaxMs: 5000,
      staleAfterMs: 60000
    },
    recentFailedJobs: [],
    ...overrides
  };
}

function createTrinityStatus(activeAction: string | null = null) {
  return {
    enabled: true,
    config: {
      triggerThreshold: 3,
      windowMs: 300000,
      maxAttempts: 3,
      cooldownMs: 120000,
      actionTtlMs: 600000,
      verifySuccessThreshold: 3,
      verifyFailureThreshold: 2
    },
    snapshot: {
      intake: { activeAction: null },
      reasoning: { activeAction },
      final: { activeAction: null }
    }
  };
}

function createRequestWindow(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-03-25T12:00:00.000Z',
    windowMs: 300000,
    requestCount: 0,
    errorCount: 0,
    clientErrorCount: 0,
    serverErrorCount: 0,
    errorRate: 0,
    timeoutCount: 0,
    timeoutRate: 0,
    slowRequestCount: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    maxLatencyMs: 0,
    routes: [],
    ...overrides
  };
}

function createTelemetrySnapshot(eventNames: string[] = []) {
  return {
    generatedAt: '2026-03-25T12:00:00.000Z',
    metrics: {
      totalLogs: 0,
      logsByLevel: { debug: 0, info: 0, warn: 0, error: 0 },
      operations: {}
    },
    traces: {
      recentLogs: [],
      recentEvents: eventNames.map((name, index) => ({
        id: `trace-${index}`,
        timestamp: '2026-03-25T12:00:00.000Z',
        name,
        attributes: {}
      }))
    }
  };
}

function createOpenAIHealth(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: { configured: true, status: 'valid', source: 'env' },
    client: { initialized: true, model: 'gpt-4.1', timeout: 30000, baseURL: 'https://api.openai.com' },
    circuitBreaker: {
      state: 'CLOSED',
      failureCount: 0,
      successCount: 0,
      totalRequests: 0,
      lastFailureTime: null,
      healthy: true
    },
    cache: { enabled: true, size: 0, hitRate: 0 },
    lastHealthCheck: '2026-03-25T12:00:00.000Z',
    defaults: { maxTokens: 1024 },
    ...overrides
  };
}

describe('selfHealingLoop', () => {
  const envKeys = [
    'NODE_ENV',
    'SELF_HEAL_LOOP_INTERVAL_MS',
    'SELF_HEAL_ACTION_COOLDOWN_MS',
    'SELF_HEAL_CONTROLLER_COOLDOWN_MS',
    'SELF_HEAL_VERIFICATION_DELAY_MS'
  ] as const;
  const originalEnv = new Map<string, string | undefined>();
  let trinityActiveAction: string | null;
  let promptRouteMitigationActive: boolean;
  let promptRouteMitigationReason: string | null;
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
    trinityActiveAction = null;
    promptRouteMitigationActive = false;
    promptRouteMitigationReason = null;

    for (const envKey of envKeys) {
      originalEnv.set(envKey, process.env[envKey]);
      delete process.env[envKey];
    }

    process.env.NODE_ENV = 'test';
    getConfigMock.mockReturnValue(createConfig());
    getWorkerRuntimeStatusMock.mockReturnValue(createWorkerRuntime());
    getWorkerControlHealthMock.mockResolvedValue(createWorkerHealth());
    healWorkerRuntimeMock.mockResolvedValue({
      timestamp: '2026-03-25T12:00:01.000Z',
      requestedForce: true,
      restart: { started: true, alreadyRunning: false, message: 'Workers started successfully.' },
      runtime: createWorkerRuntime({ started: true })
    });
    getRollingRequestWindowMock.mockReturnValue(createRequestWindow());
    getRequestWindowSinceMock.mockReturnValue(createRequestWindow());
    getTelemetrySnapshotMock.mockReturnValue(createTelemetrySnapshot());
    getOpenAIServiceHealthMock.mockReturnValue(createOpenAIHealth());
    recoverStaleJobsMock.mockResolvedValue({
      recoveredJobs: [],
      failedJobs: []
    });
    getWorkerAutonomySettingsMock.mockReturnValue({
      workerId: 'async-queue',
      workerType: 'async_queue',
      heartbeatIntervalMs: 10000,
      leaseMs: 30000,
      inspectorIntervalMs: 30000,
      staleAfterMs: 60000,
      defaultMaxRetries: 2,
      retryBackoffBaseMs: 2000,
      retryBackoffMaxMs: 60000,
      maxJobsPerHour: 120,
      maxAiCallsPerHour: 120,
      maxRssMb: 2048,
      queueDepthDeferralThreshold: 25,
      queueDepthDeferralMs: 5000,
      failureWebhookUrl: null,
      failureWebhookThreshold: 3,
      failureWebhookCooldownMs: 300000
    });
    getTrinitySelfHealingStatusMock.mockImplementation(() => createTrinityStatus(trinityActiveAction));
    getPromptRouteMitigationStateMock.mockImplementation(() => ({
      active: promptRouteMitigationActive,
      mode: promptRouteMitigationActive ? 'degraded_response' : null,
      route: '/api/openai/prompt',
      activatedAt: promptRouteMitigationActive ? '2026-03-25T12:00:00.000Z' : null,
      updatedAt: promptRouteMitigationActive ? '2026-03-25T12:00:00.000Z' : null,
      reason: promptRouteMitigationReason
    }));
    activateTrinitySelfHealingMitigationMock.mockImplementation(() => {
      trinityActiveAction = 'enable_degraded_mode';
      return {
        applied: true,
        rolledBack: false,
        stage: 'reasoning',
        action: 'enable_degraded_mode',
        reason: 'applied',
        activeAction: 'enable_degraded_mode',
        verified: false,
        expiresAtMs: Date.now() + 600000
      };
    });
    rollbackTrinitySelfHealingMitigationMock.mockImplementation(() => {
      trinityActiveAction = null;
      return {
        applied: false,
        rolledBack: true,
        stage: 'reasoning',
        action: 'enable_degraded_mode',
        reason: 'rolled_back',
        activeAction: null,
        verified: false,
        expiresAtMs: null
      };
    });
    activatePromptRouteDegradedModeMock.mockImplementation((reason: string) => {
      promptRouteMitigationActive = true;
      promptRouteMitigationReason = reason;
      return {
        applied: true,
        rolledBack: false,
        reason: 'applied',
        state: {
          active: true,
          mode: 'degraded_response',
          route: '/api/openai/prompt',
          activatedAt: '2026-03-25T12:00:00.000Z',
          updatedAt: '2026-03-25T12:00:00.000Z',
          reason
        }
      };
    });
    rollbackPromptRouteDegradedModeMock.mockImplementation((reason: string) => {
      promptRouteMitigationActive = false;
      promptRouteMitigationReason = reason;
      return {
        applied: false,
        rolledBack: true,
        reason: 'rolled_back',
        state: {
          active: false,
          mode: null,
          route: '/api/openai/prompt',
          activatedAt: null,
          updatedAt: '2026-03-25T12:00:00.000Z',
          reason
        }
      };
    });
    runSelfImproveCycleMock.mockResolvedValue({
      id: 'cycle-1',
      autonomyLevel: 1,
      frozen: false,
      drift: { kind: 'none', severity: 'low' },
      decision: 'NOOP',
      evidencePath: 'governance/evidence_packs/cycle-1.json'
    });

    resetSelfHealingLoopStateForTests();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetSelfHealingLoopStateForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();

    for (const envKey of envKeys) {
      const original = originalEnv.get(envKey);
      if (original === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = original;
      }
    }
  });

  it('starts exactly one interval even when bootstrap runs twice', async () => {
    process.env.SELF_HEAL_LOOP_INTERVAL_MS = '30000';
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    startSelfHealingLoop();
    startSelfHealingLoop();
    await jest.runOnlyPendingTimersAsync();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      active: true,
      loopRunning: true,
      startedAt: expect.any(String),
      tickCount: 2,
      intervalMs: 30000,
      lastDiagnosis: 'healthy'
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[SELF-HEAL] loop started'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[SELF-HEAL] start skipped; already running'));

    setIntervalSpy.mockRestore();
  });

  it('recovers stale jobs when the queue is stalled', async () => {
    getWorkerControlHealthMock.mockResolvedValueOnce(createWorkerHealth({
      overallStatus: 'unhealthy',
      queueSummary: {
        pending: 2,
        running: 1,
        completed: 0,
        failed: 0,
        total: 3,
        delayed: 0,
        stalledRunning: 2,
        oldestPendingJobAgeMs: 91000
      },
      alerts: ['Detected 2 stalled running job(s).']
    }));
    recoverStaleJobsMock.mockResolvedValueOnce({
      recoveredJobs: ['job-1'],
      failedJobs: []
    });

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(recoverStaleJobsMock).toHaveBeenCalledWith(expect.objectContaining({
      staleAfterMs: 60000,
      maxRetries: 2
    }));
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'worker stall detected',
      action: 'recoverStaleJobs:recovered=1:failed=0',
      controllerDecision: null
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastDiagnosis: 'worker stall detected',
      lastAction: 'recoverStaleJobs:recovered=1:failed=0',
      lastWorkerHealth: 'unhealthy',
      attemptsByDiagnosis: {
        worker_stall: 1
      }
    }));
  });

  it('activates degraded mode when a timeout storm is detected', async () => {
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 20,
      errorCount: 5,
      serverErrorCount: 5,
      errorRate: 0.25,
      timeoutCount: 4,
      timeoutRate: 0.2,
      slowRequestCount: 8,
      avgLatencyMs: 3100,
      p95LatencyMs: 6100,
      maxLatencyMs: 7900,
      routes: [
        { route: '/ask', requestCount: 10, errorCount: 3, timeoutCount: 2, avgLatencyMs: 3400, p95LatencyMs: 6300 }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(activateTrinitySelfHealingMitigationMock).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'reasoning',
      action: 'enable_degraded_mode'
    }));
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'timeout storm detected',
      action: 'activateTrinityMitigation:reasoning:enable_degraded_mode'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastDiagnosis: 'timeout storm detected',
      lastAction: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
      activeMitigation: 'reasoning:enable_degraded_mode',
      lastEvidence: expect.objectContaining({
        timeoutCount: 4,
        timeoutRate: 0.2
      })
    }));
  });

  it('activates prompt-route degraded mode when /api/openai/prompt dominates the incident window', async () => {
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 20,
      errorCount: 2,
      serverErrorCount: 2,
      errorRate: 0.1,
      timeoutCount: 0,
      timeoutRate: 0,
      slowRequestCount: 10,
      avgLatencyMs: 2800,
      p95LatencyMs: 7200,
      maxLatencyMs: 9100,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 16,
          errorCount: 2,
          timeoutCount: 0,
          avgLatencyMs: 3300,
          p95LatencyMs: 9100
        },
        {
          route: '/ask',
          requestCount: 4,
          errorCount: 0,
          timeoutCount: 0,
          avgLatencyMs: 650,
          p95LatencyMs: 900
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(activatePromptRouteDegradedModeMock).toHaveBeenCalledWith('latency spike cluster detected');
    expect(activateTrinitySelfHealingMitigationMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'latency spike cluster detected',
      action: 'activatePromptRouteMitigation:degraded_response'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'activatePromptRouteMitigation:degraded_response',
      activeMitigation: 'prompt:/api/openai/prompt:degraded_response',
      lastEvidence: expect.objectContaining({
        targetedRoute: expect.objectContaining({
          route: '/api/openai/prompt',
          requestCount: 16
        })
      })
    }));
  });

  it('rolls back an ineffective degraded-mode mitigation after verification', async () => {
    process.env.SELF_HEAL_VERIFICATION_DELAY_MS = '30000';
    getRollingRequestWindowMock
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 20,
        errorCount: 5,
        serverErrorCount: 5,
        errorRate: 0.25,
        timeoutCount: 4,
        timeoutRate: 0.2,
        slowRequestCount: 8,
        avgLatencyMs: 3200,
        p95LatencyMs: 6200,
        maxLatencyMs: 8000
      }))
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 18,
        errorCount: 6,
        serverErrorCount: 6,
        errorRate: 0.333,
        timeoutCount: 5,
        timeoutRate: 0.278,
        slowRequestCount: 8,
        avgLatencyMs: 3600,
        p95LatencyMs: 7100,
        maxLatencyMs: 8600
      }));

    await runSelfHealingLoop({ trigger: 'interval' });
    await jest.advanceTimersByTimeAsync(31000);
    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(rollbackTrinitySelfHealingMitigationMock).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'reasoning',
      action: 'enable_degraded_mode',
      reason: 'self_heal_verification_failed'
    }));
    expect(result.verificationResult).toEqual(expect.objectContaining({
      outcome: 'worse',
      action: 'activateTrinityMitigation:reasoning:enable_degraded_mode'
    }));
    expect(result.action).toBe('rollbackTrinityMitigation:reasoning:enable_degraded_mode');
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'rollbackTrinityMitigation:reasoning:enable_degraded_mode',
      activeMitigation: null,
      lastVerificationResult: expect.objectContaining({
        outcome: 'worse'
      })
    }));
  });

  it('rolls back an ineffective prompt-route mitigation after verification', async () => {
    process.env.SELF_HEAL_VERIFICATION_DELAY_MS = '30000';
    getRollingRequestWindowMock
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 18,
        errorCount: 2,
        serverErrorCount: 2,
        errorRate: 0.111,
        timeoutCount: 0,
        timeoutRate: 0,
        slowRequestCount: 10,
        avgLatencyMs: 2600,
        p95LatencyMs: 7600,
        maxLatencyMs: 9300,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 15,
            errorCount: 2,
            timeoutCount: 0,
            avgLatencyMs: 3100,
            p95LatencyMs: 9300
          }
        ]
      }))
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 18,
        errorCount: 2,
        serverErrorCount: 2,
        errorRate: 0.111,
        timeoutCount: 0,
        timeoutRate: 0,
        slowRequestCount: 10,
        avgLatencyMs: 2650,
        p95LatencyMs: 7600,
        maxLatencyMs: 9400,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 15,
            errorCount: 2,
            timeoutCount: 0,
            avgLatencyMs: 3150,
            p95LatencyMs: 9400
          }
        ]
      }));
    getRequestWindowSinceMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 4,
      errorCount: 1,
      serverErrorCount: 1,
      errorRate: 0.25,
      timeoutCount: 0,
      timeoutRate: 0,
      slowRequestCount: 4,
      avgLatencyMs: 3150,
      p95LatencyMs: 9400,
      maxLatencyMs: 9400,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 4,
          errorCount: 1,
          timeoutCount: 0,
          avgLatencyMs: 3150,
          p95LatencyMs: 9400
        }
      ]
    }));

    await runSelfHealingLoop({ trigger: 'interval' });
    await jest.advanceTimersByTimeAsync(31000);
    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(rollbackPromptRouteDegradedModeMock).toHaveBeenCalledWith('self_heal_verification_failed');
    expect(result.verificationResult).toEqual(expect.objectContaining({
      outcome: 'unchanged',
      action: 'activatePromptRouteMitigation:degraded_response'
    }));
    expect(result.action).toBe('rollbackPromptRouteMitigation:degraded_response');
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'rollbackPromptRouteMitigation:degraded_response',
      activeMitigation: null,
      lastVerificationResult: expect.objectContaining({
        outcome: 'unchanged'
      })
    }));
  });

  it('defers prompt-route verification when there is not enough post-action route traffic', async () => {
    process.env.SELF_HEAL_VERIFICATION_DELAY_MS = '30000';
    getRollingRequestWindowMock
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 18,
        errorCount: 2,
        serverErrorCount: 2,
        errorRate: 0.111,
        timeoutCount: 0,
        timeoutRate: 0,
        slowRequestCount: 10,
        avgLatencyMs: 2600,
        p95LatencyMs: 7600,
        maxLatencyMs: 9300,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 15,
            errorCount: 2,
            timeoutCount: 0,
            avgLatencyMs: 3100,
            p95LatencyMs: 9300
          }
        ]
      }))
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 18,
        errorCount: 2,
        serverErrorCount: 2,
        errorRate: 0.111,
        timeoutCount: 0,
        timeoutRate: 0,
        slowRequestCount: 10,
        avgLatencyMs: 2600,
        p95LatencyMs: 7600,
        maxLatencyMs: 9300,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 15,
            errorCount: 2,
            timeoutCount: 0,
            avgLatencyMs: 3100,
            p95LatencyMs: 9300
          }
        ]
      }));
    getRequestWindowSinceMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 1,
      errorCount: 0,
      serverErrorCount: 0,
      errorRate: 0,
      timeoutCount: 0,
      timeoutRate: 0,
      slowRequestCount: 0,
      avgLatencyMs: 180,
      p95LatencyMs: 180,
      maxLatencyMs: 180,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 1,
          errorCount: 0,
          timeoutCount: 0,
          avgLatencyMs: 180,
          p95LatencyMs: 180
        }
      ]
    }));

    await runSelfHealingLoop({ trigger: 'interval' });
    await jest.advanceTimersByTimeAsync(31000);
    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(rollbackPromptRouteDegradedModeMock).not.toHaveBeenCalled();
    expect(result.verificationResult).toBeNull();
    expect(result.action).toBeNull();
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'activatePromptRouteMitigation:degraded_response',
      activeMitigation: 'prompt:/api/openai/prompt:degraded_response',
      lastVerificationResult: null
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[SELF-HEAL] verify deferred'));
  });

  it('keeps prompt-route mitigation active when route-local metrics improve during verification', async () => {
    process.env.SELF_HEAL_VERIFICATION_DELAY_MS = '30000';
    getRollingRequestWindowMock
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 18,
        errorCount: 6,
        clientErrorCount: 2,
        serverErrorCount: 4,
        errorRate: 0.333,
        timeoutCount: 4,
        timeoutRate: 0.222,
        slowRequestCount: 10,
        avgLatencyMs: 2800,
        p95LatencyMs: 7600,
        maxLatencyMs: 9300,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 15,
            errorCount: 5,
            timeoutCount: 4,
            avgLatencyMs: 3400,
            p95LatencyMs: 9300
          }
        ]
      }))
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 20,
        errorCount: 5,
        clientErrorCount: 1,
        serverErrorCount: 4,
        errorRate: 0.25,
        timeoutCount: 4,
        timeoutRate: 0.2,
        slowRequestCount: 6,
        avgLatencyMs: 2500,
        p95LatencyMs: 7600,
        maxLatencyMs: 9300,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 17,
            errorCount: 1,
            timeoutCount: 1,
            avgLatencyMs: 650,
            p95LatencyMs: 1600
          }
        ]
      }));
    getRequestWindowSinceMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 5,
      errorCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 0,
      errorRate: 0,
      timeoutCount: 0,
      timeoutRate: 0,
      slowRequestCount: 0,
      avgLatencyMs: 150,
      p95LatencyMs: 220,
      maxLatencyMs: 220,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 5,
          errorCount: 0,
          timeoutCount: 0,
          avgLatencyMs: 150,
          p95LatencyMs: 220
        }
      ]
    }));

    await runSelfHealingLoop({ trigger: 'interval' });
    await jest.advanceTimersByTimeAsync(31000);
    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(rollbackPromptRouteDegradedModeMock).not.toHaveBeenCalled();
    expect(result.verificationResult).toEqual(expect.objectContaining({
      outcome: 'improved',
      action: 'activatePromptRouteMitigation:degraded_response'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      activeMitigation: 'prompt:/api/openai/prompt:degraded_response',
      lastVerificationResult: expect.objectContaining({
        outcome: 'improved'
      })
    }));
  });

  it('runs the broader controller for manual self-heal requests when no direct action is needed', async () => {
    runSelfImproveCycleMock.mockResolvedValueOnce({
      id: 'cycle-manual',
      autonomyLevel: 1,
      frozen: false,
      drift: { kind: 'none', severity: 'low' },
      decision: 'PATCH_PROPOSAL',
      evidencePath: 'governance/evidence_packs/cycle-manual.json'
    });

    const result = await runSelfHealingLoop({
      trigger: 'manual',
      requestedCycle: {
        trigger: 'manual',
        component: 'planner',
        context: {
          requestId: 'manual-1'
        }
      }
    });

    expect(runSelfImproveCycleMock).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'manual',
      component: 'planner',
      context: expect.objectContaining({
        requestId: 'manual-1',
        selfHealLoop: expect.objectContaining({
          diagnosis: 'manual self-heal evaluation',
          diagnosisType: 'manual'
        })
      })
    }));
    expect(result).toEqual(expect.objectContaining({
      trigger: 'manual',
      diagnosis: 'manual self-heal evaluation',
      action: null,
      controllerDecision: 'PATCH_PROPOSAL'
    }));
  });
});
