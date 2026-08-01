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

export const DAG_READ_SCOPE = 'arcanos:read';
export const DAG_EXECUTION_SCOPE = 'mcp:invoke';

const DAG_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DAG_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DAG_CLIENT_RATE_LIMIT = 120;
const dagBoundaryApplied = Symbol('dagBoundaryApplied');
const dagHttpOperationOverride = Symbol('dagHttpOperationOverride');

type DagHttpOperationKind = 'execution' | 'admission' | 'read';

interface DagHttpOperation {
  kind: DagHttpOperationKind;
  scope: string;
}

const DAG_EXECUTION_OPERATION: DagHttpOperation = Object.freeze({
  kind: 'execution',
  scope: DAG_EXECUTION_SCOPE,
});

const DAG_READ_PATH_PATTERNS = [
  /^\/dag\/runs\/latest$/u,
  /^\/dag\/runs\/[^/]+$/u,
  /^\/dag\/runs\/[^/]+\/(?:trace|tree|events|metrics|errors|lineage|verification)$/u,
  /^\/dag\/runs\/[^/]+\/nodes\/[^/]+$/u,
];
const DAG_CREATE_PATH_PATTERN = /^\/dag\/runs$/u;
const DAG_CANCEL_PATH_PATTERN = /^\/dag\/runs\/[^/]+\/cancel$/u;
const DAG_ADMISSION_PATH_PATTERN = /^\/dag\/runs\/[^/]+\/admission$/u;

const DAG_PRINCIPAL_POLICIES: Readonly<
  Record<DagHttpOperationKind, RateLimitPolicy>
> = Object.freeze({
  execution: {
    bucketName: 'api-arcanos-dag-execution',
    maxRequests: 60,
    windowMs: DAG_RATE_LIMIT_WINDOW_MS,
  },
  admission: {
    bucketName: 'api-arcanos-dag-admission',
    maxRequests: 900,
    windowMs: DAG_READ_RATE_LIMIT_WINDOW_MS,
  },
  read: {
    bucketName: 'api-arcanos-dag-read',
    maxRequests: 900,
    windowMs: DAG_READ_RATE_LIMIT_WINDOW_MS,
  },
});

type DagBoundaryRequest = Request & {
  [dagBoundaryApplied]?: true;
  [dagHttpOperationOverride]?: DagHttpOperation;
};

export interface DagHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeDagRequestPath(req: Request): string {
  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  const rawPath = queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;
  const normalizedPath = rawPath.toLowerCase().replace(/\/+$/u, '') || '/';
  const apiPrefix = '/api/arcanos';

  return normalizedPath.startsWith(`${apiPrefix}/dag`)
    ? normalizedPath.slice(apiPrefix.length)
    : normalizedPath;
}

export function isDagHttpRequestPath(req: Request): boolean {
  const path = normalizeDagRequestPath(req);
  return path === '/dag' || path.startsWith('/dag/');
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

export function resolveDagHttpOperation(req: Request): DagHttpOperation | null {
  const operationOverride = (req as DagBoundaryRequest)[dagHttpOperationOverride];
  if (operationOverride) {
    return operationOverride;
  }

  const method = req.method.toUpperCase() === 'HEAD'
    ? 'GET'
    : req.method.toUpperCase();
  const path = normalizeDagRequestPath(req);

  if (
    method === 'GET'
    && DAG_READ_PATH_PATTERNS.some((pattern) => pattern.test(path))
  ) {
    return {
      kind: 'read',
      scope: DAG_READ_SCOPE,
    };
  }

  if (
    method === 'GET'
    && DAG_ADMISSION_PATH_PATTERN.test(path)
  ) {
    return {
      kind: 'admission',
      scope: DAG_EXECUTION_SCOPE,
    };
  }

  if (
    method === 'POST'
    && (
      DAG_CREATE_PATH_PATTERN.test(path)
      || DAG_CANCEL_PATH_PATTERN.test(path)
    )
  ) {
    return {
      kind: 'execution',
      scope: DAG_EXECUTION_SCOPE,
    };
  }

  return null;
}

function wrapDagExecutionHttpBoundary(boundary: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    (req as DagBoundaryRequest)[dagHttpOperationOverride] = DAG_EXECUTION_OPERATION;
    boundary(req, res, next);
  };
}

function setDagNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendDagNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate, authorize, and throttle direct DAG control traffic.
 *
 * The boundary is idempotent so application composition can establish trust
 * before broad body parsing while the router remains protected when mounted
 * independently.
 */
export function createDagHttpBoundary(
  options: DagHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs ?? DAG_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'api-arcanos-dag-client',
    maxRequests: options.maxClientRequests ?? DEFAULT_DAG_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:api-arcanos-dag`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'api-arcanos-dag-principal',
    maxRequests: 60,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveDagHttpOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...DAG_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveDagHttpOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'api_arcanos_dag.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setDagNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as DagBoundaryRequest;
    if (boundaryRequest[dagBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[dagBoundaryApplied] = true;

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

      if (!resolveDagHttpOperation(req)) {
        sendDagNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const dagHttpBoundary = createDagHttpBoundary();
export const dagExecutionHttpBoundary = wrapDagExecutionHttpBoundary(dagHttpBoundary);

export function createDagExecutionHttpBoundary(
  options: DagHttpBoundaryOptions = {}
): RequestHandler {
  return wrapDagExecutionHttpBoundary(createDagHttpBoundary(options));
}
