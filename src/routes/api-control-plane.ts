import express, { type NextFunction, Request, Response } from 'express';

import {
  createRateLimitMiddleware,
  getRequestClientAddress,
  securityHeaders,
} from '@platform/runtime/security.js';
import { asyncHandler } from '@shared/http/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import { resolveArcanosMcpPortFromRequest } from '@services/arcanosMcpPort.js';
import {
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
} from '@services/controlPlane/httpAuth.js';
import { getControlPlaneOperationSpec } from '@services/controlPlane/allowlist.js';
import { safeParseControlPlaneRequest } from '@services/controlPlane/schema.js';
import {
  executeControlPlaneOperation,
  getControlPlaneDeepDiagnostics,
  listControlPlaneAllowlist,
} from '@services/controlPlane/index.js';

const router = express.Router();
type ControlPlaneRequestValidation = ReturnType<typeof safeParseControlPlaneRequest>;
const controlPlaneValidationKey = Symbol('controlPlaneInvokeValidation');

type ControlPlaneValidationRequest = Request & {
  [controlPlaneValidationKey]?: ControlPlaneRequestValidation;
};

function getControlPlaneRateLimitKey(req: Request): string {
  const expressClientIp = typeof req.ip === 'string' && req.ip.trim().length > 0
    ? req.ip.trim()
    : getRequestClientAddress(req);
  return `ip:${expressClientIp}:control-plane-operations`;
}

router.use(securityHeaders);
router.use(createRateLimitMiddleware({
  bucketName: 'control-plane',
  maxRequests: 30,
  windowMs: 15 * 60 * 1000,
  keyGenerator: getControlPlaneRateLimitKey,
}));

function resolveStatusCode(response: { ok: boolean; error?: { code?: string } }): number {
  if (response.ok) {
    return 200;
  }
  switch (response.error?.code) {
    case 'ERR_CONTROL_PLANE_SCHEMA':
    case 'ERR_CONTROL_PLANE_BAD_REQUEST':
      return 400;
    case 'ERR_CONTROL_PLANE_DENIED':
    case 'ERR_CONTROL_PLANE_GPT_POLICY':
    case 'ERR_CONTROL_PLANE_SCOPE':
      return 403;
    case 'ERR_CONTROL_PLANE_APPROVAL':
      return 428;
    default:
      return 500;
  }
}

function getControlPlaneRequestValidation(req: Request): ControlPlaneRequestValidation {
  const validationRequest = req as ControlPlaneValidationRequest;
  if (validationRequest[controlPlaneValidationKey]) {
    return validationRequest[controlPlaneValidationKey];
  }

  const validation = safeParseControlPlaneRequest(req.body);
  validationRequest[controlPlaneValidationKey] = validation;
  return validation;
}

function authorizeControlPlaneOperationScopes(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const validation = getControlPlaneRequestValidation(req);
  if (!validation.success) {
    next();
    return;
  }

  const operation = getControlPlaneOperationSpec(
    validation.data.provider,
    validation.data.operation
  );
  if (!operation) {
    next();
    return;
  }

  const grantedScopes = new Set(req.controlPlanePrincipal?.scopes ?? []);
  const missingScopes = operation.requiredScopes.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length === 0) {
    next();
    return;
  }

  req.logger?.warn?.('control_plane.http_authorization.denied', {
    reason: 'missing_scope',
    statusCode: 403,
    provider: validation.data.provider,
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

function buildAuthenticatedControlPlaneCandidate(req: Request): unknown {
  const principal = req.controlPlanePrincipal;
  if (!principal) {
    throw new Error('Authenticated control-plane principal is missing.');
  }

  const validation = getControlPlaneRequestValidation(req);
  if (validation.success) {
    return {
      ...validation.data,
      scope: [...principal.scopes],
      requestedBy: principal.principalId,
    };
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return req.body;
  }

  return {
    ...req.body,
    scope: [...principal.scopes],
    requestedBy: principal.principalId,
  };
}

router.get(
  '/allowlist',
  (_req: Request, res: Response) => {
    res.json({
      ok: true,
      operations: listControlPlaneAllowlist(),
    });
  }
);

router.get(
  '/deep-diagnostics',
  (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getControlPlaneDeepDiagnostics());
  }
);

router.post(
  '/operations',
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
  authorizeControlPlaneOperationScopes,
  confirmGate,
  asyncHandler(async (req: Request, res: Response) => {
    const response = await executeControlPlaneOperation(
      buildAuthenticatedControlPlaneCandidate(req),
      {
        request: req,
        mcpService: resolveArcanosMcpPortFromRequest(req),
      }
    );
    res.status(resolveStatusCode(response)).json(response);
  })
);

export default router;
