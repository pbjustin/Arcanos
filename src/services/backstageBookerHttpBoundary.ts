import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import { securityHeaders } from '@platform/runtime/security.js';

import {
  authenticateBackstageBookerAccessRequest,
  establishBackstageBookerAccessAuthentication,
} from './backstageBookerAccessAuth.js';
import { gptAccessAuthMiddleware } from './gptAccessGateway.js';
import { gptAccessRateLimit } from './gptAccessRateLimit.js';

export const BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH =
  '/gpt-access/capabilities/v1/backstage-booker/run';

const backstageBookerHttpBoundaryApplied = Symbol(
  'backstageBookerHttpBoundaryApplied'
);

type BackstageBookerBoundaryRequest = Request & {
  [backstageBookerHttpBoundaryApplied]?: true;
};

export interface BackstageBookerHttpBoundaryOptions {
  genericAuth?: RequestHandler;
  rateLimit?: RequestHandler;
}

function readRequestPath(req: Request): string {
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const expressPath = typeof req.path === 'string' ? req.path : '';
  if (expressPath.startsWith('/')) {
    return `${baseUrl}${expressPath}`;
  }

  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  return queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;
}

/** Match only the canonical method and pathname used by the Builder contract. */
export function isBackstageBookerCapabilityRunRequest(req: Request): boolean {
  return req.method.toUpperCase() === 'POST'
    && readRequestPath(req) === BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH;
}

export function isBackstageBookerHttpBoundaryApplied(req: Request): boolean {
  return (req as BackstageBookerBoundaryRequest)[
    backstageBookerHttpBoundaryApplied
  ] === true;
}

function setBackstageBookerNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/**
 * Establish the exact Backstage Booker capability boundary before broad body
 * parsing. The dedicated bearer earns a private trust marker; all other
 * credentials retain the existing generic GPT Access authentication path.
 */
export function createBackstageBookerHttpBoundary(
  options: BackstageBookerHttpBoundaryOptions = {}
): RequestHandler {
  const genericAuth = options.genericAuth ?? gptAccessAuthMiddleware;
  const rateLimit = options.rateLimit ?? gptAccessRateLimit;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isBackstageBookerCapabilityRunRequest(req)) {
      next();
      return;
    }

    const boundaryRequest = req as BackstageBookerBoundaryRequest;
    if (boundaryRequest[backstageBookerHttpBoundaryApplied]) {
      next();
      return;
    }
    boundaryRequest[backstageBookerHttpBoundaryApplied] = true;

    const authenticate: RequestHandler = (
      request,
      response,
      authenticateNext
    ): void => {
      const dedicatedResult = authenticateBackstageBookerAccessRequest(request);
      if (!dedicatedResult.ok) {
        genericAuth(request, response, authenticateNext);
        return;
      }

      establishBackstageBookerAccessAuthentication(
        request,
        dedicatedResult.credential
      );
      try {
        request.logger?.info('backstage_booker_access.authenticated', {
          authMode: 'dedicated',
          capabilityId: 'BACKSTAGE:BOOKER',
          method: request.method,
        });
      } catch {
        // Authentication diagnostics must not alter request handling.
      }
      authenticateNext();
    };

    const middlewareChain: RequestHandler[] = [
      securityHeaders,
      setBackstageBookerNoStoreHeaders,
      rateLimit,
      authenticate,
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

export const backstageBookerHttpBoundary =
  createBackstageBookerHttpBoundary();
