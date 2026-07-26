import express, { type NextFunction, type Request, type Response } from 'express';

import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  createRateLimitMiddleware,
  getRequestClientAddress,
  securityHeaders
} from '@platform/runtime/security.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';
import { resolveArcanosMcpPortFromRequest } from '@services/arcanosMcpPort.js';
import {
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator
} from '@services/controlPlane/httpAuth.js';
import {
  executeControlPlaneRequest,
  getControlPlaneCapabilities,
  getControlPlaneOperationRequiredScopes,
  requiresControlPlaneApproval
} from '@services/controlPlane/service.js';
import { validateControlPlaneRequestPayload } from '@services/controlPlane/schemas.js';
import type {
  ControlPlaneContext,
  ControlPlaneHttpPrincipal,
  ControlPlaneRequestPayload,
  ControlPlaneServiceResponse as ControlPlaneResponse
} from '@services/controlPlane/types.js';

const router = express.Router();
type ControlPlaneRequestValidation = ReturnType<typeof validateControlPlaneRequestPayload>;
const controlPlaneValidationKey = Symbol('controlPlaneValidation');

type ControlPlaneValidationRequest = Request & {
  [controlPlaneValidationKey]?: ControlPlaneRequestValidation;
};

function getControlPlaneRateLimitKey(req: Request): string {
  const expressClientIp = typeof req.ip === 'string' && req.ip.trim().length > 0
    ? req.ip.trim()
    : getRequestClientAddress(req);
  return `ip:${expressClientIp}:control-plane`;
}

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
  keyGenerator: getControlPlaneRateLimitKey,
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
  return validation.ok && requiresControlPlaneApproval(validation.data);
}

function confirmMutatingControlPlaneRequest(req: Request, res: Response, next: NextFunction): void {
  if (requiresControlPlaneConfirmation(req)) {
    confirmGate(req, res, next);
    return;
  }

  next();
}

function authorizeControlPlaneRequestScopes(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const validation = getControlPlaneRequestValidation(req);
  if (!validation.ok) {
    next();
    return;
  }

  const requiredScopes = getControlPlaneOperationRequiredScopes(validation.data);
  if (!requiredScopes) {
    next();
    return;
  }

  const grantedScopes = new Set(req.controlPlanePrincipal?.scopes ?? []);
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length === 0) {
    next();
    return;
  }

  req.logger?.warn?.('control_plane.http_authorization.denied', {
    reason: 'missing_scope',
    statusCode: 403,
    adapter: validation.data.adapter,
    operation: validation.data.operation,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json({
    ok: false,
    ...(req.requestId ? { requestId: req.requestId } : {}),
    error: {
      code: 'CONTROL_PLANE_SCOPE_DENIED',
      message: 'Control-plane operation is not permitted.',
    },
  });
}

function resolveHttpControlPlaneContext(
  req: Request,
  existingContext: ControlPlaneContext | undefined,
  controlPlanePrincipal: ControlPlaneHttpPrincipal
): ControlPlaneContext {
  const headerSessionId = req.header('x-session-id') ?? undefined;

  return {
    ...existingContext,
    sessionId: existingContext?.sessionId ?? headerSessionId,
    caller: {
      id: controlPlanePrincipal.principalId,
      type: controlPlanePrincipal.audience,
      scopes: [...controlPlanePrincipal.scopes]
    }
  };
}

function buildHttpControlPlaneRequest(
  req: Request,
  payload: ControlPlaneRequestPayload
): ControlPlaneRequestPayload {
  const controlPlanePrincipal = req.controlPlanePrincipal;
  if (!controlPlanePrincipal) {
    throw new Error('Authenticated control-plane principal is missing.');
  }

  return {
    ...payload,
    requestId: payload.requestId ?? req.requestId,
    context: resolveHttpControlPlaneContext(req, payload.context, controlPlanePrincipal),
    ...(payload.approval
      ? {
          approval: {
            ...payload.approval,
            approvedBy: controlPlanePrincipal.principalId
          }
        }
      : {})
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
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
  authorizeControlPlaneRequestScopes,
  confirmMutatingControlPlaneRequest,
  async (req: Request, res: Response) => {
    const validation = getControlPlaneRequestValidation(req);
    if (!validation.ok) {
      res.status(400).json({
        ok: false,
        requestId: req.requestId,
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
        buildHttpControlPlaneRequest(req, validation.data),
        {
          mcpClient: resolveArcanosMcpPortFromRequest(req),
        }
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
