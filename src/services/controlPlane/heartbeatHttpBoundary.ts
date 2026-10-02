import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { createRateLimitMiddleware, securityHeaders } from '@platform/runtime/security.js';
import {
  controlPlaneHttpAuthenticationMiddleware,
  createControlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneHttpScopes,
  requireControlPlaneOperator,
} from './httpAuth.js';

export const HEARTBEAT_BODY_LIMIT_BYTES = 4 * 1024;
const heartbeatBoundaryApplied = Symbol('heartbeatBoundaryApplied');
type HeartbeatBoundaryRequest = Request & { [heartbeatBoundaryApplied]?: true };

export interface HeartbeatHttpBoundaryOptions {
  authenticationEnvironment?: NodeJS.ProcessEnv;
  maxRequests?: number;
  windowMs?: number;
}

function sendInvalidHeartbeatBody(res: Response, statusCode: 400 | 413 | 415): void {
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'HEARTBEAT_REQUEST_INVALID',
      message: 'Heartbeat request is invalid.',
    },
  });
}

const boundedJsonParser = express.json({
  limit: HEARTBEAT_BODY_LIMIT_BYTES,
  strict: true,
  inflate: false,
  type: ['application/json', 'application/*+json'],
});

const heartbeatBodyParser: RequestHandler = (req, res, next): void => {
  const encoding = req.get('content-encoding')?.trim().toLowerCase();
  const contentType = req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  let contentTypeCount = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'content-type') {
      contentTypeCount += 1;
    }
  }
  if (
    (encoding !== undefined && encoding !== 'identity')
    || contentTypeCount > 1
    || !(contentType === 'application/json'
      || (contentType?.startsWith('application/') && contentType.endsWith('+json')))
  ) {
    sendInvalidHeartbeatBody(res, 415);
    return;
  }

  boundedJsonParser(req, res, (error?: unknown) => {
    if (error !== undefined) {
      const parserError = error && typeof error === 'object'
        ? error as { status?: unknown; type?: unknown }
        : {};
      sendInvalidHeartbeatBody(res, parserError.type === 'entity.too.large'
        || parserError.status === 413 ? 413 : 400);
      return;
    }
    next();
  });
};

/** Establish operator trust and fixed request bounds before broad body parsing. */
export function createHeartbeatHttpBoundary(
  options: HeartbeatHttpBoundaryOptions = {}
): RequestHandler {
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    (_req, res, next): void => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      next();
    },
    options.authenticationEnvironment
      ? createControlPlaneHttpAuthenticationMiddleware(options.authenticationEnvironment)
      : controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    createRateLimitMiddleware({
      bucketName: 'heartbeat-principal',
      maxRequests: options.maxRequests ?? 60,
      windowMs: options.windowMs ?? 60_000,
      keyGenerator: (req) => `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}`,
    }),
    requireControlPlaneHttpScopes(['mcp:invoke'], 'heartbeat.http_authorization.denied'),
    heartbeatBodyParser,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const heartbeatRequest = req as HeartbeatBoundaryRequest;
    if (heartbeatRequest[heartbeatBoundaryApplied]) {
      next();
      return;
    }
    heartbeatRequest[heartbeatBoundaryApplied] = true;

    let middlewareIndex = 0;
    const advance = ((error?: unknown): void => {
      if (error !== undefined) {
        next(error);
        return;
      }
      const middleware = middlewareChain[middlewareIndex++];
      if (middleware) {
        middleware(req, res, advance);
      } else {
        next();
      }
    }) as NextFunction;
    advance();
  };
}

export const heartbeatHttpBoundary = createHeartbeatHttpBoundary();
