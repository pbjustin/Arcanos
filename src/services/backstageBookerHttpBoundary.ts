import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { TextDecoder } from 'node:util';

import { securityHeaders } from '@platform/runtime/security.js';

import {
  authenticateBackstageBookerAccessRequest,
  establishBackstageBookerAccessAuthentication,
} from './backstageBookerAccessAuth.js';
import { gptAccessAuthMiddleware } from './gptAccessGateway.js';
import { gptAccessRateLimit } from './gptAccessRateLimit.js';

export const BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH =
  '/gpt-access/capabilities/v1/backstage-booker/run';
export const BACKSTAGE_BOOKER_BODY_LIMIT_BYTES = 256 * 1024;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
// Intentionally omit Unicode case folding: HTTP media-type tokens are ASCII.
const backstageBookerJsonContentTypePattern =
  /^[\t ]*application\/json(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i;
const backstageBookerChunkedTransferEncodingPattern =
  /^[\t ]*chunked[\t ]*$/i;
const backstageBookerIdentityContentEncodingPattern =
  /^[\t ]*identity[\t ]*$/i;

const backstageBookerHttpBoundaryApplied = Symbol(
  'backstageBookerHttpBoundaryApplied'
);
const boundedBackstageBookerJsonParser = express.json({
  inflate: false,
  limit: BACKSTAGE_BOOKER_BODY_LIMIT_BYTES,
  strict: true,
  type: 'application/json',
  verify: (_req, _res, body) => {
    if (body.length === 0) {
      throw new SyntaxError('Empty Backstage Booker JSON body.');
    }
    fatalUtf8Decoder.decode(body);
  },
});

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

function countRawHeaders(req: Request, headerName: string): number {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let count = 0;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (
      typeof rawHeaders[index] === 'string'
      && rawHeaders[index].toLowerCase() === headerName
    ) {
      count += 1;
    }
  }

  return count;
}

function hasRequestBody(req: Request): boolean {
  const contentLength = req.get('content-length');
  return req.get('transfer-encoding') !== undefined
    || (contentLength !== undefined && contentLength !== '0');
}

function readContentLength(req: Request): number | null {
  const rawValue = req.get('content-length');
  if (rawValue === undefined) {
    return null;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(rawValue)) {
    return Number.NaN;
  }

  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function hasSupportedJsonContentType(req: Request): boolean {
  const contentType = req.get('content-type');
  if (contentType === undefined) {
    return false;
  }

  return backstageBookerJsonContentTypePattern.test(contentType);
}

function hasUnsupportedContentEncoding(req: Request): boolean {
  const contentEncoding = req.get('content-encoding');
  if (contentEncoding === undefined) {
    return false;
  }

  return countRawHeaders(req, 'content-encoding') !== 1
    || !backstageBookerIdentityContentEncodingPattern.test(contentEncoding);
}

function hasUnsupportedTransferEncoding(req: Request): boolean {
  const transferEncoding = req.get('transfer-encoding');
  if (transferEncoding === undefined) {
    return false;
  }

  return countRawHeaders(req, 'transfer-encoding') !== 1
    || req.get('content-length') !== undefined
    || !backstageBookerChunkedTransferEncodingPattern.test(transferEncoding);
}

function hasParsedObjectBody(req: Request): boolean {
  return req.body !== undefined
    && req.body !== null
    && typeof req.body === 'object'
    && !Array.isArray(req.body);
}

function sendInvalidBackstageBookerRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  try {
    req.logger?.warn?.('backstage_booker_access.request_rejected', {
      statusCode,
      method: req.method,
      requestId: req.requestId,
      traceId: req.traceId,
    });
  } catch {
    // Diagnostics must not alter the fixed parser response.
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'The Backstage Booker canon request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.traceId ? { traceId: req.traceId } : {}),
  });
}

const parseBackstageBookerRequestBody: RequestHandler = (
  req,
  res,
  next
): void => {
  // A parser mounted ahead of this boundary has already discarded the raw
  // bytes needed to prove the transport ceiling, non-empty body, and UTF-8
  // invariants. Fail closed; production mounts this boundary before parsers.
  if (req.body !== undefined) {
    sendInvalidBackstageBookerRequest(req, res);
    return;
  }

  const requestHasBody = hasRequestBody(req);
  if (!requestHasBody) {
    sendInvalidBackstageBookerRequest(req, res);
    return;
  }

  const contentLength = readContentLength(req);
  if (contentLength !== null && !Number.isSafeInteger(contentLength)) {
    sendInvalidBackstageBookerRequest(req, res);
    return;
  }
  if (
    contentLength !== null
    && contentLength > BACKSTAGE_BOOKER_BODY_LIMIT_BYTES
  ) {
    sendInvalidBackstageBookerRequest(req, res, 413);
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || hasUnsupportedTransferEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || !hasSupportedJsonContentType(req)
  ) {
    sendInvalidBackstageBookerRequest(req, res, 415);
    return;
  }

  boundedBackstageBookerJsonParser(req, res, (error?: unknown) => {
    if (error !== undefined) {
      const parserError = error && typeof error === 'object'
        ? error as { status?: unknown; statusCode?: unknown; type?: unknown }
        : {};
      const statusCode = parserError.type === 'entity.too.large'
        || parserError.status === 413
        || parserError.statusCode === 413
        ? 413
        : parserError.status === 415
          || parserError.statusCode === 415
          || parserError.type === 'charset.unsupported'
          || parserError.type === 'encoding.unsupported'
          ? 415
          : 400;
      sendInvalidBackstageBookerRequest(req, res, statusCode);
      return;
    }
    if (!hasParsedObjectBody(req)) {
      sendInvalidBackstageBookerRequest(req, res);
      return;
    }
    next();
  });
};

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
      parseBackstageBookerRequestBody,
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
