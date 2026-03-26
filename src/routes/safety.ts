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

const router = express.Router();

function getEventTimestamp(event: { timestamp?: string | null } | null | undefined): string | null {
  return event?.timestamp ?? null;
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
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const selfHealTelemetry = buildSelfHealTelemetrySnapshot({
    enabled: loopStatus.loopRunning || trinityStatus.enabled,
    active: Boolean(loopStatus.activeMitigation || promptRouteMitigation.active),
    currentActionTaken: loopStatus.lastAction,
    currentHealedComponent: inferSelfHealComponentFromAction(loopStatus.lastAction)
  });
  const predictiveHealing = buildPredictiveHealingStatusSnapshot();
  const lastHealResultEvent = getLastSelfHealResultEvent(selfHealTelemetry.recentEvents);

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    enabled: selfHealTelemetry.enabled,
    active: selfHealTelemetry.active,
    lastTriggerAt: getEventTimestamp(selfHealTelemetry.lastTrigger),
    lastHealAttemptAt: getEventTimestamp(selfHealTelemetry.lastAttempt),
    lastHealSuccessAt: getEventTimestamp(selfHealTelemetry.lastSuccess),
    lastHealFailureAt: getEventTimestamp(selfHealTelemetry.lastFailure),
    lastTriggerReason: selfHealTelemetry.lastTrigger?.reason ?? selfHealTelemetry.triggerReason,
    lastHealedComponent: lastHealResultEvent?.healedComponent ?? selfHealTelemetry.healedComponent,
    lastHealAction: lastHealResultEvent?.actionTaken ?? selfHealTelemetry.actionTaken,
    lastHealResult: lastHealResultEvent?.kind ?? null,
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
