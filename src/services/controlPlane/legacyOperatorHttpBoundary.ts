import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import {
  createRateLimitMiddleware,
  securityHeaders,
  type RateLimitPolicy,
} from '@platform/runtime/security.js';

import {
  authorizeControlPlaneHttpScopes,
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
} from './httpAuth.js';

export const LEGACY_OPERATOR_READ_SCOPE = 'arcanos:read';
export const LEGACY_OPERATOR_EXECUTION_SCOPE = 'mcp:invoke';

const LEGACY_OPERATOR_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LEGACY_OPERATOR_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_LEGACY_OPERATOR_CLIENT_RATE_LIMIT = 120;
const legacyOperatorBoundaryApplied = Symbol('legacyOperatorBoundaryApplied');

type LegacyOperatorOperationKind =
  | 'orchestration-mutation'
  | 'read'
  | 'sdk-mutation';

interface LegacyOperatorOperation {
  kind: LegacyOperatorOperationKind;
  scope: string;
}

const LEGACY_OPERATOR_OPERATIONS = new Map<string, LegacyOperatorOperation>([
  ['GET /orchestration/status', {
    kind: 'read',
    scope: LEGACY_OPERATOR_READ_SCOPE,
  }],
  ['POST /orchestration/purge', {
    kind: 'orchestration-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /orchestration/reset', {
    kind: 'orchestration-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['GET /sdk/diagnostics', {
    kind: 'read',
    scope: LEGACY_OPERATOR_READ_SCOPE,
  }],
  ['GET /sdk/workers/status', {
    kind: 'read',
    scope: LEGACY_OPERATOR_READ_SCOPE,
  }],
  ['POST /sdk/init-all', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/jobs/dispatch', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/research', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/routes/register', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/scheduler/activate', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/system-test', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/test-job', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
  ['POST /sdk/workers/init', {
    kind: 'sdk-mutation',
    scope: LEGACY_OPERATOR_EXECUTION_SCOPE,
  }],
]);

const LEGACY_OPERATOR_PRINCIPAL_POLICIES: Readonly<
  Record<LegacyOperatorOperationKind, RateLimitPolicy>
> = Object.freeze({
  'orchestration-mutation': {
    bucketName: 'legacy-orchestration-mutation',
    maxRequests: 2,
    windowMs: LEGACY_OPERATOR_RATE_LIMIT_WINDOW_MS,
  },
  read: {
    bucketName: 'legacy-operator-read',
    maxRequests: 60,
    windowMs: LEGACY_OPERATOR_READ_RATE_LIMIT_WINDOW_MS,
  },
  'sdk-mutation': {
    bucketName: 'legacy-sdk-mutation',
    maxRequests: 10,
    windowMs: LEGACY_OPERATOR_RATE_LIMIT_WINDOW_MS,
  },
});

type LegacyOperatorBoundaryRequest = Request & {
  [legacyOperatorBoundaryApplied]?: true;
};

export interface LegacyOperatorHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeLegacyOperatorRequestPath(req: Request): string {
  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  const rawPath = queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;
  const normalizedPath = rawPath.toLowerCase().replace(/\/+$/u, '');
  return normalizedPath || '/';
}

function resolveIngressClientAddress(req: Request): string {
  const expressAddress = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (expressAddress) {
    return expressAddress;
  }
  const socketAddress = typeof req.socket?.remoteAddress === 'string'
    ? req.socket.remoteAddress.trim()
    : '';
  return socketAddress || 'unknown';
}

function resolveLegacyOperatorOperation(
  req: Request
): LegacyOperatorOperation | null {
  const method = req.method.toUpperCase() === 'HEAD'
    ? 'GET'
    : req.method.toUpperCase();
  return LEGACY_OPERATOR_OPERATIONS.get(
    `${method} ${normalizeLegacyOperatorRequestPath(req)}`
  ) ?? null;
}

function setLegacyOperatorHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendLegacyOperatorNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

function sendLegacyOperationInProgress(
  req: Request,
  res: Response
): void {
  req.logger?.warn?.('legacy_operator.concurrent_request_rejected', {
    statusCode: 409,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Retry-After', '5');
  res.status(409).json({
    ok: false,
    error: {
      code: 'LEGACY_OPERATOR_OPERATION_IN_PROGRESS',
      message: 'A matching operator operation is already running.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

/**
 * Protect legacy SDK and orchestration surfaces before parsing and confirmation.
 */
export function createLegacyOperatorHttpBoundary(
  options: LegacyOperatorHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs
    ?? LEGACY_OPERATOR_RATE_LIMIT_WINDOW_MS;
  const activeMutationGroups = new Set<
    Exclude<LegacyOperatorOperationKind, 'read'>
  >();
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'legacy-operator-client',
    maxRequests: options.maxClientRequests
      ?? DEFAULT_LEGACY_OPERATOR_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:legacy-operator`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'legacy-operator-principal',
    maxRequests: 10,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveLegacyOperatorOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...LEGACY_OPERATOR_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveLegacyOperatorOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'legacy_operator.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setLegacyOperatorHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    requireOperationScope,
    principalRateLimit,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as LegacyOperatorBoundaryRequest;
    if (boundaryRequest[legacyOperatorBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[legacyOperatorBoundaryApplied] = true;

    let middlewareIndex = 0;
    const advance = ((error?: unknown): void => {
      if (error !== undefined) {
        next(error);
        return;
      }

      const middleware = middlewareChain[middlewareIndex];
      middlewareIndex += 1;
      if (middleware) {
        middleware(req, res, advance);
        return;
      }

      const operation = resolveLegacyOperatorOperation(req);
      if (!operation) {
        sendLegacyOperatorNotFound(res);
        return;
      }
      if (operation.kind === 'read') {
        next();
        return;
      }
      const mutationKind = operation.kind;
      if (activeMutationGroups.has(mutationKind)) {
        sendLegacyOperationInProgress(req, res);
        return;
      }

      activeMutationGroups.add(mutationKind);
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        activeMutationGroups.delete(mutationKind);
      };
      res.once('finish', release);
      res.once('close', release);
      next();
    }) as NextFunction;

    advance();
  };
}

export const legacyOperatorHttpBoundary =
  createLegacyOperatorHttpBoundary();
