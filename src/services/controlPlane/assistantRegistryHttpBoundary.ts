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

export const ASSISTANT_REGISTRY_READ_SCOPE = 'arcanos:read';
export const ASSISTANT_REGISTRY_SYNC_SCOPE = 'mcp:invoke';

const ASSISTANT_REGISTRY_SYNC_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ASSISTANT_REGISTRY_READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_ASSISTANT_REGISTRY_CLIENT_RATE_LIMIT = 60;
const ASSISTANT_REGISTRY_SYNC_RETRY_AFTER_SECONDS = 5;
const assistantRegistryBoundaryApplied = Symbol(
  'assistantRegistryBoundaryApplied'
);

export type AssistantRegistryHttpOperationKind = 'read' | 'sync';

export interface AssistantRegistryHttpOperation {
  kind: AssistantRegistryHttpOperationKind;
  scope: string;
}

const ASSISTANT_REGISTRY_PRINCIPAL_POLICIES: Readonly<
  Record<AssistantRegistryHttpOperationKind, RateLimitPolicy>
> = Object.freeze({
  read: {
    bucketName: 'assistant-registry-read',
    maxRequests: 120,
    windowMs: ASSISTANT_REGISTRY_READ_RATE_LIMIT_WINDOW_MS,
  },
  sync: {
    bucketName: 'assistant-registry-sync',
    maxRequests: 5,
    windowMs: ASSISTANT_REGISTRY_SYNC_RATE_LIMIT_WINDOW_MS,
  },
});

type AssistantRegistryBoundaryRequest = Request & {
  [assistantRegistryBoundaryApplied]?: true;
};

export interface AssistantRegistryHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function readAssistantRegistryRequestPath(req: Request): string {
  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  return queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;
}

function removeOneOptionalTrailingSlash(pathname: string): string | null {
  if (pathname.length <= 1 || !pathname.endsWith('/')) {
    return pathname;
  }
  if (pathname.endsWith('//')) {
    return null;
  }
  return pathname.slice(0, -1);
}

function normalizeAssistantRegistryRequestMethod(method: string): string {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === 'HEAD' ? 'GET' : normalizedMethod;
}

function isAssistantRegistryDetailPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/assistants/')) {
    return false;
  }
  const name = pathname.slice('/api/assistants/'.length);
  if (name.length === 0 || name.length > 384 || name.includes('/')) {
    return false;
  }
  try {
    const decodedName = decodeURIComponent(name);
    return (
      decodedName.length > 0
      && decodedName.length <= 256
      && !decodedName.includes('/')
      && !decodedName.includes('\\')
      && !/[\u0000-\u001F\u007F]/u.test(decodedName)
    );
  } catch {
    return false;
  }
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

export function resolveAssistantRegistryHttpOperation(
  req: Request
): AssistantRegistryHttpOperation | null {
  const rawPath = readAssistantRegistryRequestPath(req);
  const pathname = removeOneOptionalTrailingSlash(rawPath);
  if (!pathname) {
    return null;
  }

  const method = normalizeAssistantRegistryRequestMethod(req.method);
  if (
    method === 'GET'
    && (
      pathname === '/api/assistants'
      || isAssistantRegistryDetailPath(pathname)
    )
  ) {
    return {
      kind: 'read',
      scope: ASSISTANT_REGISTRY_READ_SCOPE,
    };
  }

  if (method === 'POST' && pathname === '/api/assistants/sync') {
    return {
      kind: 'sync',
      scope: ASSISTANT_REGISTRY_SYNC_SCOPE,
    };
  }

  return null;
}

function setAssistantRegistryNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendAssistantRegistryNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

function sendAssistantRegistrySyncInProgress(
  req: Request,
  res: Response
): void {
  try {
    req.logger?.warn?.('assistant_registry.concurrent_sync_rejected', {
      statusCode: 409,
      method: req.method,
      requestId: req.requestId,
    });
  } catch {
    // Request logging must not prevent the bounded contention response.
  }
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.setHeader(
    'Retry-After',
    String(ASSISTANT_REGISTRY_SYNC_RETRY_AFTER_SECONDS)
  );
  res.status(409).json({
    ok: false,
    error: {
      code: 'ASSISTANT_REGISTRY_SYNC_IN_PROGRESS',
      message: 'An assistant registry synchronization is already running.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

/**
 * Authenticate, authorize, throttle, and serialize assistant-registry traffic.
 *
 * The boundary is idempotent so application ingress can establish trust before
 * CORS and broad parsing while the leaf router remains safe on its own.
 */
export function createAssistantRegistryHttpBoundary(
  options: AssistantRegistryHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs
    ?? ASSISTANT_REGISTRY_SYNC_RATE_LIMIT_WINDOW_MS;
  let syncActive = false;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'assistant-registry-client',
    maxRequests: options.maxClientRequests
      ?? DEFAULT_ASSISTANT_REGISTRY_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:assistant-registry`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'assistant-registry-principal',
    maxRequests: 5,
    windowMs: defaultWindowMs,
    skip: (req) => resolveAssistantRegistryHttpOperation(req) === null,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveAssistantRegistryHttpOperation(req);
      if (!operation) {
        return defaultPolicy;
      }
      return {
        ...ASSISTANT_REGISTRY_PRINCIPAL_POLICIES[operation.kind],
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireOperationScope: RequestHandler = (req, res, next): void => {
    const operation = resolveAssistantRegistryHttpOperation(req);
    if (!operation) {
      next();
      return;
    }
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [operation.scope],
      'assistant_registry.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setAssistantRegistryNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireOperationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as AssistantRegistryBoundaryRequest;
    if (boundaryRequest[assistantRegistryBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[assistantRegistryBoundaryApplied] = true;

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

      const operation = resolveAssistantRegistryHttpOperation(req);
      if (!operation) {
        sendAssistantRegistryNotFound(res);
        return;
      }
      if (operation.kind !== 'sync') {
        next();
        return;
      }
      if (syncActive) {
        sendAssistantRegistrySyncInProgress(req, res);
        return;
      }

      syncActive = true;
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        syncActive = false;
      };
      res.once('finish', release);
      res.once('close', release);
      next();
    }) as NextFunction;

    advance();
  };
}

export const assistantRegistryHttpBoundary =
  createAssistantRegistryHttpBoundary();
