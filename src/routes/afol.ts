import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { decide } from "@core/afol/engine.js";
import { getStatus } from "@core/afol/health.js";
import { getRecent, logError } from "@core/afol/logger.js";
import { getAnalyticsSnapshot } from "@core/afol/analytics.js";
import {
  AFOL_ROUTE_FAILURE_MESSAGE,
  projectAfolAnalyticsForHttp,
  projectAfolDecisionForHttp,
  projectAfolHealthForHttp,
  projectAfolLogsForHttp,
} from '@core/afol/redaction.js';
import { afolBodyParser } from '@services/controlPlane/afolBodyParser.js';
import {
  buildAfolConfirmationBinding,
  buildAfolDecisionConfirmationIntent,
} from '@services/controlPlane/afolConfirmation.js';
import { afolHttpBoundary } from '@services/controlPlane/afolHttpBoundary.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

const router = Router();

router.use(afolHttpBoundary, afolBodyParser);

type AfolInspectionSurface = 'logs' | 'analytics';

function sendAfolInspectionFailure(
  req: Request,
  res: Response,
  surface: AfolInspectionSurface,
  error: unknown
): void {
  try {
    req.logger?.warn?.('afol.inspection_unavailable', {
      requestId: req.requestId,
      traceId: req.traceId,
      surface,
      errorKind: error instanceof Error ? 'error' : 'non_error',
    });
  } catch {
    // Diagnostic logging must not prevent the fixed inspection response.
  }

  if (res.headersSent || res.writableEnded) {
    return;
  }
  res
    .status(503)
    .set('Cache-Control', 'no-store')
    .json({
      ok: false,
      error: {
        code: 'AFOL_INSPECTION_UNAVAILABLE',
        message: 'AFOL inspection data is temporarily unavailable.',
      },
    });
}

function requireAfolDecisionConfirmation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const principalId = req.controlPlanePrincipal?.principalId;
  if (!principalId) {
    req.logger?.warn?.('afol.confirmation_identity_unavailable', {
      requestId: req.requestId,
      traceId: req.traceId,
    });
    res.status(403).json({
      ok: false,
      error: {
        code: 'CONTROL_PLANE_FORBIDDEN',
        message: 'Control-plane operation is not permitted.',
      },
    });
    return;
  }

  let confirmationAccepted = false;
  confirmGate(req, res, () => {
    confirmationAccepted = true;
  }, {
    challengeBinding: buildAfolConfirmationBinding(req, principalId),
    requestFingerprintBody: buildAfolDecisionConfirmationIntent(req),
    requireChallengeToken: true,
  });
  if (!confirmationAccepted) {
    return;
  }
  if (req.confirmationContext?.usedChallengeToken !== true) {
    res.status(403).json({
      ok: false,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: 'AFOL execution requires a consumed confirmation challenge.',
      },
    });
    return;
  }
  next();
}

router.post('/decide', requireAfolDecisionConfirmation, async (req, res) => {
  try {
    const result = await decide(req.body ?? {});
    res.json(projectAfolDecisionForHttp(result));
  } catch (error) {
    req.logger?.error?.('afol.decision_failed', {
      requestId: req.requestId,
      traceId: req.traceId,
      errorKind: error instanceof Error ? 'error' : 'non_error',
    });
    try {
      await logError('decide', new Error(AFOL_ROUTE_FAILURE_MESSAGE));
    } catch {
      req.logger?.warn?.('afol.failure_log_unavailable', {
        requestId: req.requestId,
        traceId: req.traceId,
      });
    }
    res.status(500).json({
      ok: false,
      error: {
        code: 'AFOL_DECISION_FAILED',
        message: 'AFOL decision could not be completed.',
      },
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  }
});

router.get('/health', (_req, res) => {
  res.json(projectAfolHealthForHttp(getStatus()));
});

router.get('/logs', async (req, res) => {
  try {
    const recent = await getRecent();
    if (!res.headersSent && !res.writableEnded) {
      res.json(projectAfolLogsForHttp(recent));
    }
  } catch (error) {
    sendAfolInspectionFailure(req, res, 'logs', error);
  }
});

router.get('/analytics', async (req, res) => {
  try {
    const snapshot = await getAnalyticsSnapshot();
    if (!res.headersSent && !res.writableEnded) {
      res.json(projectAfolAnalyticsForHttp(snapshot));
    }
  } catch (error) {
    sendAfolInspectionFailure(req, res, 'analytics', error);
  }
});

export default router;
