import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  requestSelfHealingLoopEvaluation: async () => undefined,
  startSelfHealingControlLoop: () => undefined,
  getSelfHealingControlLoopStatus: () => ({
    active: true,
    loopRunning: true,
    internalExecutionAvailable: true,
    repoToolingAvailable: true,
    railwayCliAvailable: false,
    lastDiagnosis: 'timeout_cluster count=3 stage=intake tiers=complex',
    lastAction: 'enable_degraded_mode',
    attempts: 2,
    lastResult: 'improved',
    errorRate: 0.03,
    avgLatencyMs: 812,
    operationalRequests: 24,
    lastObservedAt: '2026-03-24T00:00:00.000Z',
    lastActionAt: '2026-03-24T00:00:05.000Z',
    lastVerifiedAt: '2026-03-24T00:00:10.000Z',
    incidentActive: false,
    incidentId: null,
    executionId: 'exec-self-heal',
    executionStatus: 'completed',
    mitigation: {
      activeAction: null,
      tiers: [],
      stage: null,
      reason: null,
      activeSinceMs: null,
      expiresAtMs: null
    },
    latestObservation: null,
    trinity: {
      enabled: true,
      config: {},
      snapshot: {}
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
        lastDiagnosis: 'timeout_cluster count=3 stage=intake tiers=complex',
        lastAction: 'enable_degraded_mode',
        attempts: 2,
        lastResult: 'improved',
        errorRate: 0.03,
        executionId: 'exec-self-heal',
        executionStatus: 'completed'
      })
    );
    expect(typeof response.body.timestamp).toBe('string');
  });
});
