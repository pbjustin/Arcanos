import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  getSelfHealingLoopStatus: () => ({
    active: true,
    loopRunning: true,
    inFlight: false,
    startedAt: '2026-03-24T00:00:00.000Z',
    lastTick: '2026-03-24T00:00:10.000Z',
    tickCount: 12,
    lastError: null,
    intervalMs: 30_000,
    lastDiagnosis: 'pipeline timeout cluster detected',
    lastAction: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
    lastActionAt: '2026-03-24T00:00:05.000Z',
    lastControllerDecision: null,
    lastControllerRunAt: null,
    lastWorkerHealth: 'healthy',
    lastTrinityMitigation: 'reasoning:enable_degraded_mode',
    lastEvidence: {
      timeoutCount: 4,
      pipelineTimeoutCount: 3
    },
    lastVerificationResult: {
      verifiedAt: '2026-03-24T00:00:30.000Z',
      action: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
      diagnosis: 'pipeline timeout cluster detected',
      outcome: 'improved',
      summary: 'max latency improved',
      baseline: {
        errorRate: 0.2,
        timeoutRate: 0.2,
        timeoutCount: 4,
        p95LatencyMs: 6200,
        avgLatencyMs: 3100,
        maxLatencyMs: 8200,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        workerHealth: 'healthy',
        activeMitigation: null,
        promptRoute: null
      },
      current: {
        errorRate: 0.1,
        timeoutRate: 0.05,
        timeoutCount: 1,
        p95LatencyMs: 2400,
        avgLatencyMs: 1200,
        maxLatencyMs: 3100,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        workerHealth: 'healthy',
        activeMitigation: 'reasoning:enable_degraded_mode',
        promptRoute: null
      }
    },
    activeMitigation: 'reasoning:enable_degraded_mode',
    lastLatencySnapshot: {
      requestCount: 24,
      avgLatencyMs: 812,
      p95LatencyMs: 2400,
      maxLatencyMs: 3100,
      promptRoute: null,
      pipelineTimeoutCount: 3
    },
    recentTimeoutCounts: {
      windowMs: 300_000,
      total: 4,
      promptRoute: 0,
      coreRoute: 3
    },
    bypassedSubsystems: ['trinity_reasoning'],
    ineffectiveActions: {},
    attemptsByDiagnosis: {
      pipeline_timeout_cluster: 1
    },
    cooldowns: {},
    lastHealthyObservedAt: '2026-03-24T00:00:30.000Z',
    degradedModeReason: 'arcanos_core_pipeline_timeout_static_fallback'
  })
}));

jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  getSelfHealingControlLoopStatus: () => ({
    active: true,
    loopRunning: true,
    internalExecutionAvailable: true,
    repoToolingAvailable: true,
    railwayCliAvailable: null,
    lastDiagnosis: 'timeout cluster across operational routes',
    lastAction: 'restart_service',
    attempts: 1,
    lastResult: 'running',
    errorRate: 0.2,
    avgLatencyMs: 3100,
    operationalRequests: 24,
    lastObservedAt: '2026-03-24T00:00:10.000Z',
    lastActionAt: '2026-03-24T00:00:05.000Z',
    lastVerifiedAt: null,
    incidentActive: true,
    incidentId: 'incident-1',
    executionId: 'exec-1',
    executionStatus: 'running',
    mitigation: {
      activeAction: 'restart_service',
      tiers: ['complex'],
      stage: 'global',
      reason: 'timeout cluster',
      activeSinceMs: 0,
      expiresAtMs: null
    },
    latestObservation: null,
    trinity: {
      enabled: true,
      config: {},
      snapshot: {
        intake: {},
        reasoning: {},
        final: {}
      }
    }
  })
}));

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  activatePromptRouteDegradedMode: () => ({
    active: true,
    route: '/api/openai/prompt',
    mode: 'degraded_response',
    reason: 'mocked',
    activatedAt: null,
    updatedAt: null,
    pipelineTimeoutMs: null,
    providerTimeoutMs: null,
    fallbackModel: true,
    maxRetries: null,
    maxTokens: null,
    bypassedSubsystems: []
  }),
  activatePromptRouteReducedLatencyMode: () => ({
    active: true,
    route: '/api/openai/prompt',
    mode: 'reduced_latency',
    reason: 'mocked',
    activatedAt: null,
    updatedAt: null,
    pipelineTimeoutMs: 3500,
    providerTimeoutMs: 3200,
    fallbackModel: true,
    maxRetries: 0,
    maxTokens: 96,
    bypassedSubsystems: []
  }),
  getPromptRouteMitigationState: () => ({
    active: false,
    route: '/api/openai/prompt',
    mode: null,
    reason: null,
    activatedAt: null,
    updatedAt: null,
    pipelineTimeoutMs: null,
    providerTimeoutMs: null,
    fallbackModel: false,
    maxRetries: null,
    maxTokens: null,
    bypassedSubsystems: []
  }),
  resetPromptRouteMitigationStateForTests: () => undefined,
  rollbackPromptRouteMitigation: () => ({
    active: false,
    route: '/api/openai/prompt',
    mode: null,
    reason: null,
    activatedAt: null,
    updatedAt: null,
    pipelineTimeoutMs: null,
    providerTimeoutMs: null,
    fallbackModel: false,
    maxRetries: null,
    maxTokens: null,
    bypassedSubsystems: []
  })
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  activateTrinitySelfHealingMitigation: () => ({
    applied: false,
    rolledBack: false,
    stage: 'reasoning',
    action: null,
    reason: 'mocked',
    activeAction: null,
    verified: false,
    expiresAtMs: null
  }),
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null,
    stage: null,
    bypassFinalStage: false,
    forceDirectAnswer: false,
    verified: false
  }),
  getTrinitySelfHealingStatus: () => ({
    enabled: true,
    config: {},
    snapshot: {
      intake: {},
      reasoning: {},
      final: {}
    }
  }),
  noteTrinityMitigationOutcome: () => undefined,
  recordTrinityStageFailure: () => null,
  rollbackTrinitySelfHealingMitigation: () => ({
    applied: false,
    rolledBack: false,
    stage: 'reasoning',
    action: null,
    reason: 'mocked',
    activeAction: null,
    verified: false,
    expiresAtMs: null
  })
}));

jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  buildCompactSelfHealSummary: jest.fn(),
  buildSelfHealTelemetrySnapshot: () => ({
    enabled: true,
    active: true,
    lastTrigger: null,
    lastAttempt: null,
    lastSuccess: null,
    lastFailure: null,
    lastFallback: null,
    triggerReason: null,
    actionTaken: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
    healedComponent: 'trinity.reasoning',
    recentEvents: [],
    persistence: {
      mode: 'local_memory_dir',
      durable: false,
      restoredFromDisk: false,
      lastLoadedAt: null,
      lastSavedAt: null,
      lastSaveError: null
    }
  }),
  inferSelfHealComponentFromAction: (actionTaken?: string | null) => {
    if (actionTaken === 'restart_service') {
      return 'service_runtime';
    }
    if (actionTaken === 'activateTrinityMitigation:reasoning:enable_degraded_mode') {
      return 'trinity.reasoning';
    }
    return null;
  },
  inferSelfHealComponentFromRequest: () => 'request_route',
  recordSelfHealEvent: jest.fn()
}));

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  buildPredictiveHealingCompactSummary: jest.fn(),
  buildPredictiveHealingStatusSnapshot: () => ({
    enabled: false,
    dryRun: true,
    autoExecute: false,
    lastObservedAt: null,
    lastDecisionAt: null,
    lastAction: null,
    lastResult: null,
    lastMatchedRule: null,
    recentAuditCount: 0,
    recentAudits: [],
    recentObservations: [],
    cooldowns: {},
    detailsPath: '/api/self-heal/decide',
    advisors: ['rules_v1']
  })
}));

const safetyRouter = (await import('../src/routes/safety.js')).default;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

describe('/status/safety/self-heal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the bounded self-healing loop status fields', async () => {
    const response = await request(createApp()).get('/status/safety/self-heal').expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'ok',
        active: true,
        enabled: true,
        isHealing: true,
        actionTaken: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
        healedComponent: 'trinity.reasoning',
        loopRunning: true,
        lastDiagnosis: 'pipeline timeout cluster detected',
        lastAction: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
        lastHealRun: '2026-03-24T00:00:05.000Z',
        systemState: expect.objectContaining({
          errorRate: 0.2,
          latency: 3100,
          operationalRequests: 24
        }),
        activeMitigation: 'reasoning:enable_degraded_mode',
        degradedModeReason: 'arcanos_core_pipeline_timeout_static_fallback',
        recentTimeoutCounts: expect.objectContaining({
          total: 4,
          coreRoute: 3
        }),
        controlLoop: expect.objectContaining({
          incidentActive: true,
          lastAction: 'restart_service'
        }),
        lastVerificationResult: expect.objectContaining({
          outcome: 'improved'
        }),
        loop: expect.objectContaining({
          loopRunning: true,
          lastDiagnosis: 'pipeline timeout cluster detected',
          lastAction: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
          activeMitigation: 'reasoning:enable_degraded_mode',
          degradedModeReason: 'arcanos_core_pipeline_timeout_static_fallback',
          recentTimeoutCounts: expect.objectContaining({
            total: 4,
            coreRoute: 3
          }),
          lastVerificationResult: expect.objectContaining({
            outcome: 'improved'
          })
        }),
        trinity: expect.objectContaining({
          enabled: true
        })
      })
    );
    expect(typeof response.body.timestamp).toBe('string');
  });
});
