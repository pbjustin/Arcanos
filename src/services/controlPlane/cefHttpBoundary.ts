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

export const CEF_READ_SCOPE = 'arcanos:read';
export const CEF_EXECUTION_SCOPE = 'mcp:invoke';

const CEF_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CEF_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_CEF_CLIENT_RATE_LIMIT = 60;
const cefBoundaryApplied = Symbol('cefBoundaryApplied');

export type CefHttpOperationKind = 'execution' | 'read';

export interface CefHttpOperation {
  kind: CefHttpOperationKind;
  scope: string;
}

const CEF_HTTP_OPERATIONS = new Map<string, CefHttpOperation>([
  ['GET /api/commands', {
    kind: 'read',
    scope: CEF_READ_SCOPE,
  }],
  ['GET /api/commands/health', {
    kind: 'read',
    scope: CEF_READ_SCOPE,
  }],
  ['POST /api/commands/execute', {
    kind: 'execution',
    scope: CEF_EXECUTION_SCOPE,
  }],
  ['POST /api/agent/execute', {
    kind: 'execution',
    scope: CEF_EXECUTION_SCOPE,
  }],
]);

const CEF_PRINCIPAL_POLICIES: Readonly<
  Record<CefHttpOperationKind, RateLimitPolicy>
> = Object.freeze({
  execution: {
    bucketName: 'cef-execution',
    maxRequests: 30,
    windowMs: CEF_RATE_LIMIT_WINDOW_MS,
  },
  read: {
    bucketName: 'cef-read',
    maxRequests: 120,
    windowMs: CEF_READ_RATE_LIMIT_WINDOW_MS,
  },
});

type CefBoundaryRequest = Request & {
  [cefBoundaryApplied]?: true;
};

export interface CefHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeCefRequestPath(req: Request): string {
  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  const rawPath = queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;

  if (rawPath.length > 1 && rawPath.endsWith('/')) {
    return rawPath.slice(0, -1);
  }

  return rawPath || '/';
}

function normalizeCefMethod(method: string): string {
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

export function resolveCefHttpOperation(req: Request): CefHttpOperation | null {
  return CEF_HTTP_OPERATIONS.get(
    `${normalizeCefMethod(req.method)} ${normalizeCefRequestPath(req)}`
  ) ?? null;
}

export function isCefCommandReadRequest(req: Request): boolean {
  const operation = resolveCefHttpOperation(req);
  return operation?.kind === 'read'
    && normalizeCefRequestPath(req).startsWith('/api/commands');
}

function setCefNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendCefNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate, authorize, and throttle direct CEF HTTP traffic.
 *
 * The boundary is idempotent so application composition can establish trust
 * before broad parsing while both leaf routers remain safe when mounted
 * independently.
 */
export function createCefHttpBoundary(
  options: CefHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs ?? CEF_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'cef-client',
    maxRequests: options.maxClientRequests ?? DEFAULT_CEF_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:cef`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'cef-principal',
    maxRequests: 30,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveCefHttpOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...CEF_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveCefHttpOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'cef.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setCefNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as CefBoundaryRequest;
    if (boundaryRequest[cefBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[cefBoundaryApplied] = true;

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

      if (!resolveCefHttpOperation(req)) {
        sendCefNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const cefHttpBoundary = createCefHttpBoundary();
