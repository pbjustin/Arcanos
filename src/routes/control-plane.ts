import express, { type NextFunction, type Request, type Response } from 'express';

import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';
import {
  executeControlPlaneRequest,
  getControlPlaneCapabilities
} from '@services/controlPlane/service.js';
import { validateControlPlaneRequestPayload } from '@services/controlPlane/schemas.js';
import type {
  ControlPlaneContext,
  ControlPlaneRequestPayload,
  ControlPlaneResponse
} from '@services/controlPlane/types.js';

const router = express.Router();
type ControlPlaneRequestValidation = ReturnType<typeof validateControlPlaneRequestPayload>;
const controlPlaneValidationKey = Symbol('controlPlaneValidation');

type ControlPlaneValidationRequest = Request & {
  [controlPlaneValidationKey]?: ControlPlaneRequestValidation;
};

function getControlPlaneRequestValidation(req: Request): ControlPlaneRequestValidation {
  const validationRequest = req as ControlPlaneValidationRequest;
  if (validationRequest[controlPlaneValidationKey]) {
    return validationRequest[controlPlaneValidationKey];
  }

  const validation = validateControlPlaneRequestPayload(req.body);
  validationRequest[controlPlaneValidationKey] = validation;
  return validation;
}

const controlPlaneRateLimit = createRateLimitMiddleware({
  bucketName: 'control-plane',
  maxRequests: 120,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:control-plane`,
  policyResolver: (req, defaultPolicy) => {
    if (req.method !== 'POST') {
      return defaultPolicy;
    }

    const validation = getControlPlaneRequestValidation(req);
    if (validation.ok && validation.data.phase === 'mutate') {
      return {
        bucketName: 'control-plane-mutate',
        maxRequests: 20,
        windowMs: defaultPolicy.windowMs
      };
    }

    return defaultPolicy;
  }
});

function requiresControlPlaneConfirmation(req: Request): boolean {
  const validation = getControlPlaneRequestValidation(req);
  return validation.ok && validation.data.phase === 'mutate';
}

function confirmMutatingControlPlaneRequest(req: Request, res: Response, next: NextFunction): void {
  if (requiresControlPlaneConfirmation(req)) {
    confirmGate(req, res, next);
    return;
  }

  next();
}

function resolveHttpControlPlaneContext(
  req: Request,
  existingContext: ControlPlaneContext | undefined
): ControlPlaneContext {
  const headerSessionId = req.header('x-session-id') ?? undefined;
  const authUser = req.authUser;
  const operatorActor = req.operatorActor;

  return {
    ...existingContext,
    sessionId: existingContext?.sessionId ?? headerSessionId,
    caller: existingContext?.caller ?? (
      authUser?.id !== undefined
        ? {
            id: String(authUser.id),
            type: 'http-auth-user'
          }
        : operatorActor
          ? {
              id: operatorActor,
              type: 'http-operator'
            }
          : {
              id: getRequestActorKey(req),
              type: 'http-request'
            }
    )
  };
}

function buildHttpControlPlaneRequest(
  req: Request,
  payload: ControlPlaneRequestPayload
): ControlPlaneRequestPayload {
  return {
    ...payload,
    requestId: payload.requestId ?? req.requestId,
    context: resolveHttpControlPlaneContext(req, payload.context)
  };
}

function resolveControlPlaneStatus(response: ControlPlaneResponse): number {
  if (response.ok) {
    return 200;
  }

  switch (response.error?.code) {
    case 'CONTROL_PLANE_APPROVAL_REQUIRED':
      return 403;
    case 'CONTROL_PLANE_ADAPTER_FAILED':
      return 502;
    case 'CONTROL_PLANE_FAILED':
      return 500;
    default:
      return 400;
  }
}

router.use('/api/control-plane', securityHeaders, controlPlaneRateLimit);

router.get('/api/control-plane/capabilities', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    capabilities: getControlPlaneCapabilities()
  });
});

router.post(
  '/api/control-plane',
  confirmMutatingControlPlaneRequest,
  async (req: Request, res: Response) => {
    const validation = getControlPlaneRequestValidation(req);
    if (!validation.ok) {
      res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_CONTROL_PLANE_REQUEST',
          message: 'Control-plane request failed schema validation.',
          issues: validation.issues
        }
      });
      return;
    }

    try {
      const response = await executeControlPlaneRequest(
        buildHttpControlPlaneRequest(req, validation.data)
      );
      res.status(resolveControlPlaneStatus(response)).json(response);
    } catch (error) {
      sendInternalErrorPayload(res, {
        ok: false,
        error: {
          code: 'CONTROL_PLANE_ROUTE_FAILED',
          message: resolveErrorMessage(error)
        }
      });
    }
  }
);

export default router;
