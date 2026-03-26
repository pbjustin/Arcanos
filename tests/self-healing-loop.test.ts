import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getConfigMock = jest.fn();
const runSelfImproveCycleMock = jest.fn();
const getTrinitySelfHealingStatusMock = jest.fn();
const activateTrinitySelfHealingMitigationMock = jest.fn();
const rollbackTrinitySelfHealingMitigationMock = jest.fn();
const getPromptRouteMitigationStateMock = jest.fn();
const activatePromptRouteReducedLatencyModeMock = jest.fn();
const activatePromptRouteDegradedModeMock = jest.fn();
const rollbackPromptRouteMitigationMock = jest.fn();
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
  activatePromptRouteReducedLatencyMode: activatePromptRouteReducedLatencyModeMock,
  activatePromptRouteDegradedMode: activatePromptRouteDegradedModeMock,
  rollbackPromptRouteMitigation: rollbackPromptRouteMitigationMock,
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
    pipelineTimeoutCount: 0,
    providerTimeoutCount: 0,
    workerTimeoutCount: 0,
    budgetAbortCount: 0,
    degradedCount: 0,
    degradedReasons: [],
    bypassedSubsystems: [],
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
  let promptRouteMitigationMode: 'reduced_latency' | 'degraded_response' | null;
  let promptRouteMitigationReason: string | null;
  let promptRouteMitigationActivatedAt: string | null;
  let promptRouteMitigationUpdatedAt: string | null;
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
    trinityActiveAction = null;
    promptRouteMitigationActive = false;
    promptRouteMitigationMode = null;
    promptRouteMitigationReason = null;
    promptRouteMitigationActivatedAt = null;
    promptRouteMitigationUpdatedAt = null;

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
      mode: promptRouteMitigationActive ? promptRouteMitigationMode : null,
      route: '/api/openai/prompt',
      activatedAt: promptRouteMitigationActive ? promptRouteMitigationActivatedAt ?? '2026-03-25T12:00:00.000Z' : null,
      updatedAt: promptRouteMitigationActive ? promptRouteMitigationUpdatedAt ?? '2026-03-25T12:00:00.000Z' : null,
      reason: promptRouteMitigationReason,
      recentTimeoutCount: 0,
      timeoutWindowStartedAt: null,
      lastTimeoutAt: null,
      lastAutoActivationAt: null,
      lastAutoActivationReason: null,
      pipelineTimeoutMs: promptRouteMitigationMode === 'reduced_latency' ? 3500 : null,
      providerTimeoutMs: promptRouteMitigationMode === 'reduced_latency' ? 3200 : null,
      maxRetries: promptRouteMitigationMode === 'reduced_latency' ? 0 : promptRouteMitigationActive ? 0 : null,
      maxTokens: promptRouteMitigationMode === 'reduced_latency' ? 96 : null,
      fallbackModel: promptRouteMitigationActive,
      bypassedSubsystems:
        promptRouteMitigationMode === 'reduced_latency'
          ? ['provider_retry', 'long_generation_tail', 'prompt_route_extended_budget']
          : promptRouteMitigationMode === 'degraded_response'
            ? ['provider_retry', 'long_generation_tail', 'openai_prompt_execution']
            : []
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
    activatePromptRouteReducedLatencyModeMock.mockImplementation((reason: string) => {
      promptRouteMitigationActive = true;
      promptRouteMitigationMode = 'reduced_latency';
      promptRouteMitigationReason = reason;
      promptRouteMitigationActivatedAt = '2026-03-25T12:00:00.000Z';
      promptRouteMitigationUpdatedAt = '2026-03-25T12:00:00.000Z';
      return {
        applied: true,
        rolledBack: false,
        reason: 'applied',
        state: {
          active: true,
          mode: 'reduced_latency',
          route: '/api/openai/prompt',
          activatedAt: '2026-03-25T12:00:00.000Z',
          updatedAt: '2026-03-25T12:00:00.000Z',
          reason,
          recentTimeoutCount: 0,
          timeoutWindowStartedAt: null,
          lastTimeoutAt: null,
          lastAutoActivationAt: '2026-03-25T12:00:00.000Z',
          lastAutoActivationReason: reason,
          pipelineTimeoutMs: 3500,
          providerTimeoutMs: 3200,
          maxRetries: 0,
          maxTokens: 96,
          fallbackModel: true,
          bypassedSubsystems: ['provider_retry', 'long_generation_tail', 'prompt_route_extended_budget']
        }
      };
    });
    activatePromptRouteDegradedModeMock.mockImplementation((reason: string) => {
      promptRouteMitigationActive = true;
      promptRouteMitigationMode = 'degraded_response';
      promptRouteMitigationReason = reason;
      promptRouteMitigationActivatedAt = '2026-03-25T12:00:00.000Z';
      promptRouteMitigationUpdatedAt = '2026-03-25T12:00:00.000Z';
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
          reason,
          recentTimeoutCount: 0,
          timeoutWindowStartedAt: null,
          lastTimeoutAt: null,
          lastAutoActivationAt: '2026-03-25T12:00:00.000Z',
          lastAutoActivationReason: reason,
          pipelineTimeoutMs: null,
          providerTimeoutMs: null,
          maxRetries: 0,
          maxTokens: null,
          fallbackModel: true,
          bypassedSubsystems: ['provider_retry', 'long_generation_tail', 'openai_prompt_execution']
        }
      };
    });
    rollbackPromptRouteMitigationMock.mockImplementation((reason: string) => {
      promptRouteMitigationActive = false;
      promptRouteMitigationMode = null;
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
          reason,
          pipelineTimeoutMs: null,
          providerTimeoutMs: null,
          maxRetries: null,
          maxTokens: null,
          fallbackModel: false,
          bypassedSubsystems: []
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

  it('activates trinity degraded mode when shared core pipeline timeouts cluster', async () => {
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 14,
      errorCount: 1,
      serverErrorCount: 1,
      errorRate: 0.071,
      timeoutCount: 2,
      timeoutRate: 0.143,
      pipelineTimeoutCount: 2,
      degradedCount: 2,
      degradedReasons: ['arcanos_core_pipeline_timeout_direct_answer'],
      bypassedSubsystems: ['trinity_intake', 'trinity_reasoning'],
      slowRequestCount: 5,
      avgLatencyMs: 1900,
      p95LatencyMs: 4800,
      maxLatencyMs: 6100,
      routes: [
        {
          route: '/gpt/:gptId',
          requestCount: 10,
          errorCount: 1,
          timeoutCount: 2,
          pipelineTimeoutCount: 2,
          degradedCount: 2,
          avgLatencyMs: 2300,
          p95LatencyMs: 6100,
          maxLatencyMs: 6100
        },
        {
          route: '/ask',
          requestCount: 4,
          errorCount: 0,
          timeoutCount: 0,
          avgLatencyMs: 620,
          p95LatencyMs: 900,
          maxLatencyMs: 1100
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(activateTrinitySelfHealingMitigationMock).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'reasoning',
      action: 'enable_degraded_mode'
    }));
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'pipeline timeout cluster detected',
      action: 'activateTrinityMitigation:reasoning:enable_degraded_mode'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastDiagnosis: 'pipeline timeout cluster detected',
      degradedModeReason: 'arcanos_core_pipeline_timeout_direct_answer',
      recentTimeoutCounts: expect.objectContaining({
        pipelineTimeouts: 2,
        coreRoute: 2
      }),
      bypassedSubsystems: expect.arrayContaining(['trinity_intake', 'trinity_reasoning'])
    }));
  });

  it('detects latency spike bursts even when the rolling average stays below threshold', async () => {
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 14,
      errorCount: 1,
      serverErrorCount: 1,
      errorRate: 0.071,
      timeoutCount: 2,
      timeoutRate: 0.143,
      slowRequestCount: 5,
      avgLatencyMs: 1450,
      p95LatencyMs: 2900,
      maxLatencyMs: 8800,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 8,
          errorCount: 1,
          timeoutCount: 2,
          slowRequestCount: 4,
          avgLatencyMs: 1750,
          p95LatencyMs: 3200,
          maxLatencyMs: 8800
        },
        {
          route: '/ask',
          requestCount: 6,
          errorCount: 0,
          timeoutCount: 0,
          slowRequestCount: 1,
          avgLatencyMs: 810,
          p95LatencyMs: 1200,
          maxLatencyMs: 1500
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(activatePromptRouteReducedLatencyModeMock).toHaveBeenCalledWith('timeout storm detected', 256);
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'timeout storm detected',
      action: 'activatePromptRouteMitigation:reduced_latency'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'activatePromptRouteMitigation:reduced_latency',
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      bypassedSubsystems: expect.arrayContaining(['provider_retry', 'long_generation_tail']),
      lastEvidence: expect.objectContaining({
        timeoutCount: 2,
        timeoutRate: 0.143,
        maxLatencyMs: 8800,
        targetedRoute: expect.objectContaining({
          route: '/api/openai/prompt',
          timeoutCount: 2,
          maxLatencyMs: 8800
        })
      })
    }));
  });

  it('targets prompt-route timeout clusters even when prompt traffic is a minority of the window', async () => {
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 24,
      errorCount: 2,
      serverErrorCount: 2,
      errorRate: 0.083,
      timeoutCount: 2,
      timeoutRate: 0.083,
      pipelineTimeoutCount: 1,
      slowRequestCount: 4,
      avgLatencyMs: 1200,
      p95LatencyMs: 2400,
      maxLatencyMs: 5600,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 4,
          errorCount: 1,
          timeoutCount: 2,
          pipelineTimeoutCount: 1,
          slowRequestCount: 3,
          avgLatencyMs: 2810,
          p95LatencyMs: 4810,
          maxLatencyMs: 5600
        },
        {
          route: '/ask',
          requestCount: 20,
          errorCount: 1,
          timeoutCount: 0,
          slowRequestCount: 1,
          avgLatencyMs: 880,
          p95LatencyMs: 1200,
          maxLatencyMs: 1600
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(activatePromptRouteReducedLatencyModeMock).toHaveBeenCalledWith('pipeline timeout cluster detected', 256);
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'pipeline timeout cluster detected',
      action: 'activatePromptRouteMitigation:reduced_latency'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'activatePromptRouteMitigation:reduced_latency',
      recentPromptRouteTimeouts: 2,
      recentPromptRouteLatencyP95: 4810,
      recentPromptRouteMaxLatency: 5600,
      recentPipelineTimeoutCounts: expect.objectContaining({
        total: 1,
        promptRoute: 1
      }),
      lastEvidence: expect.objectContaining({
        targetedRoute: expect.objectContaining({
          route: '/api/openai/prompt',
          requestShare: 0.167,
          timeoutCount: 2,
          pipelineTimeoutCount: 1,
          maxLatencyMs: 5600
        })
      })
    }));
  });

  it('allows prompt-route mitigation even when a trinity mitigation is already active', async () => {
    trinityActiveAction = 'enable_degraded_mode';
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 18,
      errorCount: 2,
      serverErrorCount: 2,
      errorRate: 0.111,
      timeoutCount: 2,
      timeoutRate: 0.111,
      pipelineTimeoutCount: 1,
      slowRequestCount: 5,
      avgLatencyMs: 1500,
      p95LatencyMs: 3100,
      maxLatencyMs: 5900,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 3,
          errorCount: 1,
          timeoutCount: 2,
          pipelineTimeoutCount: 1,
          slowRequestCount: 2,
          avgLatencyMs: 3320,
          p95LatencyMs: 5200,
          maxLatencyMs: 5900
        },
        {
          route: '/api/other',
          requestCount: 15,
          errorCount: 1,
          timeoutCount: 0,
          slowRequestCount: 3,
          avgLatencyMs: 1130,
          p95LatencyMs: 1800,
          maxLatencyMs: 2200
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(activatePromptRouteReducedLatencyModeMock).toHaveBeenCalledWith('pipeline timeout cluster detected', 256);
    expect(activateTrinitySelfHealingMitigationMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'pipeline timeout cluster detected',
      action: 'activatePromptRouteMitigation:reduced_latency'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      activePromptMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      activeMitigation: expect.stringContaining('prompt:/api/openai/prompt:reduced_latency')
    }));
  });

  it('escalates prompt-route mitigation to degraded mode when reduced-latency mode is already active', async () => {
    promptRouteMitigationActive = true;
    promptRouteMitigationMode = 'reduced_latency';
    promptRouteMitigationReason = 'timeout storm detected';
    promptRouteMitigationActivatedAt = '2026-03-25T11:55:00.000Z';
    promptRouteMitigationUpdatedAt = '2026-03-25T11:55:00.000Z';
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
    expect(activatePromptRouteReducedLatencyModeMock).not.toHaveBeenCalled();
    expect(activateTrinitySelfHealingMitigationMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'latency spike cluster detected',
      action: 'activatePromptRouteMitigation:degraded_response'
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'activatePromptRouteMitigation:degraded_response',
      activeMitigation: 'prompt:/api/openai/prompt:degraded_response',
      bypassedSubsystems: expect.arrayContaining(['openai_prompt_execution']),
      lastEvidence: expect.objectContaining({
        targetedRoute: expect.objectContaining({
          route: '/api/openai/prompt',
          requestCount: 16
        })
      })
    }));
  });

  it('does not immediately escalate reduced-latency prompt mitigation before the stabilization window elapses', async () => {
    process.env.SELF_HEAL_VERIFICATION_DELAY_MS = '90000';
    promptRouteMitigationActive = true;
    promptRouteMitigationMode = 'reduced_latency';
    promptRouteMitigationReason = 'prompt route timeout cluster detected (budget_abort)';
    promptRouteMitigationActivatedAt = '2026-03-25T11:59:40.000Z';
    promptRouteMitigationUpdatedAt = '2026-03-25T11:59:40.000Z';
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

    expect(activatePromptRouteDegradedModeMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'latency spike cluster detected',
      action: null
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      activePromptMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency'
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

    expect(rollbackPromptRouteMitigationMock).toHaveBeenCalledWith('self_heal_verification_failed');
    expect(result.verificationResult).toEqual(expect.objectContaining({
      outcome: 'unchanged',
      action: 'activatePromptRouteMitigation:reduced_latency'
    }));
    expect(result.action).toBe('rollbackPromptRouteMitigation');
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'rollbackPromptRouteMitigation',
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

    expect(rollbackPromptRouteMitigationMock).not.toHaveBeenCalled();
    expect(result.verificationResult).toBeNull();
    expect(result.action).toBeNull();
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastAction: 'activatePromptRouteMitigation:reduced_latency',
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency',
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
      }))
      .mockReturnValueOnce(createRequestWindow({
        requestCount: 16,
        errorCount: 1,
        clientErrorCount: 0,
        serverErrorCount: 1,
        errorRate: 0.063,
        timeoutCount: 4,
        timeoutRate: 0.25,
        slowRequestCount: 8,
        avgLatencyMs: 3016.313,
        p95LatencyMs: 6021,
        maxLatencyMs: 6021,
        routes: [
          {
            route: '/api/openai/prompt',
            requestCount: 12,
            errorCount: 1,
            timeoutCount: 4,
            avgLatencyMs: 4020.917,
            p95LatencyMs: 6021,
            maxLatencyMs: 6021
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
    await jest.advanceTimersByTimeAsync(30000);
    const followUpTick = await runSelfHealingLoop({ trigger: 'interval' });

    expect(rollbackPromptRouteMitigationMock).not.toHaveBeenCalled();
    expect(activatePromptRouteDegradedModeMock).not.toHaveBeenCalled();
    expect(result.verificationResult).toEqual(expect.objectContaining({
      outcome: 'improved',
      action: 'activatePromptRouteMitigation:reduced_latency'
    }));
    expect(followUpTick.action).toBeNull();
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      cooldowns: expect.objectContaining({
        'action:activate_prompt_route_degraded_mode': expect.any(String)
      }),
      lastVerificationResult: expect.objectContaining({
        outcome: 'improved'
      })
    }));
  });

  it('reports prompt-route stability from post-mitigation traffic instead of stale global burst samples', async () => {
    promptRouteMitigationActive = true;
    promptRouteMitigationMode = 'reduced_latency';
    promptRouteMitigationReason = 'timeout storm detected';
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 16,
      errorCount: 1,
      clientErrorCount: 0,
      serverErrorCount: 1,
      errorRate: 0.063,
      timeoutCount: 4,
      timeoutRate: 0.25,
      slowRequestCount: 8,
      avgLatencyMs: 3016.313,
      p95LatencyMs: 6021,
      maxLatencyMs: 6021,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 12,
          errorCount: 1,
          timeoutCount: 4,
          slowRequestCount: 8,
          avgLatencyMs: 4020.917,
          p95LatencyMs: 6021,
          maxLatencyMs: 6021
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
          slowRequestCount: 0,
          avgLatencyMs: 150,
          p95LatencyMs: 220,
          maxLatencyMs: 220
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'prompt route stabilized under reduced-latency mitigation',
      action: null
    }));
    expect(activatePromptRouteDegradedModeMock).not.toHaveBeenCalled();
    expect(activatePromptRouteReducedLatencyModeMock).not.toHaveBeenCalled();
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastDiagnosis: 'prompt route stabilized under reduced-latency mitigation',
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      lastHealthyObservedAt: expect.any(String),
      lastEvidence: expect.objectContaining({
        mitigationWindow: expect.objectContaining({
          observedSamples: 5,
          activeMitigation: 'prompt:/api/openai/prompt:reduced_latency'
        }),
        targetedRoute: expect.objectContaining({
          route: '/api/openai/prompt',
          requestCount: 5,
          timeoutCount: 0,
          maxLatencyMs: 220
        })
      })
    }));
  });

  it('treats a mostly-healthy post-mitigation prompt window as stabilized even with a single bounded timeout', async () => {
    promptRouteMitigationActive = true;
    promptRouteMitigationMode = 'reduced_latency';
    promptRouteMitigationReason = 'latency spike cluster detected';
    getRollingRequestWindowMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 16,
      errorCount: 1,
      clientErrorCount: 0,
      serverErrorCount: 1,
      errorRate: 0.063,
      timeoutCount: 1,
      timeoutRate: 0.063,
      slowRequestCount: 10,
      avgLatencyMs: 2890,
      p95LatencyMs: 6013,
      maxLatencyMs: 6013,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 14,
          errorCount: 1,
          timeoutCount: 1,
          slowRequestCount: 10,
          avgLatencyMs: 3320,
          p95LatencyMs: 6013,
          maxLatencyMs: 6013
        }
      ]
    }));
    getRequestWindowSinceMock.mockReturnValueOnce(createRequestWindow({
      requestCount: 16,
      errorCount: 1,
      clientErrorCount: 0,
      serverErrorCount: 1,
      errorRate: 0.063,
      timeoutCount: 1,
      timeoutRate: 0.063,
      slowRequestCount: 1,
      avgLatencyMs: 640,
      p95LatencyMs: 1800,
      maxLatencyMs: 2400,
      routes: [
        {
          route: '/api/openai/prompt',
          requestCount: 16,
          errorCount: 1,
          timeoutCount: 1,
          slowRequestCount: 1,
          avgLatencyMs: 640,
          p95LatencyMs: 1800,
          maxLatencyMs: 2400
        }
      ]
    }));

    const result = await runSelfHealingLoop({ trigger: 'interval' });

    expect(result).toEqual(expect.objectContaining({
      diagnosis: 'prompt route stabilized under reduced-latency mitigation',
      action: null
    }));
    expect(getSelfHealingLoopStatus()).toEqual(expect.objectContaining({
      lastDiagnosis: 'prompt route stabilized under reduced-latency mitigation',
      lastEvidence: expect.objectContaining({
        mitigationWindow: expect.objectContaining({
          timeoutSampleAllowance: 1,
          observedSamples: 16
        }),
        targetedRoute: expect.objectContaining({
          timeoutCount: 1,
          timeoutRate: 0.063,
          maxLatencyMs: 2400
        })
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
