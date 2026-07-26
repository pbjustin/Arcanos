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

export const DIAGNOSTIC_EXECUTION_SCOPE = 'diagnostics:execute';
export const REPOSITORY_VERIFICATION_SCOPE = 'repo:verify';

const DIAGNOSTIC_EXECUTION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PR_ANALYSIS_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_DIAGNOSTIC_CLIENT_RATE_LIMIT = 30;
const diagnosticExecutionBoundaryApplied = Symbol(
  'diagnosticExecutionBoundaryApplied'
);

type DiagnosticExecutionKind =
  | 'daily-summary'
  | 'pr-analysis'
  | 'self-test';

type DiagnosticExecutionGroup = 'devops' | 'pr-analysis';

const DIAGNOSTIC_EXECUTION_PATHS = new Map<string, DiagnosticExecutionKind>([
  ['/api/pr-analysis/analyze', 'pr-analysis'],
  ['/devops/daily-summary', 'daily-summary'],
  ['/devops/self-test', 'self-test'],
]);

const DIAGNOSTIC_EXECUTION_PRINCIPAL_POLICIES: Readonly<
  Record<DiagnosticExecutionKind, RateLimitPolicy>
> = Object.freeze({
  'daily-summary': {
    bucketName: 'diagnostic-devops',
    maxRequests: 5,
    windowMs: DIAGNOSTIC_EXECUTION_RATE_LIMIT_WINDOW_MS,
  },
  'pr-analysis': {
    bucketName: 'diagnostic-pr-analysis',
    maxRequests: 2,
    windowMs: PR_ANALYSIS_RATE_LIMIT_WINDOW_MS,
  },
  'self-test': {
    bucketName: 'diagnostic-devops',
    maxRequests: 5,
    windowMs: DIAGNOSTIC_EXECUTION_RATE_LIMIT_WINDOW_MS,
  },
});

type DiagnosticExecutionBoundaryRequest = Request & {
  [diagnosticExecutionBoundaryApplied]?: true;
};

export interface DiagnosticExecutionHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeDiagnosticExecutionRequestPath(req: Request): string {
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

function resolveDiagnosticExecutionKind(
  req: Request
): DiagnosticExecutionKind | null {
  if (req.method.toUpperCase() !== 'POST') {
    return null;
  }
  return DIAGNOSTIC_EXECUTION_PATHS.get(
    normalizeDiagnosticExecutionRequestPath(req)
  ) ?? null;
}

function resolveDiagnosticExecutionGroup(
  kind: DiagnosticExecutionKind
): DiagnosticExecutionGroup {
  return kind === 'pr-analysis' ? 'pr-analysis' : 'devops';
}

function setDiagnosticExecutionHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendDiagnosticExecutionNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

function sendDiagnosticExecutionInProgress(
  req: Request,
  res: Response
): void {
  req.logger?.warn?.('diagnostic_execution.concurrent_request_rejected', {
    statusCode: 409,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Retry-After', '5');
  res.status(409).json({
    ok: false,
    error: {
      code: 'DIAGNOSTIC_EXECUTION_IN_PROGRESS',
      message: 'A matching diagnostic operation is already running.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

/**
 * Authenticate, authorize, throttle, and serialize expensive diagnostic
 * execution before request-body parsing.
 */
export function createDiagnosticExecutionHttpBoundary(
  options: DiagnosticExecutionHttpBoundaryOptions = {}
): RequestHandler {
  const windowMs = options.windowMs
    ?? DIAGNOSTIC_EXECUTION_RATE_LIMIT_WINDOW_MS;
  const activeOperations = new Set<DiagnosticExecutionGroup>();
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'diagnostic-execute-client',
    maxRequests: options.maxClientRequests
      ?? DEFAULT_DIAGNOSTIC_CLIENT_RATE_LIMIT,
    windowMs,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:diagnostic-execute`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'diagnostic-execute-principal',
    maxRequests: 2,
    windowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const kind = resolveDiagnosticExecutionKind(req);
      if (!kind) {
        return defaultPolicy;
      }
      const configuredPolicy = DIAGNOSTIC_EXECUTION_PRINCIPAL_POLICIES[kind];
      return {
        ...configuredPolicy,
        ...(options.windowMs === undefined ? {} : { windowMs }),
      };
    },
  });
  const requireDiagnosticExecutionScope: RequestHandler = (
    req,
    res,
    next
  ): void => {
    const kind = resolveDiagnosticExecutionKind(req);
    if (!kind) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [
        kind === 'pr-analysis'
          ? REPOSITORY_VERIFICATION_SCOPE
          : DIAGNOSTIC_EXECUTION_SCOPE,
      ],
      'diagnostic_execution.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setDiagnosticExecutionHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    requireDiagnosticExecutionScope,
    principalRateLimit,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as DiagnosticExecutionBoundaryRequest;
    if (boundaryRequest[diagnosticExecutionBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[diagnosticExecutionBoundaryApplied] = true;

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

      const kind = resolveDiagnosticExecutionKind(req);
      if (!kind) {
        sendDiagnosticExecutionNotFound(res);
        return;
      }
      const group = resolveDiagnosticExecutionGroup(kind);
      if (activeOperations.has(group)) {
        sendDiagnosticExecutionInProgress(req, res);
        return;
      }

      activeOperations.add(group);
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        activeOperations.delete(group);
      };
      res.once('finish', release);
      res.once('close', release);
      next();
    }) as NextFunction;

    advance();
  };
}

export const diagnosticExecutionHttpBoundary =
  createDiagnosticExecutionHttpBoundary();
