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
  authenticateControlPlaneHttpRequest,
  authorizeControlPlaneHttpScopes,
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
} from './httpAuth.js';

export const SYSTEM_STATE_READ_SCOPE = 'arcanos:read';
export const SYSTEM_STATE_MUTATION_SCOPE = 'mcp:invoke';

const SYSTEM_STATE_PATH = '/system-state';
const SYSTEM_STATE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const SYSTEM_STATE_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_SYSTEM_STATE_CLIENT_RATE_LIMIT = 120;
const systemStateBoundaryApplied = Symbol('systemStateBoundaryApplied');

type SystemStateOperationKind = 'mutation' | 'read';

interface SystemStateOperation {
  kind: SystemStateOperationKind;
  scope: string;
}

const SYSTEM_STATE_OPERATIONS = new Map<string, SystemStateOperation>([
  [`GET ${SYSTEM_STATE_PATH}`, {
    kind: 'read',
    scope: SYSTEM_STATE_READ_SCOPE,
  }],
  [`POST ${SYSTEM_STATE_PATH}`, {
    kind: 'mutation',
    scope: SYSTEM_STATE_MUTATION_SCOPE,
  }],
]);

const SYSTEM_STATE_PRINCIPAL_POLICIES: Readonly<
  Record<SystemStateOperationKind, RateLimitPolicy>
> = Object.freeze({
  mutation: {
    bucketName: 'system-state-mutation',
    maxRequests: 10,
    windowMs: SYSTEM_STATE_RATE_LIMIT_WINDOW_MS,
  },
  read: {
    bucketName: 'system-state-read',
    maxRequests: 60,
    windowMs: SYSTEM_STATE_READ_RATE_LIMIT_WINDOW_MS,
  },
});

type SystemStateBoundaryRequest = Request & {
  [systemStateBoundaryApplied]?: true;
};

export interface SystemStateHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeSystemStateRequestPath(req: Request): string {
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

function resolveSystemStateOperation(req: Request): SystemStateOperation | null {
  const method = req.method.toUpperCase() === 'HEAD'
    ? 'GET'
    : req.method.toUpperCase();
  return SYSTEM_STATE_OPERATIONS.get(
    `${method} ${normalizeSystemStateRequestPath(req)}`
  ) ?? null;
}

function setSystemStateNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendSystemStateNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate, authorize, and throttle direct system-state control traffic.
 *
 * The boundary is idempotent so application composition can establish trust
 * before broad body parsing while the router retains the same protection when
 * mounted independently.
 */
export function createSystemStateHttpBoundary(
  options: SystemStateHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs
    ?? SYSTEM_STATE_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'system-state-client',
    maxRequests: options.maxClientRequests
      ?? DEFAULT_SYSTEM_STATE_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:system-state`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'system-state-principal',
    maxRequests: 10,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveSystemStateOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...SYSTEM_STATE_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveSystemStateOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'system_state.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setSystemStateNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as SystemStateBoundaryRequest;
    if (boundaryRequest[systemStateBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[systemStateBoundaryApplied] = true;

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

      if (!resolveSystemStateOperation(req)) {
        sendSystemStateNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const systemStateHttpBoundary = createSystemStateHttpBoundary();
