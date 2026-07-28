import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import {
  executeSystemStateRequest,
  SYSTEM_STATE_SESSION_ID_MAX_LENGTH,
  SystemStateConflictError
} from '@services/systemState.js';
import { asyncHandler } from '@shared/http/index.js';
import { systemStateHttpBoundary } from '@services/controlPlane/systemStateHttpBoundary.js';
import { systemStateBodyParser } from '@services/controlPlane/systemStateBodyParser.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import type {
  ConfirmationChallengeBinding,
} from '@transport/http/middleware/confirmationChallengeStore.js';

const router = express.Router();
const SYSTEM_STATE_CONFIRMATION_WORKSPACE_ID = 'system-state:control-plane';

router.use('/system-state', systemStateHttpBoundary);

function buildSystemStateReadPayload(query: Request['query']): Record<string, unknown> {
  const sessionId = query.sessionId;
  if (sessionId === undefined) {
    return {};
  }
  if (
    typeof sessionId !== 'string'
    || sessionId.trim().length === 0
    || sessionId.trim().length > SYSTEM_STATE_SESSION_ID_MAX_LENGTH
  ) {
    throw new Error('system_state sessionId invalid');
  }
  return { sessionId: sessionId.trim() };
}

function sendSystemStateError(req: Request, res: Response, error: unknown): void {
  if (error instanceof SystemStateConflictError) {
    res.status(409).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.conflict
      }
    });
    return;
  }

  req.logger?.warn?.('system_state.request_invalid', {
    requestId: req.requestId,
    traceId: req.traceId,
    errorType: error instanceof Error ? error.name : typeof error,
  });
  res.status(400).json({
    ok: false,
    error: {
      code: 'BAD_REQUEST',
      message: 'System-state request is invalid.'
    }
  });
}

function buildSystemStateConfirmationBinding(
  req: Request,
  principalId: string
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId,
    workspaceId: SYSTEM_STATE_CONFIRMATION_WORKSPACE_ID,
  };
}

function requireSystemStateMutationConfirmation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const principalId = req.controlPlanePrincipal?.principalId;
  if (!principalId) {
    req.logger?.warn?.('system_state.confirmation_identity_unavailable', {
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

  confirmGate(req, res, next, {
    challengeBinding: buildSystemStateConfirmationBinding(req, principalId),
    requestFingerprintBody: req.body,
    requireChallengeToken: true,
  });
}

router.get('/system-state', asyncHandler(async (req, res) => {
  try {
    res.json(executeSystemStateRequest(buildSystemStateReadPayload(req.query)));
  } catch (error) {
    sendSystemStateError(req, res, error);
  }
}));

router.post(
  '/system-state',
  systemStateBodyParser,
  requireSystemStateMutationConfirmation,
  asyncHandler(async (req, res) => {
    try {
      res.json(executeSystemStateRequest(req.body));
    } catch (error) {
      sendSystemStateError(req, res, error);
    }
  })
);

export default router;
