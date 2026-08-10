import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import { securityHeaders } from '@platform/runtime/security.js';

import {
  gamingSourceAccessAuthMiddleware,
} from './gamingSourceAccessAuth.js';
import { gptAccessRateLimit } from './gptAccessRateLimit.js';
import { resolveGamingSourceHttpTarget } from './gamingSourceHttpRoutes.js';

const gamingSourceHttpBoundaryApplied = Symbol(
  'gamingSourceHttpBoundaryApplied'
);
type GamingSourceBoundaryRequest = Request & {
  [gamingSourceHttpBoundaryApplied]?: true;
};

export interface GamingSourceHttpBoundaryOptions {
  rateLimit?: RequestHandler;
}

export function isGamingSourceHttpBoundaryApplied(req: Request): boolean {
  return (req as GamingSourceBoundaryRequest)[
    gamingSourceHttpBoundaryApplied
  ] === true;
}

function setGamingSourceNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/**
 * Establish the narrow Gaming source trust boundary before any broad parser or
 * execution gate. It is idempotent so the production app and leaf router can
 * both mount it without authenticating or throttling twice.
 */
export function createGamingSourceHttpBoundary(
  options: GamingSourceHttpBoundaryOptions = {}
): RequestHandler {
  const rateLimit = options.rateLimit ?? gptAccessRateLimit;

  return (req: Request, res: Response, next: NextFunction): void => {
    const target = resolveGamingSourceHttpTarget(req);
    if (!target) {
      next();
      return;
    }

    const boundaryRequest = req as GamingSourceBoundaryRequest;
    if (boundaryRequest[gamingSourceHttpBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[gamingSourceHttpBoundaryApplied] = true;

    const middlewareChain: RequestHandler[] = [
      securityHeaders,
      setGamingSourceNoStoreHeaders,
      rateLimit,
      gamingSourceAccessAuthMiddleware,
    ];
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
      next();
    }) as NextFunction;

    advance();
  };
}

export const gamingSourceHttpBoundary = createGamingSourceHttpBoundary();
