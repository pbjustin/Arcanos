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

export const REINFORCEMENT_READ_SCOPE = 'arcanos:read';
export const REINFORCEMENT_MUTATION_SCOPE = 'mcp:invoke';

const REINFORCEMENT_MUTATION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const REINFORCEMENT_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_REINFORCEMENT_CLIENT_RATE_LIMIT = 60;
const reinforcementBoundaryApplied = Symbol(
  'reinforcementBoundaryApplied'
);

export type ReinforcementHttpOperationKind = 'mutation' | 'read';

export interface ReinforcementHttpOperation {
  kind: ReinforcementHttpOperationKind;
  scope: string;
}

const REINFORCEMENT_HTTP_OPERATIONS = new Map<
  string,
  ReinforcementHttpOperation
>([
  ['POST /reinforce', {
    kind: 'mutation',
    scope: REINFORCEMENT_MUTATION_SCOPE,
  }],
  ['POST /audit', {
    kind: 'mutation',
    scope: REINFORCEMENT_MUTATION_SCOPE,
  }],
  ['POST /reinforcement/judge', {
    kind: 'mutation',
    scope: REINFORCEMENT_MUTATION_SCOPE,
  }],
  ['GET /memory', {
    kind: 'read',
    scope: REINFORCEMENT_READ_SCOPE,
  }],
  ['GET /memory/digest', {
    kind: 'read',
    scope: REINFORCEMENT_READ_SCOPE,
  }],
  ['GET /reinforcement/metrics', {
    kind: 'read',
    scope: REINFORCEMENT_READ_SCOPE,
  }],
]);

const REINFORCEMENT_PRINCIPAL_POLICIES: Readonly<
  Record<ReinforcementHttpOperationKind, RateLimitPolicy>
> = Object.freeze({
  mutation: {
    bucketName: 'reinforcement-mutation',
    maxRequests: 30,
    windowMs: REINFORCEMENT_MUTATION_RATE_LIMIT_WINDOW_MS,
  },
  read: {
    bucketName: 'reinforcement-read',
    maxRequests: 120,
    windowMs: REINFORCEMENT_READ_RATE_LIMIT_WINDOW_MS,
  },
});

type ReinforcementBoundaryRequest = Request & {
  [reinforcementBoundaryApplied]?: true;
};

export interface ReinforcementHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeReinforcementRequestPath(req: Request): string {
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

export function resolveReinforcementHttpOperation(
  req: Request
): ReinforcementHttpOperation | null {
  const requestMethod = req.method.toUpperCase() === 'HEAD'
    ? 'GET'
    : req.method.toUpperCase();
  return REINFORCEMENT_HTTP_OPERATIONS.get(
    `${requestMethod} ${normalizeReinforcementRequestPath(req)}`
  ) ?? null;
}

function setReinforcementNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendReinforcementNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate, authorize, and throttle reinforcement feedback and inspection.
 *
 * The boundary is idempotent so application composition can establish trust
 * before broad parsing while either owning router stays safe when mounted
 * independently.
 */
export function createReinforcementHttpBoundary(
  options: ReinforcementHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs
    ?? REINFORCEMENT_MUTATION_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'reinforcement-client',
    maxRequests: options.maxClientRequests
      ?? DEFAULT_REINFORCEMENT_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:reinforcement`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'reinforcement-principal',
    maxRequests: 30,
    windowMs: defaultWindowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveReinforcementHttpOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...REINFORCEMENT_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveReinforcementHttpOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'reinforcement.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setReinforcementNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as ReinforcementBoundaryRequest;
    if (boundaryRequest[reinforcementBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[reinforcementBoundaryApplied] = true;

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

      if (!resolveReinforcementHttpOperation(req)) {
        sendReinforcementNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const reinforcementHttpBoundary =
  createReinforcementHttpBoundary();
