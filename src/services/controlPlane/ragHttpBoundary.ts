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

export const RAG_QUERY_SCOPE = 'arcanos:read';
export const RAG_INGESTION_SCOPE = 'mcp:invoke';

const RAG_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RAG_QUERY_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_RAG_CLIENT_RATE_LIMIT = 60;
const ragBoundaryApplied = Symbol('ragBoundaryApplied');

export type RagHttpOperationKind = 'ingestion' | 'query';

export interface RagHttpOperation {
  kind: RagHttpOperationKind;
  scope: string;
}

const RAG_HTTP_OPERATIONS = new Map<string, RagHttpOperation>([
  ['POST /rag/fetch', {
    kind: 'ingestion',
    scope: RAG_INGESTION_SCOPE,
  }],
  ['POST /rag/save', {
    kind: 'ingestion',
    scope: RAG_INGESTION_SCOPE,
  }],
  ['POST /rag/query', {
    kind: 'query',
    scope: RAG_QUERY_SCOPE,
  }],
]);

const RAG_PRINCIPAL_POLICIES: Readonly<
  Record<RagHttpOperationKind, RateLimitPolicy>
> = Object.freeze({
  ingestion: {
    bucketName: 'rag-ingestion',
    maxRequests: 10,
    windowMs: RAG_RATE_LIMIT_WINDOW_MS,
  },
  query: {
    bucketName: 'rag-query',
    maxRequests: 30,
    windowMs: RAG_QUERY_RATE_LIMIT_WINDOW_MS,
  },
});

type RagBoundaryRequest = Request & {
  [ragBoundaryApplied]?: true;
};

export interface RagHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeRagRequestPath(req: Request): string {
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

export function resolveRagHttpOperation(req: Request): RagHttpOperation | null {
  return RAG_HTTP_OPERATIONS.get(
    `${req.method.toUpperCase()} ${normalizeRagRequestPath(req)}`
  ) ?? null;
}

function setRagNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendRagNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate, authorize, and throttle direct RAG HTTP traffic.
 *
 * The boundary is idempotent so the application can establish trust before
 * broad parsing while the router remains protected when mounted independently.
 */
export function createRagHttpBoundary(
  options: RagHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs ?? RAG_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'rag-client',
    maxRequests: options.maxClientRequests ?? DEFAULT_RAG_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:rag`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'rag-principal',
    maxRequests: 10,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveRagHttpOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...RAG_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveRagHttpOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'rag.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setRagNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as RagBoundaryRequest;
    if (boundaryRequest[ragBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[ragBoundaryApplied] = true;

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

      if (!resolveRagHttpOperation(req)) {
        sendRagNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const ragHttpBoundary = createRagHttpBoundary();
