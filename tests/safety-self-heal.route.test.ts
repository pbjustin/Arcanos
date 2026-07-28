import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const getSelfHealingLoopStatusMock = jest.fn();
const getSelfHealingControlLoopStatusMock = jest.fn();
const getTrinitySelfHealingStatusMock = jest.fn();
const getPromptRouteMitigationStateMock = jest.fn();
const buildSelfHealTelemetrySnapshotMock = jest.fn();
const buildCompactSelfHealSummaryMock = jest.fn();
const inferSelfHealComponentFromActionMock = jest.fn();
const inferSelfHealComponentFromRequestMock = jest.fn();
const recordSelfHealEventMock = jest.fn();
const buildPredictiveHealingStatusSnapshotMock = jest.fn();
const buildPredictiveHealingCompactSummaryMock = jest.fn();
const buildSafetySelfHealSnapshotMock = jest.fn();
const getActiveQuarantinesMock = jest.fn(() => [] as Record<string, unknown>[]);
const getActiveUnsafeConditionsMock = jest.fn(() => [] as Record<string, unknown>[]);
const getSafetyRuntimeSnapshotMock = jest.fn(() => ({
  counters: {
    duplicateSuppressions: 0,
    quarantineActivations: 0,
    workerFailures: {},
    heartbeatMisses: {},
    healthyCycles: {}
  }
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  getSelfHealingLoopStatus: getSelfHealingLoopStatusMock
}));

jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  getSelfHealingControlLoopStatus: getSelfHealingControlLoopStatusMock
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingStatus: getTrinitySelfHealingStatusMock
}));

jest.unstable_mockModule('@services/openai/promptRouteMitigation.js', () => ({
  getPromptRouteMitigationState: getPromptRouteMitigationStateMock
}));

jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  buildSelfHealTelemetrySnapshot: buildSelfHealTelemetrySnapshotMock,
  buildCompactSelfHealSummary: buildCompactSelfHealSummaryMock,
  inferSelfHealComponentFromAction: inferSelfHealComponentFromActionMock,
  inferSelfHealComponentFromRequest: inferSelfHealComponentFromRequestMock,
  recordSelfHealEvent: recordSelfHealEventMock
}));

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  buildPredictiveHealingStatusSnapshot: buildPredictiveHealingStatusSnapshotMock,
  buildPredictiveHealingCompactSummary: buildPredictiveHealingCompactSummaryMock
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: buildSafetySelfHealSnapshotMock
}));

jest.unstable_mockModule('../src/services/safety/runtimeState.js', () => ({
  activateUnsafeCondition: jest.fn(),
  buildUnsafeToProceedPayload: jest.fn(() => ({
    error: 'UNSAFE_TO_PROCEED',
    conditions: [],
    quarantineCount: 0,
    timestamp: '2026-03-25T12:00:00.000Z'
  })),
  clearUnsafeCondition: jest.fn(() => false),
  clearUnsafeConditionsByQuarantine: jest.fn(() => 0),
  getActiveQuarantines: getActiveQuarantinesMock,
  getActiveUnsafeConditions: getActiveUnsafeConditionsMock,
  getTrustedHash: jest.fn(() => undefined),
  getSafetyRuntimeSnapshot: getSafetyRuntimeSnapshotMock,
  hasUnsafeBlockingConditions: jest.fn(() => false),
  incrementHeartbeatMiss: jest.fn(() => ({ count: 0, exceeded: false })),
  incrementHealthyCycle: jest.fn(() => 0),
  incrementWorkerFailure: jest.fn(() => ({ count: 0, exceeded: false })),
  recordDuplicateSuppression: jest.fn(() => 0),
  reconcileAutoRecoverableQuarantinesForProcessStart: jest.fn(() => ({
    releasedQuarantineIds: [],
    resetEntityIds: []
  })),
  registerQuarantine: jest.fn(() => ({
    quarantineId: 'quarantine-1',
    kind: 'generic',
    reason: 'mock',
    integrityFailure: false,
    autoRecoverable: true,
    createdAt: '2026-03-25T12:00:00.000Z',
    monotonicTsMs: 0
  })),
  releaseQuarantine: jest.fn(),
  resetFailureSignals: jest.fn(),
  resetSafetyRuntimeStateForTests: jest.fn(),
  setTrustedHash: jest.fn()
}));

const safetyRouter = (await import('../src/routes/safety.js')).default;
const controlPlaneAccessToken = 'safety-self-heal-route-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:safety-self-heal-route-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read';
}

function createApp(authenticate = true): express.Express {
  configureControlPlane();
  const app = express();
  if (authenticate) {
    app.use((req, _res, next) => {
      req.headers.authorization = `Bearer ${controlPlaneAccessToken}`;
      next();
    });
  }
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

describe('safety self-heal routes', () => {
  it('keeps compact safety public while protecting detailed self-heal state', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      loopRunning: false,
      activeMitigation: null,
      lastAction: null,
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({ enabled: false });
    getPromptRouteMitigationStateMock.mockReturnValue({ active: false });
    buildSelfHealTelemetrySnapshotMock.mockReturnValue({});
    buildCompactSelfHealSummaryMock.mockReturnValue({ status: 'idle' });
    buildPredictiveHealingStatusSnapshotMock.mockReturnValue({});
    buildPredictiveHealingCompactSummaryMock.mockReturnValue({ status: 'idle' });
    const app = createApp(false);

    await request(app).get('/status/safety').expect(200);
    const detailedResponse = await request(app).get('/status/safety/self-heal');

    expect(detailedResponse.status).toBe(401);
    expect(detailedResponse.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(buildSafetySelfHealSnapshotMock).not.toHaveBeenCalled();
  });

  it('returns structured self-heal telemetry with nested subsystem status', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      inFlight: false,
      loopRunning: true,
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      lastAction: 'activatePromptRouteMitigation:reduced_latency'
    });
    getSelfHealingControlLoopStatusMock.mockReturnValue({
      active: true,
      loopRunning: true,
      incidentActive: false,
      executionStatus: null,
      mitigation: { activeAction: null },
      lastDiagnosis: null,
      lastAction: null,
      lastActionAt: null,
      lastObservedAt: null,
      errorRate: 0,
      avgLatencyMs: 0,
      operationalRequests: 0
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({
      enabled: true,
      snapshot: {}
    });
    getPromptRouteMitigationStateMock.mockReturnValue({
      active: true,
      mode: 'reduced_latency',
      route: '/api/openai/prompt'
    });
    inferSelfHealComponentFromActionMock.mockReturnValue('prompt_route');
    buildSelfHealTelemetrySnapshotMock.mockReturnValue({
      enabled: true,
      active: true,
      lastTrigger: { id: 'trigger-1', timestamp: '2026-03-25T12:00:00.000Z', kind: 'trigger' },
      lastAttempt: { id: 'attempt-1', timestamp: '2026-03-25T12:00:01.000Z', kind: 'attempt' },
      lastSuccess: { id: 'success-1', timestamp: '2026-03-25T12:00:02.000Z', kind: 'success' },
      lastFailure: null,
      lastFallback: { id: 'fallback-1', timestamp: '2026-03-25T11:59:00.000Z', kind: 'fallback' },
      triggerReason: 'latency spike cluster detected',
      actionTaken: 'activatePromptRouteMitigation:reduced_latency',
      healedComponent: 'prompt_route',
      recentEvents: [
        { id: 'fallback-1', timestamp: '2026-03-25T11:59:00.000Z', kind: 'fallback' },
        { id: 'success-1', timestamp: '2026-03-25T12:00:02.000Z', kind: 'success' }
      ]
    });
    buildPredictiveHealingStatusSnapshotMock.mockReturnValue({
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
    });
    buildSafetySelfHealSnapshotMock.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-25T12:00:03.000Z',
      enabled: true,
      active: true,
      isHealing: true,
      lastTriggerAt: '2026-03-25T12:00:00.000Z',
      lastHealAttemptAt: '2026-03-25T12:00:01.000Z',
      lastHealSuccessAt: '2026-03-25T12:00:02.000Z',
      lastHealFailureAt: null,
      lastTriggerReason: 'latency spike cluster detected',
      lastHealedComponent: 'prompt_route',
      lastHealAction: 'activatePromptRouteMitigation:reduced_latency',
      lastHealResult: 'success',
      lastHealRun: '2026-03-25T12:00:02.000Z',
      systemState: {
        errorRate: 0,
        latency: 0,
        lastCheck: null,
        operationalRequests: 0
      },
      triggerReason: 'latency spike cluster detected',
      actionTaken: 'activatePromptRouteMitigation:reduced_latency',
      healedComponent: 'prompt_route',
      recentEvents: [
        { id: 'fallback-1', timestamp: '2026-03-25T11:59:00.000Z', kind: 'fallback' },
        { id: 'success-1', timestamp: '2026-03-25T12:00:02.000Z', kind: 'success' }
      ],
      loop: {
        loopRunning: true,
        activeMitigation: 'prompt:/api/openai/prompt:reduced_latency'
      },
      controlLoop: {
        active: true,
        loopRunning: true
      },
      promptRouteMitigation: {
        active: true,
        mode: 'reduced_latency'
      },
      trinity: {
        enabled: true,
        snapshot: {}
      },
      predictiveHealing: {
        enabled: false,
        dryRun: true
      }
    });

    const response = await request(createApp()).get('/status/safety/self-heal').expect(200);

    expect(buildSafetySelfHealSnapshotMock).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ok',
      enabled: true,
      active: true,
      lastTriggerAt: '2026-03-25T12:00:00.000Z',
      lastHealAttemptAt: '2026-03-25T12:00:01.000Z',
      lastHealSuccessAt: '2026-03-25T12:00:02.000Z',
      lastHealFailureAt: null,
      lastTriggerReason: 'latency spike cluster detected',
      lastHealedComponent: 'prompt_route',
      lastHealAction: 'activatePromptRouteMitigation:reduced_latency',
      lastHealResult: 'success',
      lastHealRun: '2026-03-25T12:00:02.000Z',
      isHealing: true,
      systemState: {
        errorRate: 0,
        latency: 0,
        lastCheck: null,
        operationalRequests: 0
      },
      triggerReason: 'latency spike cluster detected',
      actionTaken: 'activatePromptRouteMitigation:reduced_latency',
      healedComponent: 'prompt_route',
      recentEvents: expect.arrayContaining([
        expect.objectContaining({ kind: 'fallback' }),
        expect.objectContaining({ kind: 'success' })
      ]),
      loop: expect.objectContaining({
        loopRunning: true,
        activeMitigation: 'prompt:/api/openai/prompt:reduced_latency'
      }),
      controlLoop: expect.objectContaining({
        active: true,
        loopRunning: true
      }),
      promptRouteMitigation: expect.objectContaining({
        active: true,
        mode: 'reduced_latency'
      }),
      trinity: {
        enabled: true,
        snapshot: {}
      },
      predictiveHealing: expect.objectContaining({
        enabled: false,
        dryRun: true
      })
    }));
  });

  it('falls back to the autonomous control loop when bounded telemetry is idle', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      inFlight: false,
      loopRunning: false,
      activeMitigation: null,
      lastAction: null,
      lastActionAt: null,
      lastTick: null,
      lastLatencySnapshot: null,
      lastVerificationResult: null
    });
    getSelfHealingControlLoopStatusMock.mockReturnValue({
      active: true,
      loopRunning: true,
      incidentActive: true,
      executionStatus: 'running',
      mitigation: { activeAction: 'restart_service' },
      lastDiagnosis: 'timeout cluster across operational routes',
      lastAction: 'restart_service',
      lastActionAt: '2026-03-25T12:04:00.000Z',
      lastObservedAt: '2026-03-25T12:03:30.000Z',
      errorRate: 0.21,
      avgLatencyMs: 2300,
      operationalRequests: 14
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({
      enabled: false,
      snapshot: {}
    });
    getPromptRouteMitigationStateMock.mockReturnValue({
      active: false,
      mode: null,
      route: '/api/openai/prompt'
    });
    inferSelfHealComponentFromActionMock.mockImplementation((actionTaken?: string | null) => {
      if (actionTaken === 'restart_service') {
        return 'service_runtime';
      }
      return null;
    });
    buildSelfHealTelemetrySnapshotMock.mockReturnValue({
      enabled: false,
      active: false,
      lastTrigger: null,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFallback: null,
      triggerReason: null,
      actionTaken: null,
      healedComponent: null,
      recentEvents: [],
      persistence: {
        mode: 'local_memory_dir',
        durable: false,
        restoredFromDisk: false,
        lastLoadedAt: null,
        lastSavedAt: null,
        lastSaveError: null
      }
    });
    buildPredictiveHealingStatusSnapshotMock.mockReturnValue({
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
    });
    buildSafetySelfHealSnapshotMock.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-25T12:04:01.000Z',
      enabled: true,
      active: true,
      isHealing: true,
      lastTriggerAt: '2026-03-25T12:03:30.000Z',
      lastHealAttemptAt: '2026-03-25T12:04:00.000Z',
      lastHealSuccessAt: null,
      lastHealFailureAt: null,
      lastTriggerReason: 'timeout cluster across operational routes',
      lastHealedComponent: 'service_runtime',
      lastHealAction: 'restart_service',
      lastHealResult: 'running',
      lastHealRun: '2026-03-25T12:04:00.000Z',
      systemState: {
        errorRate: 0.21,
        latency: 2300,
        lastCheck: '2026-03-25T12:03:30.000Z',
        operationalRequests: 14
      },
      controlLoop: {
        incidentActive: true,
        executionStatus: 'running',
        lastAction: 'restart_service'
      }
    });

    const response = await request(createApp()).get('/status/safety/self-heal').expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      enabled: true,
      active: true,
      isHealing: true,
      lastTriggerAt: '2026-03-25T12:03:30.000Z',
      lastHealAttemptAt: '2026-03-25T12:04:00.000Z',
      lastTriggerReason: 'timeout cluster across operational routes',
      lastHealAction: 'restart_service',
      lastHealResult: 'running',
      lastHealRun: '2026-03-25T12:04:00.000Z',
      lastHealedComponent: 'service_runtime',
      systemState: {
        errorRate: 0.21,
        latency: 2300,
        lastCheck: '2026-03-25T12:03:30.000Z',
        operationalRequests: 14
      },
      controlLoop: expect.objectContaining({
        incidentActive: true,
        executionStatus: 'running',
        lastAction: 'restart_service'
      })
    }));
  });

  it('preserves observed zero-valued control loop metrics instead of falling back to bounded loop history', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      inFlight: false,
      loopRunning: true,
      activeMitigation: null,
      lastAction: null,
      lastActionAt: null,
      lastTick: '2026-03-25T12:03:00.000Z',
      lastLatencySnapshot: {
        requestCount: 19,
        avgLatencyMs: 1800
      },
      lastVerificationResult: {
        current: {
          errorRate: 0.4,
          avgLatencyMs: 2200,
          promptRoute: {
            requestCount: 7
          }
        },
        baseline: {
          errorRate: 0.5,
          avgLatencyMs: 2500
        }
      }
    });
    getSelfHealingControlLoopStatusMock.mockReturnValue({
      active: true,
      loopRunning: true,
      incidentActive: false,
      executionStatus: null,
      mitigation: { activeAction: null },
      lastDiagnosis: 'healthy',
      lastAction: null,
      lastActionAt: null,
      lastObservedAt: '2026-03-25T12:04:00.000Z',
      errorRate: 0,
      avgLatencyMs: 0,
      operationalRequests: 0
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({
      enabled: true,
      snapshot: {}
    });
    getPromptRouteMitigationStateMock.mockReturnValue({
      active: false,
      mode: null,
      route: '/api/openai/prompt'
    });
    inferSelfHealComponentFromActionMock.mockReturnValue(null);
    buildSelfHealTelemetrySnapshotMock.mockReturnValue({
      enabled: true,
      active: false,
      lastTrigger: null,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFallback: null,
      triggerReason: null,
      actionTaken: null,
      healedComponent: null,
      recentEvents: [],
      persistence: {
        mode: 'local_memory_dir',
        durable: false,
        restoredFromDisk: false,
        lastLoadedAt: null,
        lastSavedAt: null,
        lastSaveError: null
      }
    });
    buildPredictiveHealingStatusSnapshotMock.mockReturnValue({
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
    });
    buildSafetySelfHealSnapshotMock.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-25T12:04:01.000Z',
      enabled: true,
      active: false,
      isHealing: false,
      lastTriggerAt: null,
      lastHealAttemptAt: null,
      lastHealSuccessAt: null,
      lastHealFailureAt: null,
      lastTriggerReason: null,
      lastHealedComponent: null,
      lastHealAction: null,
      lastHealResult: null,
      lastHealRun: null,
      systemState: {
        errorRate: 0,
        latency: 0,
        lastCheck: '2026-03-25T12:04:00.000Z',
        operationalRequests: 0
      }
    });

    const response = await request(createApp()).get('/status/safety/self-heal').expect(200);

    expect(response.body.systemState).toEqual({
      errorRate: 0,
      latency: 0,
      lastCheck: '2026-03-25T12:04:00.000Z',
      operationalRequests: 0
    });
  });

  it('returns a compact self-heal summary from /status/safety', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      inFlight: false,
      loopRunning: true,
      activeMitigation: null,
      lastAction: 'healWorkerRuntime:started'
    });
    getSelfHealingControlLoopStatusMock.mockReturnValue({
      active: false,
      loopRunning: false,
      incidentActive: false,
      executionStatus: null,
      mitigation: { activeAction: null },
      lastDiagnosis: null,
      lastAction: null,
      lastActionAt: null,
      lastObservedAt: null,
      errorRate: 0,
      avgLatencyMs: 0,
      operationalRequests: 0
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({
      enabled: true,
      snapshot: {}
    });
    getPromptRouteMitigationStateMock.mockReturnValue({
      active: false,
      mode: null
    });
    inferSelfHealComponentFromActionMock.mockReturnValue('worker_runtime');
    buildSelfHealTelemetrySnapshotMock.mockReturnValue({
      enabled: true,
      active: false,
      lastTrigger: null,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFallback: null,
      triggerReason: null,
      actionTaken: 'healWorkerRuntime:started',
      healedComponent: 'worker_runtime',
      recentEvents: []
    });
    buildCompactSelfHealSummaryMock.mockReturnValue({
      enabled: true,
      active: false,
      lastEventAt: '2026-03-25T12:00:00.000Z',
      lastEventKind: 'success',
      lastTriggerAt: '2026-03-25T11:59:59.000Z',
      lastAttemptAt: '2026-03-25T11:59:58.000Z',
      triggerReason: 'sentinel-public-self-heal-secret',
      actionTaken: 'sentinel-public-self-heal-action',
      healedComponent: 'sentinel-public-self-heal-component',
      recentEventCount: 3,
      detailsPath: '/status/safety/self-heal'
    });
    buildPredictiveHealingStatusSnapshotMock.mockReturnValue({
      enabled: true,
      dryRun: true,
      autoExecute: false,
      lastObservedAt: '2026-03-25T12:00:00.000Z',
      lastDecisionAt: '2026-03-25T12:00:00.000Z',
      lastAction: 'scale_workers_up',
      lastResult: 'dry_run',
      lastMatchedRule: 'latency_rising_scale_up',
      recentAuditCount: 1,
      recentAudits: [],
      recentObservations: [],
      cooldowns: {},
      detailsPath: '/api/self-heal/decide',
      advisors: ['rules_v1']
    });
    buildPredictiveHealingCompactSummaryMock.mockReturnValue({
      enabled: true,
      dryRun: true,
      autoExecute: false,
      lastObservedAt: '2026-03-25T12:00:00.000Z',
      lastDecisionAt: '2026-03-25T12:00:00.000Z',
      lastAction: 'scale_workers_up',
      lastResult: 'dry_run',
      recentAuditCount: 1,
      detailsPath: '/api/self-heal/decide'
    });

    const response = await request(createApp()).get('/status/safety').expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      status: 'safe',
      selfHealing: {
        enabled: true,
        active: false,
        lastEventAt: '2026-03-25T12:00:00.000Z',
        lastEventKind: 'success',
        lastTriggerAt: '2026-03-25T11:59:59.000Z',
        lastAttemptAt: '2026-03-25T11:59:58.000Z',
        recentEventCount: 3,
        detailsPath: '/status/safety/self-heal'
      },
      predictiveHealing: {
        enabled: true,
        dryRun: true,
        autoExecute: false,
        lastObservedAt: '2026-03-25T12:00:00.000Z',
        lastDecisionAt: '2026-03-25T12:00:00.000Z',
        lastAction: 'scale_workers_up',
        lastResult: 'dry_run',
        recentAuditCount: 1,
        detailsPath: '/api/self-heal/decide'
      }
    }));
    expect(response.body.selfHealing).not.toHaveProperty('triggerReason');
    expect(response.body.selfHealing).not.toHaveProperty('actionTaken');
    expect(response.body.selfHealing).not.toHaveProperty('healedComponent');
    expect(JSON.stringify(response.body)).not.toContain('sentinel-public-self-heal');
  });

  it('keeps raw safety identifiers in authenticated detail only', async () => {
    const quarantineId = 'quarantine-sensitive-123';
    const expectedHash = 'expected-hash-sensitive-456';
    const entityId = 'worker:sensitive-789';
    const quarantineReason = 'sensitive integrity reason';
    getActiveUnsafeConditionsMock.mockReturnValueOnce([{
      conditionId: 'condition-sensitive-123',
      code: 'PATTERN_INTEGRITY_FAILURE',
      message: 'sensitive condition message',
      blocking: true,
      createdAt: '2026-03-25T12:00:00.000Z',
      monotonicTsMs: 1,
      quarantineId,
      metadata: { expectedHash, entityId },
    }]);
    getActiveQuarantinesMock.mockReturnValueOnce([{
      quarantineId,
      kind: 'integrity',
      reason: quarantineReason,
      integrityFailure: true,
      autoRecoverable: false,
      createdAt: '2026-03-25T12:00:00.000Z',
      monotonicTsMs: 1,
      metadata: { expectedHash, entityId },
    }]);
    getSafetyRuntimeSnapshotMock.mockReturnValueOnce({
      counters: {
        duplicateSuppressions: 1,
        quarantineActivations: 2,
        workerFailures: { [entityId]: { count: 3, windowStartedMs: 1, lastFailureMs: 2 } },
        heartbeatMisses: { [entityId]: 4 },
        healthyCycles: { [entityId]: 5 },
      },
    });
    getSelfHealingLoopStatusMock.mockReturnValue({
      loopRunning: false,
      activeMitigation: null,
      lastAction: null,
    });
    getTrinitySelfHealingStatusMock.mockReturnValue({ enabled: false });
    getPromptRouteMitigationStateMock.mockReturnValue({ active: false });
    buildSelfHealTelemetrySnapshotMock.mockReturnValue({});
    buildCompactSelfHealSummaryMock.mockReturnValue({ status: 'idle' });
    buildPredictiveHealingStatusSnapshotMock.mockReturnValue({});
    buildPredictiveHealingCompactSummaryMock.mockReturnValue({ status: 'idle' });

    const publicResponse = await request(createApp(false))
      .get('/status/safety')
      .expect(200);
    const publicJson = JSON.stringify(publicResponse.body);

    expect(publicResponse.headers['cache-control']).toBe('no-store');
    expect(publicResponse.body).toMatchObject({
      activeConditionCount: 1,
      activeQuarantineCount: 1,
      activeConditions: [{
        code: 'PATTERN_INTEGRITY_FAILURE',
        blocking: true,
      }],
      activeQuarantines: [{
        kind: 'integrity',
        integrityFailure: true,
        autoRecoverable: false,
      }],
      counters: {
        duplicateSuppressions: 1,
        quarantineActivations: 2,
        workerFailureEvents: 3,
        heartbeatMissEvents: 4,
        healthyCycleEvents: 5,
      },
    });
    for (const sensitiveValue of [
      quarantineId,
      expectedHash,
      entityId,
      quarantineReason,
      'condition-sensitive-123',
      'sensitive condition message',
    ]) {
      expect(publicJson).not.toContain(sensitiveValue);
    }

    getActiveUnsafeConditionsMock.mockReturnValueOnce([{
      conditionId: 'condition-sensitive-123',
      code: 'PATTERN_INTEGRITY_FAILURE',
      message: 'sensitive condition message',
      blocking: true,
      createdAt: '2026-03-25T12:00:00.000Z',
      monotonicTsMs: 1,
      quarantineId,
      metadata: { expectedHash, entityId },
    }]);
    getActiveQuarantinesMock.mockReturnValueOnce([{
      quarantineId,
      kind: 'integrity',
      reason: quarantineReason,
      integrityFailure: true,
      autoRecoverable: false,
      createdAt: '2026-03-25T12:00:00.000Z',
      monotonicTsMs: 1,
      metadata: { expectedHash, entityId },
    }]);
    getSafetyRuntimeSnapshotMock.mockReturnValueOnce({
      counters: {
        duplicateSuppressions: 1,
        quarantineActivations: 2,
        workerFailures: { [entityId]: { count: 3, windowStartedMs: 1, lastFailureMs: 2 } },
        heartbeatMisses: { [entityId]: 4 },
        healthyCycles: { [entityId]: 5 },
      },
    });
    buildSafetySelfHealSnapshotMock.mockReturnValueOnce({ status: 'ok' });

    const detailResponse = await request(createApp())
      .get('/status/safety/self-heal')
      .expect(200);
    expect(detailResponse.body.safetyState.activeQuarantines[0].quarantineId)
      .toBe(quarantineId);
    expect(detailResponse.body.safetyState.activeConditions[0].metadata.expectedHash)
      .toBe(expectedHash);
    expect(detailResponse.body.safetyState.counters.workerFailures)
      .toHaveProperty(entityId);
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
});
