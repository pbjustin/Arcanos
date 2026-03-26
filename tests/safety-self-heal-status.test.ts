import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  getSelfHealingLoopStatus: () => ({
    active: true,
    loopRunning: true,
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

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
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
  })
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingStatus: () => ({
    enabled: true,
    config: {},
    snapshot: {
      intake: {},
      reasoning: {},
      final: {}
    }
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
        }),
        trinity: expect.objectContaining({
          enabled: true
        })
      })
    );
    expect(typeof response.body.timestamp).toBe('string');
  });
});
