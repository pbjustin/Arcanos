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
  isBackstageNotionUniverseId,
} from '@shared/backstage/backstageNotionPartitionCore.js';

import {
  authenticateControlPlaneHttpRequest,
  authorizeControlPlaneHttpScopes,
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
} from './httpAuth.js';

export const BACKSTAGE_NOTION_PARTITION_SYNC_SCOPE =
  'backstage:notion-sync';

const BACKSTAGE_NOTION_PARTITION_SYNC_NAMESPACE =
  '/api/backstage/notion-partitions';
const BACKSTAGE_NOTION_PARTITION_SYNC_RATE_LIMIT_WINDOW_MS =
  15 * 60 * 1_000;
const BACKSTAGE_NOTION_PARTITION_STATUS_RATE_LIMIT_WINDOW_MS =
  5 * 60 * 1_000;
const DEFAULT_BACKSTAGE_NOTION_PARTITION_SYNC_CLIENT_RATE_LIMIT = 60;
const SYNC_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const backstageNotionPartitionSyncBoundaryApplied = Symbol(
  'backstageNotionPartitionSyncBoundaryApplied'
);

export type BackstageNotionPartitionSyncHttpOperation =
  | Readonly<{
      kind: 'create';
      universeId: string;
    }>
  | Readonly<{
      kind: 'status';
      universeId: string;
      syncId: string;
    }>;

type BackstageNotionPartitionSyncBoundaryRequest = Request & {
  [backstageNotionPartitionSyncBoundaryApplied]?: true;
};

export interface BackstageNotionPartitionSyncHttpBoundaryOptions {
  maxClientRequests?: number;
  maxPrincipalRequests?: number;
  windowMs?: number;
}

const PRINCIPAL_POLICIES: Readonly<
  Record<BackstageNotionPartitionSyncHttpOperation['kind'], RateLimitPolicy>
> = Object.freeze({
  create: {
    bucketName: 'backstage-notion-partition-sync-create',
    maxRequests: 5,
    windowMs: BACKSTAGE_NOTION_PARTITION_SYNC_RATE_LIMIT_WINDOW_MS,
  },
  status: {
    bucketName: 'backstage-notion-partition-sync-status',
    maxRequests: 120,
    windowMs: BACKSTAGE_NOTION_PARTITION_STATUS_RATE_LIMIT_WINDOW_MS,
  },
});

function readRequestPath(req: Request): string | null {
  const requestTarget = req.originalUrl || req.url || '';
  if (requestTarget.includes('?')) {
    return null;
  }

  // Express normalizes origin-form and absolute-form targets into `path` while
  // preserving percent-encoded octets. Reattach the active mount so the early
  // boundary and leaf router classify the same complete pathname.
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const expressPath = typeof req.path === 'string' ? req.path : '';
  if (expressPath.startsWith('/')) {
    return `${baseUrl}${expressPath}`;
  }
  return requestTarget;
}

function decodeCanonicalSegment(rawSegment: string): string | null {
  if (
    rawSegment.length < 1
    || rawSegment.length > 128
    || rawSegment.includes('%')
    || rawSegment.includes('\\')
    || /[\u0000-\u0020\u007F]/u.test(rawSegment)
  ) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(rawSegment);
    return decoded === rawSegment ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return normalized === 'HEAD' ? 'GET' : normalized;
}

/**
 * Resolve only the two canonical manual partition-sync routes.
 *
 * The classifier rejects query strings, encoded path segments, optional
 * trailing slashes, extra segments, and unsupported methods. It deliberately
 * returns server-safe stable identifiers rather than raw request values.
 */
export function resolveBackstageNotionPartitionSyncHttpOperation(
  req: Request
): BackstageNotionPartitionSyncHttpOperation | null {
  const pathname = readRequestPath(req);
  if (!pathname || pathname.endsWith('/')) {
    return null;
  }
  const prefix = `${BACKSTAGE_NOTION_PARTITION_SYNC_NAMESPACE}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const suffix = pathname.slice(prefix.length);
  const segments = suffix.split('/');
  if (
    (segments.length !== 2 && segments.length !== 3)
    || segments[1] !== 'syncs'
  ) {
    return null;
  }
  const universeId = decodeCanonicalSegment(segments[0] ?? '');
  if (!universeId || !isBackstageNotionUniverseId(universeId)) {
    return null;
  }

  const method = normalizeMethod(req.method);
  if (segments.length === 2) {
    return method === 'POST'
      ? Object.freeze({ kind: 'create' as const, universeId })
      : null;
  }

  const syncId = decodeCanonicalSegment(segments[2] ?? '');
  return method === 'GET' && syncId && SYNC_ID_PATTERN.test(syncId)
    ? Object.freeze({ kind: 'status' as const, universeId, syncId })
    : null;
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

function setNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function sendRouteNotFound(res: Response): void {
  res.status(404).json({
    ok: false,
    error: {
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
      message: 'The partition synchronization was not found.',
    },
  });
}

/**
 * Establish the manual partition synchronization trust boundary before CORS
 * and broad parsing. The symbol fence keeps the app-level and leaf-router
 * mounts idempotent without weakening authentication or throttling.
 */
export function createBackstageNotionPartitionSyncHttpBoundary(
  options: BackstageNotionPartitionSyncHttpBoundaryOptions = {}
): RequestHandler {
  const defaultWindowMs = options.windowMs
    ?? BACKSTAGE_NOTION_PARTITION_SYNC_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'backstage-notion-partition-sync-client',
    maxRequests: options.maxClientRequests
      ?? DEFAULT_BACKSTAGE_NOTION_PARTITION_SYNC_CLIENT_RATE_LIMIT,
    windowMs: defaultWindowMs,
    skip: req => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: req => (
      `ingress:${resolveIngressClientAddress(req)}:backstage-notion-partition-sync`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'backstage-notion-partition-sync-principal',
    maxRequests: options.maxPrincipalRequests ?? 5,
    windowMs: defaultWindowMs,
    keyGenerator: req => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`
    ),
    policyResolver: (req, defaultPolicy) => {
      const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
      const policy = operation ? PRINCIPAL_POLICIES[operation.kind] : defaultPolicy;
      return {
        ...policy,
        ...(options.maxPrincipalRequests === undefined
          ? {}
          : { maxRequests: options.maxPrincipalRequests }),
        ...(options.windowMs === undefined
          ? {}
          : { windowMs: options.windowMs }),
      };
    },
  });
  const requireScope: RequestHandler = (req, res, next): void => {
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [BACKSTAGE_NOTION_PARTITION_SYNC_SCOPE],
      'backstage_notion_partition_sync.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as BackstageNotionPartitionSyncBoundaryRequest;
    if (boundaryRequest[backstageNotionPartitionSyncBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[backstageNotionPartitionSyncBoundaryApplied] = true;

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
      if (!resolveBackstageNotionPartitionSyncHttpOperation(req)) {
        sendRouteNotFound(res);
        return;
      }
      next();
    }) as NextFunction;

    advance();
  };
}

export const backstageNotionPartitionSyncHttpBoundary =
  createBackstageNotionPartitionSyncHttpBoundary();
