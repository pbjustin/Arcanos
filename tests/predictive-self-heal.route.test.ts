import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const runPredictiveHealingDecisionMock = jest.fn();

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingDecision: runPredictiveHealingDecisionMock
}));

jest.unstable_mockModule('@transport/http/middleware/capabilityGate.js', () => ({
  capabilityGate: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
}));

const selfHealRouter = (await import('../src/routes/self-heal.js')).default;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(selfHealRouter);
  return app;
}

describe('predictive self-heal route', () => {
  it('returns structured predictive decision output', async () => {
    runPredictiveHealingDecisionMock.mockResolvedValue({
      source: 'api_self_heal_decide',
      featureFlags: {
        enabled: true,
        dryRun: true,
        autoExecute: false
      },
      observation: {
        collectedAt: '2026-03-26T12:00:00.000Z',
        source: 'api_self_heal_decide',
        windowMs: 300000,
        requestCount: 24,
        errorRate: 0.02,
        timeoutRate: 0,
        avgLatencyMs: 1800,
        p95LatencyMs: 2600,
        maxLatencyMs: 3400,
        degradedCount: 0,
        memory: {
          rssMb: 512,
          heapUsedMb: 220,
          heapTotalMb: 260,
          externalMb: 18,
          arrayBuffersMb: 6
        },
        workerHealth: {
          overallStatus: 'degraded',
          alertCount: 1,
          alerts: ['queue pressure'],
          pending: 8,
          running: 2,
          delayed: 0,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 12000,
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
          workerIds: ['arcanos-worker-1']
        },
        promptRoute: {
          active: false,
          mode: null,
          reason: null
        }
      },
      trends: {
        observationCount: 4,
        sampleAgeMs: 0,
        dataFresh: true,
        latencySlopeMs: 320,
        p95LatencySlopeMs: 450,
        latencyRiseIntervals: 3,
        errorRateSlope: 0.01,
        memoryGrowthMb: 80,
        memoryPressureIntervals: 1,
        queueDepthVelocity: 2.5,
        workerHealthDegrading: true,
        unhealthyWorkerDelta: 0
      },
      decision: {
        advisor: 'rules_v1',
        decidedAt: '2026-03-26T12:00:00.000Z',
        action: 'scale_workers_up',
        target: 'worker_runtime',
        reason: 'Average latency has risen for 4 consecutive intervals.',
        confidence: 0.82,
        matchedRule: 'latency_rising_scale_up',
        safeToExecute: true,
        staleData: false,
        suggestedMode: 'dry_run',
        details: {
          latencySlopeMs: 320
        }
      },
      execution: {
        attempted: false,
        status: 'dry_run',
        mode: 'dry_run',
        action: 'scale_workers_up',
        target: 'worker_runtime',
        message: 'Predictive action evaluated in dry-run mode.',
        cooldownRemainingMs: null,
        actuatorResult: {
          preview: 'Scale-up supported.'
        },
        recoveryOutcome: {
          status: 'not_executed',
          summary: 'Dry-run mode prevented execution.'
        }
      },
      auditEntry: {
        id: 'predictive_heal_audit_1',
        timestamp: '2026-03-26T12:00:00.000Z'
      }
    });

    const response = await request(createApp())
      .post('/api/self-heal/decide')
      .send({
        dryRun: true,
        simulate: {
          avgLatencyMs: 1800
        }
      })
      .expect(200);

    expect(runPredictiveHealingDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'api_self_heal_decide',
      dryRun: true,
      execute: undefined,
      simulate: expect.objectContaining({
        avgLatencyMs: 1800
      })
    }));
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ok',
      predictiveHealing: expect.objectContaining({
        decision: expect.objectContaining({
          action: 'scale_workers_up',
          matchedRule: 'latency_rising_scale_up'
        }),
        execution: expect.objectContaining({
          status: 'dry_run'
        })
      })
    }));
  });
});
