import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const runPredictiveHealingDecisionMock = jest.fn();

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingDecision: runPredictiveHealingDecisionMock
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSelfHealEventsSnapshot: jest.fn(() => ({
    status: 'ok',
    timestamp: '2026-03-26T12:00:00.000Z',
    count: 0,
    events: []
  })),
  buildSelfHealInspectionSnapshot: jest.fn(async () => ({
    status: 'ok',
    timestamp: '2026-03-26T12:00:00.000Z',
    summary: 'mocked inspection',
    evidence: {
      selfHealRuntimeSnapshot: { status: 'ok' },
      recentSelfHealEvents: [],
      recentPromptDebugEvents: [],
      recentAIRoutingEvents: [],
      recentWorkerEvidence: []
    },
    limits: {
      selfHealEvents: 10,
      promptDebugEvents: 10,
      aiRoutingEvents: 10,
      workerEvidence: 10
    }
  })),
  buildSelfHealProviderHealthSnapshot: jest.fn(async () => ({
    status: 'ok',
    timestamp: '2026-03-26T12:00:00.000Z',
    provider: {
      configured: false,
      clientInitialized: false,
      reachable: null,
      authenticated: null,
      completionHealthy: null,
      model: 'unknown',
      baseUrl: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      lastFailureCategory: null,
      lastFailureStatus: null,
      circuitBreakerState: 'UNKNOWN',
      circuitBreakerHealthy: false,
      circuitBreakerFailures: 0,
      circuitBreakerLastOpenedAt: null,
      circuitBreakerLastHalfOpenAt: null,
      circuitBreakerLastClosedAt: null,
      circuitBreakerNextRetryAt: null
    },
    probe: null
  })),
  buildSelfHealRuntimeSnapshot: jest.fn(() => ({
    status: 'ok',
    timestamp: '2026-03-26T12:00:00.000Z'
  }))
}));

jest.unstable_mockModule('@transport/http/middleware/capabilityGate.js', () => ({
  capabilityGate: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
}));

const selfHealRouter = (await import('../src/routes/self-heal.js')).default;
const controlPlaneAccessToken = 'predictive-self-heal-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
const originalPredictiveHealingEnabled = process.env.PREDICTIVE_HEALING_ENABLED;
const originalPredictiveHealingDryRun = process.env.PREDICTIVE_HEALING_DRY_RUN;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes: string): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:predictive-self-heal-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(selfHealRouter);
  return app;
}

describe('predictive self-heal route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane('self-heal:decide');
    process.env.PREDICTIVE_HEALING_ENABLED = 'false';
    process.env.PREDICTIVE_HEALING_DRY_RUN = 'true';
  });

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
              observationsInWindow: 2,
              attempts: 0,
              activeAction: null,
              verified: false,
              cooldownUntil: null,
              failedActions: []
            }
          }
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
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        dryRun: true,
        simulate: {
          avgLatencyMs: 1800,
          trinity: {
            stages: {
              final: {
                observationsInWindow: 2
              }
            }
          }
        }
      })
      .expect(200);

    expect(runPredictiveHealingDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'api_self_heal_decide',
      dryRun: true,
      execute: undefined,
      simulate: expect.objectContaining({
        avgLatencyMs: 1800,
        trinity: expect.objectContaining({
          stages: expect.objectContaining({
            final: expect.objectContaining({
              observationsInWindow: 2
            })
          })
        })
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

  it('requires a separate execution scope before invoking an actuator decision', async () => {
    const response = await request(createApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        execute: true,
        dryRun: false,
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(response.headers['x-ratelimit-bucket']).toBe('self-heal-decision');
    expect(runPredictiveHealingDecisionMock).not.toHaveBeenCalled();
  });

  it('allows an explicitly scoped operator to request execution', async () => {
    configureControlPlane('self-heal:decide,self-heal:execute');
    process.env.PREDICTIVE_HEALING_ENABLED = 'true';
    process.env.PREDICTIVE_HEALING_DRY_RUN = 'false';
    runPredictiveHealingDecisionMock.mockResolvedValue({
      source: 'api_self_heal_decide',
      decision: { action: 'observe' },
      execution: { status: 'not_required' },
    });

    const response = await request(createApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        execute: true,
        dryRun: false,
      });

    expect(response.status).toBe(200);
    expect(runPredictiveHealingDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      execute: true,
      dryRun: false,
    }));
  });

  it('rejects simulated observations unless they are explicitly non-executing dry runs', async () => {
    configureControlPlane('self-heal:decide,self-heal:execute');
    process.env.PREDICTIVE_HEALING_ENABLED = 'true';
    process.env.PREDICTIVE_HEALING_DRY_RUN = 'false';

    for (const payload of [
      { simulate: { errorRate: 0.5 } },
      { dryRun: false, simulate: { errorRate: 0.5 } },
      { execute: true, dryRun: true, simulate: { errorRate: 0.5 } },
      {
        dryRun: true,
        simulate: {
          workerRuntime: {
            workerIds: Array.from({ length: 101 }, (_, index) => `worker-${index}`),
          },
        },
      },
    ]) {
      const response = await request(createApp())
        .post('/api/self-heal/decide')
        .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid predictive self-heal payload');
    }

    expect(runPredictiveHealingDecisionMock).not.toHaveBeenCalled();
  });

  it('does not let HTTP execution override disabled or dry-run server policy', async () => {
    configureControlPlane('self-heal:decide,self-heal:execute');

    const disabledResponse = await request(createApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({ execute: true, dryRun: false });

    expect(disabledResponse.status).toBe(409);
    expect(disabledResponse.body.error).toBe('PREDICTIVE_HEALING_EXECUTION_DISABLED');

    process.env.PREDICTIVE_HEALING_ENABLED = 'true';
    const dryRunResponse = await request(createApp())
      .post('/api/self-heal/decide')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({ execute: true, dryRun: false });

    expect(dryRunResponse.status).toBe(409);
    expect(dryRunResponse.body.error).toBe('PREDICTIVE_HEALING_DRY_RUN_ENFORCED');
    expect(runPredictiveHealingDecisionMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
  if (originalPredictiveHealingEnabled === undefined) {
    delete process.env.PREDICTIVE_HEALING_ENABLED;
  } else {
    process.env.PREDICTIVE_HEALING_ENABLED = originalPredictiveHealingEnabled;
  }
  if (originalPredictiveHealingDryRun === undefined) {
    delete process.env.PREDICTIVE_HEALING_DRY_RUN;
  } else {
    process.env.PREDICTIVE_HEALING_DRY_RUN = originalPredictiveHealingDryRun;
  }
});
