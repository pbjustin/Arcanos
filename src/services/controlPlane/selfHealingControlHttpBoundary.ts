import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  createRateLimitMiddleware,
  securityHeaders,
} from '@platform/runtime/security.js';

import {
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
} from './httpAuth.js';

const SELF_HEAL_HTTP_PREFIX = '/api/self-heal';
const SELF_IMPROVE_HTTP_PREFIX = '/api/self-improve';
const SAFETY_SELF_HEAL_PATH = '/status/safety/self-heal';
const SAFETY_QUARANTINE_RELEASE_PATH_PATTERN =
  /^\/status\/safety\/quarantine\/[a-z0-9._~-]{1,256}\/release$/iu;
const SELF_HEAL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_SELF_HEAL_CLIENT_RATE_LIMIT = 120;
const selfHealingControlBoundaryApplied = Symbol('selfHealingControlBoundaryApplied');

const SELF_HEAL_READ_PATHS = new Set([
  `${SELF_HEAL_HTTP_PREFIX}/runtime`,
  `${SELF_HEAL_HTTP_PREFIX}/events`,
  `${SELF_HEAL_HTTP_PREFIX}/inspection`,
  `${SELF_HEAL_HTTP_PREFIX}/provider-health`,
  `${SELF_IMPROVE_HTTP_PREFIX}/status`,
  SAFETY_SELF_HEAL_PATH,
]);

const SELF_HEAL_MUTATION_PATHS = new Set([
  `${SELF_HEAL_HTTP_PREFIX}/decide`,
  `${SELF_IMPROVE_HTTP_PREFIX}/run`,
  `${SELF_IMPROVE_HTTP_PREFIX}/freeze`,
  `${SELF_IMPROVE_HTTP_PREFIX}/unfreeze`,
  `${SELF_IMPROVE_HTTP_PREFIX}/autonomy`,
]);

type SelfHealingControlBoundaryRequest = Request & {
  [selfHealingControlBoundaryApplied]?: true;
};

export interface SelfHealingControlHttpBoundaryOptions {
  maxClientRequests?: number;
  windowMs?: number;
}

function normalizeSelfHealingControlRequestPath(req: Request): string {
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

function setSelfHealNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

export function isSafetyQuarantineReleaseHttpRequest(req: Request): boolean {
  return req.method.toUpperCase() === 'POST'
    && SAFETY_QUARANTINE_RELEASE_PATH_PATTERN.test(
      normalizeSelfHealingControlRequestPath(req)
    );
}

export function isKnownSelfHealingControlHttpRequest(req: Request): boolean {
  const method = req.method.toUpperCase();
  const path = normalizeSelfHealingControlRequestPath(req);

  if (method === 'POST') {
    return SELF_HEAL_MUTATION_PATHS.has(path)
      || isSafetyQuarantineReleaseHttpRequest(req);
  }

  return (method === 'GET' || method === 'HEAD') && SELF_HEAL_READ_PATHS.has(path);
}

function sendSelfHealNotFound(res: Response): void {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
}

/**
 * Authenticate and throttle direct self-healing control surfaces before body parsing.
 *
 * The middleware is intentionally idempotent so the production app can apply it
 * before the global JSON parser while the router can retain the same boundary
 * when mounted independently in focused tests or another host.
 */
export function createSelfHealingControlHttpBoundary(
  options: SelfHealingControlHttpBoundaryOptions = {}
): RequestHandler {
  const windowMs = options.windowMs ?? SELF_HEAL_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'self-heal-client',
    maxRequests: options.maxClientRequests ?? DEFAULT_SELF_HEAL_CLIENT_RATE_LIMIT,
    windowMs,
    keyGenerator: (req) => `ingress:${resolveIngressClientAddress(req)}:self-heal`,
  });
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setSelfHealNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as SelfHealingControlBoundaryRequest;
    if (boundaryRequest[selfHealingControlBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[selfHealingControlBoundaryApplied] = true;

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

      if (!isKnownSelfHealingControlHttpRequest(req)) {
        sendSelfHealNotFound(res);
        return;
      }

      next();
    }) as NextFunction;

    advance();
  };
}

export const selfHealingControlHttpBoundary =
  createSelfHealingControlHttpBoundary();
