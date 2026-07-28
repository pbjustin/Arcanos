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

export const AFOL_READ_SCOPE = 'arcanos:read';
export const AFOL_EXECUTION_SCOPE = 'mcp:invoke';

const AFOL_EXECUTION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AFOL_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_AFOL_CLIENT_RATE_LIMIT = 60;
const afolBoundaryApplied = Symbol('afolBoundaryApplied');

export type AfolHttpOperationKind = 'execution' | 'read';

export interface AfolHttpOperation {
  kind: AfolHttpOperationKind;
  scope: string;
}

const AFOL_HTTP_OPERATIONS = new Map<string, AfolHttpOperation>([
  ['POST /api/afol/decide', {
    kind: 'execution',
    scope: AFOL_EXECUTION_SCOPE,
  }],
  ['GET /api/afol/health', {
    kind: 'read',
    scope: AFOL_READ_SCOPE,
  }],
  ['GET /api/afol/logs', {
    kind: 'read',
    scope: AFOL_READ_SCOPE,
  }],
  ['GET /api/afol/analytics', {
    kind: 'read',
    scope: AFOL_READ_SCOPE,
  }],
]);

const AFOL_PRINCIPAL_POLICIES: Readonly<
  Record<AfolHttpOperationKind, RateLimitPolicy>
> = Object.freeze({
  execution: {
    bucketName: 'afol-execution',
    maxRequests: 30,
    windowMs: AFOL_EXECUTION_RATE_LIMIT_WINDOW_MS,
  },
  read: {
    bucketName: 'afol-read',
    maxRequests: 120,
    windowMs: AFOL_READ_RATE_LIMIT_WINDOW_MS,
  },
});

type AfolBoundaryRequest = Request & {
  [afolBoundaryApplied]?: true;
};

export interface AfolHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeAfolRequestPath(req: Request): string {
  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  const rawPath = queryIndex >= 0
    ? requestUrl.slice(0, queryIndex)
    : requestUrl;
  const lowerPath = rawPath.toLowerCase();
  const normalizedPath = lowerPath.length > 1 && lowerPath.endsWith('/')
    ? lowerPath.slice(0, -1)
    : lowerPath;
  return normalizedPath || '/';
}

function normalizeAfolRequestMethod(method: string): string {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === 'HEAD' ? 'GET' : normalizedMethod;
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

export function resolveAfolHttpOperation(
  req: Request
): AfolHttpOperation | null {
  return AFOL_HTTP_OPERATIONS.get(
    `${normalizeAfolRequestMethod(req.method)} ${normalizeAfolRequestPath(req)}`
  ) ?? null;
}

export function isAfolReadRequest(req: Request): boolean {
  return resolveAfolHttpOperation(req)?.kind === 'read';
}

function setAfolNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendAfolNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate, authorize, and throttle AFOL execution and inspection traffic.
 *
 * The boundary is idempotent so the application can establish trust before
 * broad parsing while the leaf router remains safe when mounted independently.
 */
export function createAfolHttpBoundary(
  options: AfolHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs
    ?? AFOL_EXECUTION_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'afol-client',
    maxRequests: options.maxClientRequests ?? DEFAULT_AFOL_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:afol`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'afol-principal',
    maxRequests: 30,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveAfolHttpOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...AFOL_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveAfolHttpOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'afol.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setAfolNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as AfolBoundaryRequest;
    if (boundaryRequest[afolBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[afolBoundaryApplied] = true;

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

      if (!resolveAfolHttpOperation(req)) {
        sendAfolNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const afolHttpBoundary = createAfolHttpBoundary();
