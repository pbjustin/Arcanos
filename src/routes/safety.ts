import express, { Request, Response } from 'express';
import { z } from 'zod';
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
import { buildSafetySelfHealSnapshot } from '@services/selfHealRuntimeInspectionService.js';
import {
  isControlPlaneHttpAuthenticationConfigured,
  requireControlPlaneHttpScopes,
} from '@services/controlPlane/httpAuth.js';
import {
  selfHealingControlHttpBoundary,
} from '@services/controlPlane/selfHealingControlHttpBoundary.js';
import {
  selfImproveControlRateLimit,
} from '@services/controlPlane/selfHealingControlRateLimits.js';

const router = express.Router();
const requireSelfHealSafetyReadScope = requireControlPlaneHttpScopes(
  ['arcanos:read'],
  'self_heal.safety_status_authorization.denied'
);
const requireSafetyQuarantineReleaseScope = requireControlPlaneHttpScopes(
  ['self-improve:control'],
  'safety.quarantine_release_authorization.denied'
);
const safetyQuarantineReleaseBodySchema = z.object({
  confirmation: z.string().max(264).optional(),
  note: z.string().trim().min(1).max(256).optional(),
}).strict();
const safetyQuarantineIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const publicSafetyTimestampSchema = z.string().max(40).datetime({ offset: true });

function normalizePublicSafetyTimestamp(value: string | null): string | null {
  const parsed = publicSafetyTimestampSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function buildPublicSelfHealSummary(
  summary: ReturnType<typeof buildCompactSelfHealSummary>
) {
  return {
    enabled: summary.enabled === true,
    active: summary.active === true,
    lastEventAt: normalizePublicSafetyTimestamp(summary.lastEventAt),
    lastEventKind: summary.lastEventKind,
    lastTriggerAt: normalizePublicSafetyTimestamp(summary.lastTriggerAt),
    lastAttemptAt: normalizePublicSafetyTimestamp(summary.lastAttemptAt),
    recentEventCount:
      Number.isInteger(summary.recentEventCount) &&
      summary.recentEventCount >= 0 &&
      summary.recentEventCount <= 100
        ? summary.recentEventCount
        : 0,
    detailsPath: '/status/safety/self-heal' as const
  };
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
    controlPlaneAuth: {
      required: true,
      mode: 'purpose-bound-bearer',
      configured: isControlPlaneHttpAuthenticationConfigured(),
      acceptedCredentials: ['Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>'],
      protectedEndpoints: [
        'GET /status/safety/self-heal',
        'POST /status/safety/quarantine/:quarantineId/release'
      ]
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
  const activeConditions = getActiveUnsafeConditions();
  const activeQuarantines = getActiveQuarantines();
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
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: hasUnsafeBlockingConditions() ? 'unsafe' : 'safe',
    timestamp: new Date().toISOString(),
    activeConditionCount: activeConditions.length,
    activeQuarantineCount: activeQuarantines.length,
    activeConditions: activeConditions.map(({ code, blocking }) => ({
      code,
      blocking,
    })),
    activeQuarantines: activeQuarantines.map(({
      kind,
      integrityFailure,
      autoRecoverable,
    }) => ({
      kind,
      integrityFailure,
      autoRecoverable,
    })),
    counters: {
      duplicateSuppressions: snapshot.counters.duplicateSuppressions,
      quarantineActivations: snapshot.counters.quarantineActivations,
      workerFailureEvents: Object.values(snapshot.counters.workerFailures)
        .reduce((total, counter) => total + counter.count, 0),
      heartbeatMissEvents: Object.values(snapshot.counters.heartbeatMisses)
        .reduce((total, count) => total + count, 0),
      healthyCycleEvents: Object.values(snapshot.counters.healthyCycles)
        .reduce((total, count) => total + count, 0),
    },
    selfHealing: buildPublicSelfHealSummary(buildCompactSelfHealSummary(selfHealTelemetry)),
    predictiveHealing: buildPredictiveHealingCompactSummary(predictiveHealing)
  });
});

/**
 * GET /status/safety/self-heal
 * Purpose: expose bounded self-healing state for operator diagnostics.
 */
router.use('/status/safety/self-heal', selfHealingControlHttpBoundary);
router.get('/status/safety/self-heal', requireSelfHealSafetyReadScope, (_req: Request, res: Response) => {
  const safetySnapshot = getSafetyRuntimeSnapshot();
  res.json({
    ...buildSafetySelfHealSnapshot(),
    safetyState: {
      activeConditions: getActiveUnsafeConditions(),
      activeQuarantines: getActiveQuarantines(),
      counters: safetySnapshot.counters,
    },
  });
});

/**
 * POST /status/safety/quarantine/:quarantineId/release
 * Purpose: Explicit release flow for integrity quarantines.
 */
router.use('/status/safety/quarantine', selfHealingControlHttpBoundary);
router.post(
  '/status/safety/quarantine/:quarantineId/release',
  selfImproveControlRateLimit,
  requireSafetyQuarantineReleaseScope,
  (req: Request, res: Response) => {
    const quarantineIdResult = safetyQuarantineIdSchema.safeParse(req.params.quarantineId);
    const bodyResult = safetyQuarantineReleaseBodySchema.safeParse(req.body ?? {});
    if (!quarantineIdResult.success || !bodyResult.success) {
      sendBadRequestPayload(res, {
        error: 'INVALID_SAFETY_RELEASE_PAYLOAD',
        details: ['Quarantine release input is invalid.'],
      });
      return;
    }

    const quarantineId = quarantineIdResult.data;
    const actor = req.controlPlanePrincipal?.principalId;
    if (!actor) {
      res.status(403).json({
        error: 'CONTROL_PLANE_FORBIDDEN',
      });
      return;
    }

    const headerConfirmed = resolveHeader(req.headers, 'x-confirmed')?.toLowerCase() === 'yes';
    const bodyConfirmation = bodyResult.data.confirmation;
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
      actor,
      releaseNote: bodyResult.data.note,
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
        actor
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
