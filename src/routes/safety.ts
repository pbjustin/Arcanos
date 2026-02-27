import express, { Request, Response } from 'express';
import operatorAuth from '@transport/http/middleware/operatorAuth.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
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

const router = express.Router();

/**
 * GET /status/safety/operator-auth
 * Purpose: Expose non-secret operator authentication requirements for diagnostics.
 * Inputs/Outputs: No input; returns auth requirement metadata and safe probe routes.
 * Edge cases: Reports configured=false when ADMIN_KEY is missing.
 */
router.get('/status/safety/operator-auth', (_req: Request, res: Response) => {
  const configuredAdminKey = getConfig().adminKey?.trim();
  //audit Assumption: diagnostics must not leak secrets; failure risk: key exposure; expected invariant: report only booleans and route metadata; handling strategy: never return raw credential values.
  const isConfigured = Boolean(configuredAdminKey);
  //audit Assumption: auth mode should reflect ADMIN_KEY presence; failure risk: caller assumes key enforcement when disabled; expected invariant: required=true only when configured; handling strategy: derive from config in response payload.
  const authRequired = isConfigured;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    operatorAuth: {
      required: authRequired,
      mode: authRequired ? 'enforced' : 'disabled',
      configured: isConfigured,
      acceptedCredentials: ['Authorization: Bearer <ADMIN_KEY>', 'x-api-key: <ADMIN_KEY>'],
      protectedEndpoints: ['POST /status/safety/quarantine/:quarantineId/release']
    },
    diagnostics: {
      publicEndpoints: ['GET /health', 'GET /healthz', 'GET /status/safety', 'GET /status/safety/operator-auth']
    }
  });
});

/**
 * GET /status/safety
 * Purpose: Expose active safety conditions, quarantines, and counters.
 * Inputs/Outputs: No input; returns runtime safety snapshot summary.
 * Edge cases: Includes historical counters while filtering active controls.
 */
router.get('/status/safety', (_req: Request, res: Response) => {
  const snapshot = getSafetyRuntimeSnapshot();
  res.json({
    status: hasUnsafeBlockingConditions() ? 'unsafe' : 'safe',
    timestamp: new Date().toISOString(),
    activeConditions: getActiveUnsafeConditions(),
    activeQuarantines: getActiveQuarantines(),
    counters: snapshot.counters
  });
});

/**
 * POST /status/safety/quarantine/:quarantineId/release
 * Purpose: Operator-only explicit release flow for integrity quarantines.
 * Inputs/Outputs: quarantineId path param + deterministic confirmation; returns release status.
 * Edge cases: Rejects non-integrity quarantine release from this endpoint.
 */
router.post(
  '/status/safety/quarantine/:quarantineId/release',
  operatorAuth,
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
      //audit Assumption: release requires explicit deterministic confirmation; failure risk: accidental irreversible release; expected invariant: confirmation challenge must be satisfied; handling strategy: reject with 400.
      res.status(400).json({
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
        res.status(404).json({
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

