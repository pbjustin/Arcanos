import express, { Request, Response } from 'express';
import { sendBadRequestPayload, sendNotFoundPayload } from '@shared/http/index.js';
import {
  getActiveQuarantines,
  getActiveUnsafeConditions,
  getSafetyRuntimeSnapshot,
  hasUnsafeBlockingConditions,
  releaseQuarantine
} from '../services/safety/runtimeState.js';
import { emitSafetyAuditEvent } from '../services/safety/auditEvents.js';
import { assertDeterministicConfirmation } from '../services/safety/aiOutputBoundary.js';
import { resolveHeader } from '@transport/http/requestHeaders.js';
import { getTrinitySelfHealingStatus } from '@services/selfImprove/selfHealingV2.js';
import { getSelfHealingLoopStatus } from '@services/selfImprove/selfHealingLoop.js';
import { getPromptRouteMitigationState } from '@services/openai/promptRouteMitigation.js';
import {
  buildCompactSelfHealSummary,
  buildSelfHealTelemetrySnapshot,
  inferSelfHealComponentFromAction
} from '@services/selfImprove/selfHealTelemetry.js';
import {
  buildPredictiveHealingCompactSummary,
  buildPredictiveHealingStatusSnapshot
} from '@services/selfImprove/predictiveHealingService.js';
import { getSelfHealingControlLoopStatus } from '@services/selfImprove/controlLoop.js';

const router = express.Router();

function getEventTimestamp(event: { timestamp?: string | null } | null | undefined): string | null {
  return event?.timestamp ?? null;
}

function pickLatestTimestamp(...timestamps: Array<string | null | undefined>): string | null {
  let latestTimestamp: string | null = null;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;

  for (const timestamp of timestamps) {
    if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
      continue;
    }

    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < latestTimestampMs) {
      continue;
    }

    latestTimestamp = timestamp;
    latestTimestampMs = timestampMs;
  }

  return latestTimestamp;
}

function getLastSelfHealResultEvent(
  recentEvents: Array<{
    kind?: string | null;
    timestamp?: string | null;
    actionTaken?: string | null;
    healedComponent?: string | null;
  }>
) {
  for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
    const event = recentEvents[index];
    if (event.kind === 'success' || event.kind === 'failure' || event.kind === 'noop' || event.kind === 'fallback') {
      return event;
    }
  }

  return null;
}

/**
 * GET /status/safety/operator-auth
 * Purpose: Expose non-secret operator authentication requirements for diagnostics.
 */
router.get('/status/safety/operator-auth', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    operatorAuth: {
      required: false,
      mode: 'disabled',
      configured: false,
      acceptedCredentials: [],
      protectedEndpoints: []
    },
    diagnostics: {
      publicEndpoints: ['GET /health', 'GET /healthz', 'GET /status/safety', 'GET /status/safety/operator-auth']
    }
  });
});

/**
 * GET /status/safety
 * Purpose: Expose active safety conditions, quarantines, and counters.
 */
router.get('/status/safety', (_req: Request, res: Response) => {
  const snapshot = getSafetyRuntimeSnapshot();
  const loopStatus = getSelfHealingLoopStatus();
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const selfHealTelemetry = buildSelfHealTelemetrySnapshot({
    enabled: loopStatus.loopRunning || trinityStatus.enabled,
    active: Boolean(loopStatus.activeMitigation || promptRouteMitigation.active),
    currentActionTaken: loopStatus.lastAction,
    currentHealedComponent: inferSelfHealComponentFromAction(loopStatus.lastAction)
  });
  const predictiveHealing = buildPredictiveHealingStatusSnapshot();
  res.json({
    status: hasUnsafeBlockingConditions() ? 'unsafe' : 'safe',
    timestamp: new Date().toISOString(),
    activeConditions: getActiveUnsafeConditions(),
    activeQuarantines: getActiveQuarantines(),
    counters: snapshot.counters,
    selfHealing: buildCompactSelfHealSummary(selfHealTelemetry),
    predictiveHealing: buildPredictiveHealingCompactSummary(predictiveHealing)
  });
});

/**
 * GET /status/safety/self-heal
 * Purpose: expose bounded self-healing state for operator diagnostics.
 */
router.get('/status/safety/self-heal', (_req: Request, res: Response) => {
  const loopStatus = getSelfHealingLoopStatus();
  const controlLoop = getSelfHealingControlLoopStatus();
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const currentHealedComponent =
    inferSelfHealComponentFromAction(loopStatus.lastAction) ??
    inferSelfHealComponentFromAction(controlLoop.lastAction);
  const selfHealTelemetry = buildSelfHealTelemetrySnapshot({
    enabled: loopStatus.loopRunning || trinityStatus.enabled || controlLoop.active || controlLoop.loopRunning,
    active: Boolean(
      loopStatus.inFlight ||
      loopStatus.activeMitigation ||
      promptRouteMitigation.active ||
      controlLoop.incidentActive ||
      controlLoop.executionStatus === 'running' ||
      controlLoop.mitigation.activeAction
    ),
    currentActionTaken: loopStatus.lastAction,
    currentHealedComponent
  });
  const predictiveHealing = buildPredictiveHealingStatusSnapshot();
  const lastHealResultEvent = getLastSelfHealResultEvent(selfHealTelemetry.recentEvents);
  const combinedEnabled = Boolean(
    selfHealTelemetry.enabled ||
    controlLoop.active ||
    controlLoop.loopRunning
  );
  const combinedActive = Boolean(
    selfHealTelemetry.active ||
    loopStatus.inFlight ||
    controlLoop.incidentActive ||
    controlLoop.executionStatus === 'running' ||
    controlLoop.mitigation.activeAction
  );
  const lastTriggerAt = getEventTimestamp(selfHealTelemetry.lastTrigger) ?? controlLoop.lastObservedAt;
  const lastHealAttemptAt = getEventTimestamp(selfHealTelemetry.lastAttempt) ?? controlLoop.lastActionAt;
  const lastHealAction = lastHealResultEvent?.actionTaken ?? selfHealTelemetry.actionTaken ?? controlLoop.lastAction;
  const lastHealResult =
    lastHealResultEvent?.kind ??
    controlLoop.executionStatus ??
    controlLoop.lastResult ??
    null;
  const lastTriggerReason =
    selfHealTelemetry.lastTrigger?.reason ??
    selfHealTelemetry.triggerReason ??
    controlLoop.lastDiagnosis;
  const lastHealedComponent =
    lastHealResultEvent?.healedComponent ??
    selfHealTelemetry.healedComponent ??
    inferSelfHealComponentFromAction(controlLoop.lastAction);
  const lastHealRun = pickLatestTimestamp(
    lastHealAttemptAt,
    getEventTimestamp(selfHealTelemetry.lastSuccess),
    getEventTimestamp(selfHealTelemetry.lastFailure),
    controlLoop.lastActionAt,
    loopStatus.lastActionAt
  );
  const systemState = {
    errorRate:
      controlLoop.errorRate ??
      loopStatus.lastVerificationResult?.current.errorRate ??
      loopStatus.lastVerificationResult?.baseline.errorRate ??
      0,
    latency:
      controlLoop.avgLatencyMs ??
      loopStatus.lastLatencySnapshot?.avgLatencyMs ??
      loopStatus.lastVerificationResult?.current.avgLatencyMs ??
      loopStatus.lastVerificationResult?.baseline.avgLatencyMs ??
      0,
    lastCheck: controlLoop.lastObservedAt ?? loopStatus.lastTick ?? null,
    operationalRequests:
      controlLoop.operationalRequests ??
      loopStatus.lastLatencySnapshot?.requestCount ??
      loopStatus.lastVerificationResult?.current.promptRoute?.requestCount ??
      0
  };

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    enabled: combinedEnabled,
    active: combinedActive,
    isHealing: combinedActive,
    lastTriggerAt,
    lastHealAttemptAt,
    lastHealSuccessAt: getEventTimestamp(selfHealTelemetry.lastSuccess),
    lastHealFailureAt: getEventTimestamp(selfHealTelemetry.lastFailure),
    lastTriggerReason,
    lastHealedComponent,
    lastHealAction,
    lastHealResult,
    lastHealRun,
    systemState,
    loopRunning: loopStatus.loopRunning,
    inFlight: loopStatus.inFlight,
    lastDiagnosis: loopStatus.lastDiagnosis,
    lastAction: loopStatus.lastAction,
    lastActionAt: loopStatus.lastActionAt,
    lastError: loopStatus.lastError,
    activeMitigation: loopStatus.activeMitigation,
    degradedModeReason: loopStatus.degradedModeReason,
    recentTimeoutCounts: loopStatus.recentTimeoutCounts,
    lastVerificationResult: loopStatus.lastVerificationResult,
    lastTrigger: selfHealTelemetry.lastTrigger,
    lastAttempt: selfHealTelemetry.lastAttempt,
    lastSuccess: selfHealTelemetry.lastSuccess,
    lastFailure: selfHealTelemetry.lastFailure,
    lastFallback: selfHealTelemetry.lastFallback,
    triggerReason: selfHealTelemetry.triggerReason,
    actionTaken: selfHealTelemetry.actionTaken,
    healedComponent: selfHealTelemetry.healedComponent,
    recentEvents: selfHealTelemetry.recentEvents,
    persistence: selfHealTelemetry.persistence,
    loop: loopStatus,
    controlLoop,
    promptRouteMitigation,
    trinity: trinityStatus,
    predictiveHealing
  });
});

/**
 * POST /status/safety/quarantine/:quarantineId/release
 * Purpose: Explicit release flow for integrity quarantines.
 */
router.post(
  '/status/safety/quarantine/:quarantineId/release',
  (req: Request, res: Response) => {
    const { quarantineId } = req.params;
    const headerConfirmed = resolveHeader(req.headers, 'x-confirmed')?.toLowerCase() === 'yes';
    const bodyConfirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation : undefined;
    const deterministicConfirmation =
      headerConfirmed || bodyConfirmation === `release:${quarantineId}`;

    try {
      assertDeterministicConfirmation({
        action: 'release_quarantine',
        deterministicConfirmation,
        source: 'routes/safety.release'
      });
    } catch (error) {
      sendBadRequestPayload(res, {
        error: 'CONFIRMATION_REQUIRED',
        details: [
          error instanceof Error ? error.message : String(error),
          `Set header x-confirmed: yes or body.confirmation to "release:${quarantineId}".`
        ]
      });
      return;
    }

    const releaseResult = releaseQuarantine(quarantineId, {
      actor: req.operatorActor || 'operator:unknown',
      releaseNote: typeof req.body?.note === 'string' ? req.body.note : undefined,
      integrityOnly: true
    });

    if (!releaseResult.released) {
      if (releaseResult.reason === 'not_found') {
        sendNotFoundPayload(res, {
          error: 'QUARANTINE_NOT_FOUND',
          quarantineId
        });
        return;
      }

      if (releaseResult.reason === 'not_integrity') {
        res.status(409).json({
          error: 'INTEGRITY_RELEASE_ONLY',
          details: ['This endpoint only releases integrity quarantines.'],
          quarantineId
        });
        return;
      }

      res.status(409).json({
        error: 'QUARANTINE_NOT_RELEASED',
        reason: releaseResult.reason,
        quarantineId
      });
      return;
    }

    emitSafetyAuditEvent({
      event: 'operator_quarantine_release',
      severity: 'warn',
      details: {
        quarantineId,
        actor: req.operatorActor || 'operator:unknown'
      }
    });

    res.json({
      released: true,
      quarantineId,
      releasedAt: releaseResult.quarantine?.releasedAt,
      releasedBy: releaseResult.quarantine?.releasedBy
    });
  }
);

export default router;
