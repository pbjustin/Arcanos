import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const getSelfHealingLoopStatusMock = jest.fn();
const getTrinitySelfHealingStatusMock = jest.fn();
const getPromptRouteMitigationStateMock = jest.fn();
const buildSelfHealTelemetrySnapshotMock = jest.fn();
const buildCompactSelfHealSummaryMock = jest.fn();
const inferSelfHealComponentFromActionMock = jest.fn();
const inferSelfHealComponentFromRequestMock = jest.fn();
const recordSelfHealEventMock = jest.fn();
const buildPredictiveHealingStatusSnapshotMock = jest.fn();
const buildPredictiveHealingCompactSummaryMock = jest.fn();

jest.unstable_mockModule('@services/selfImprove/selfHealingLoop.js', () => ({
  getSelfHealingLoopStatus: getSelfHealingLoopStatusMock
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

jest.unstable_mockModule('../src/services/safety/runtimeState.js', () => ({
  activateUnsafeCondition: jest.fn(),
  buildUnsafeToProceedPayload: jest.fn(() => ({
    error: 'UNSAFE_TO_PROCEED',
    conditions: [],
    quarantineIds: [],
    timestamp: '2026-03-25T12:00:00.000Z'
  })),
  clearUnsafeCondition: jest.fn(() => false),
  clearUnsafeConditionsByQuarantine: jest.fn(() => 0),
  getActiveQuarantines: jest.fn(() => []),
  getActiveUnsafeConditions: jest.fn(() => []),
  getTrustedHash: jest.fn(() => undefined),
  getSafetyRuntimeSnapshot: jest.fn(() => ({
    counters: {
      duplicateSuppressions: 0,
      quarantineActivations: 0,
      workerFailures: {},
      heartbeatMisses: {},
      healthyCycles: {}
    }
  })),
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

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

describe('safety self-heal routes', () => {
  it('returns structured self-heal telemetry with nested subsystem status', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      loopRunning: true,
      activeMitigation: 'prompt:/api/openai/prompt:reduced_latency',
      lastAction: 'activatePromptRouteMitigation:reduced_latency'
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

    const response = await request(createApp()).get('/status/safety/self-heal').expect(200);

    expect(buildSelfHealTelemetrySnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      active: true,
      currentActionTaken: 'activatePromptRouteMitigation:reduced_latency',
      currentHealedComponent: 'prompt_route'
    }));
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

  it('returns a compact self-heal summary from /status/safety', async () => {
    getSelfHealingLoopStatusMock.mockReturnValue({
      loopRunning: true,
      activeMitigation: null,
      lastAction: 'healWorkerRuntime:started'
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
      triggerReason: 'worker stall detected',
      actionTaken: 'healWorkerRuntime:started',
      healedComponent: 'worker_runtime',
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
        triggerReason: 'worker stall detected',
        actionTaken: 'healWorkerRuntime:started',
        healedComponent: 'worker_runtime',
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
  });
});
