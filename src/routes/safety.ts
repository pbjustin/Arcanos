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

const router = express.Router();

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
  res.json({
    status: hasUnsafeBlockingConditions() ? 'unsafe' : 'safe',
    timestamp: new Date().toISOString(),
    activeConditions: getActiveUnsafeConditions(),
    activeQuarantines: getActiveQuarantines(),
    counters: snapshot.counters,
    selfHealing: {
      loop: getSelfHealingLoopStatus(),
      trinity: getTrinitySelfHealingStatus()
    }
  });
});

/**
 * GET /status/safety/self-heal
 * Purpose: expose bounded self-healing state for operator diagnostics.
 */
router.get('/status/safety/self-heal', (_req: Request, res: Response) => {
  const loopStatus = getSelfHealingLoopStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    active: loopStatus.active,
    loopRunning: loopStatus.loopRunning,
    startedAt: loopStatus.startedAt,
    lastTick: loopStatus.lastTick,
    tickCount: loopStatus.tickCount,
    lastError: loopStatus.lastError,
    intervalMs: loopStatus.intervalMs,
    lastDiagnosis: loopStatus.lastDiagnosis,
    lastAction: loopStatus.lastAction,
    lastActionAt: loopStatus.lastActionAt,
    lastControllerDecision: loopStatus.lastControllerDecision,
    lastControllerRunAt: loopStatus.lastControllerRunAt,
    lastWorkerHealth: loopStatus.lastWorkerHealth,
    lastTrinityMitigation: loopStatus.lastTrinityMitigation,
    lastEvidence: loopStatus.lastEvidence,
    lastVerificationResult: loopStatus.lastVerificationResult,
    activeMitigation: loopStatus.activeMitigation,
    attemptsByDiagnosis: loopStatus.attemptsByDiagnosis,
    cooldowns: loopStatus.cooldowns,
    lastHealthyObservedAt: loopStatus.lastHealthyObservedAt,
    promptRouteMitigation: getPromptRouteMitigationState(),
    trinity: getTrinitySelfHealingStatus()
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
