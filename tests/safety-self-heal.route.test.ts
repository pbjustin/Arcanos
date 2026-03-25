import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const getSelfHealingLoopStatusMock = jest.fn();
const getTrinitySelfHealingStatusMock = jest.fn();

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  getSelfHealingLoopStatus: getSelfHealingLoopStatusMock
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingStatus: getTrinitySelfHealingStatusMock
}));

const safetyRouter = (await import('../src/routes/safety.js')).default;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

describe('GET /status/safety/self-heal', () => {
  it('returns live loop status fields at the top level', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      active: true,
      loopRunning: true,
      startedAt: '2026-03-25T11:59:30.000Z',
      lastTick: '2026-03-25T12:00:00.000Z',
      tickCount: 2,
      lastError: null,
      intervalMs: 30000,
      lastDiagnosis: 'worker health degraded',
      lastAction: 'healWorkerRuntime:started',
      lastActionAt: '2026-03-25T12:00:01.000Z',
      lastControllerDecision: 'ESCALATE',
      lastControllerRunAt: '2026-03-25T12:00:02.000Z',
      lastWorkerHealth: 'degraded',
      lastTrinityMitigation: 'reasoning:enable_degraded_mode',
      lastEvidence: {
        timeoutCount: 4,
        timeoutRate: 0.2
      },
      lastVerificationResult: {
        verifiedAt: '2026-03-25T12:00:03.000Z',
        action: 'activateTrinityMitigation:reasoning:enable_degraded_mode',
        diagnosis: 'timeout storm detected',
        outcome: 'improved',
        summary: 'rolling error rate improved',
        baseline: {
          errorRate: 0.25,
          timeoutRate: 0.2,
          timeoutCount: 4,
          p95LatencyMs: 6000,
          avgLatencyMs: 3200,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 0,
          workerHealth: 'degraded',
          activeMitigation: 'reasoning:enable_degraded_mode'
        },
        current: {
          errorRate: 0.12,
          timeoutRate: 0.05,
          timeoutCount: 1,
          p95LatencyMs: 2800,
          avgLatencyMs: 1400,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 0,
          workerHealth: 'healthy',
          activeMitigation: 'reasoning:enable_degraded_mode'
        }
      },
      activeMitigation: 'reasoning:enable_degraded_mode',
      attemptsByDiagnosis: {
        timeout_storm: 1
      },
      cooldowns: {
        'action:activate_trinity_degraded_mode': '2026-03-25T12:02:00.000Z'
      },
      lastHealthyObservedAt: '2026-03-25T12:00:03.000Z'
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({
      enabled: true,
      snapshot: {}
    });

    const response = await request(createApp()).get('/status/safety/self-heal').expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      active: true,
      loopRunning: true,
      startedAt: '2026-03-25T11:59:30.000Z',
      lastTick: '2026-03-25T12:00:00.000Z',
      tickCount: 2,
      lastError: null,
      intervalMs: 30000,
      lastDiagnosis: 'worker health degraded',
      lastAction: 'healWorkerRuntime:started',
      lastActionAt: '2026-03-25T12:00:01.000Z',
      lastControllerDecision: 'ESCALATE',
      lastControllerRunAt: '2026-03-25T12:00:02.000Z',
      lastWorkerHealth: 'degraded',
      lastTrinityMitigation: 'reasoning:enable_degraded_mode',
      lastEvidence: {
        timeoutCount: 4,
        timeoutRate: 0.2
      },
      lastVerificationResult: expect.objectContaining({
        outcome: 'improved'
      }),
      activeMitigation: 'reasoning:enable_degraded_mode',
      attemptsByDiagnosis: {
        timeout_storm: 1
      },
      cooldowns: {
        'action:activate_trinity_degraded_mode': '2026-03-25T12:02:00.000Z'
      },
      lastHealthyObservedAt: '2026-03-25T12:00:03.000Z',
      trinity: {
        enabled: true,
        snapshot: {}
      }
    }));
  });
});
