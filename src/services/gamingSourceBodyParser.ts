import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  resolveGamingSourceHttpOperation,
  resolveGamingSourceHttpResolution,
} from './gamingSourceHttpRoutes.js';

export const GAMING_SOURCE_BODY_LIMIT_BYTES = 16 * 1024;

const gamingSourceBodyParserApplied = Symbol(
  'gamingSourceBodyParserApplied'
);
const boundedJsonParser = express.json({
  inflate: false,
  limit: GAMING_SOURCE_BODY_LIMIT_BYTES,
  strict: true,
  type: 'application/json',
});

type GamingSourceBodyRequest = Request & {
  [gamingSourceBodyParserApplied]?: true;
};

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

function hasJsonContentType(req: Request): boolean {
  const mediaType = req.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === 'application/json';
}

function hasUnsupportedContentEncoding(req: Request): boolean {
  const contentEncoding = req.get('content-encoding')?.trim().toLowerCase();
  return contentEncoding !== undefined
    && contentEncoding.length > 0
    && contentEncoding !== 'identity';
}

function hasParsedObjectBody(req: Request): boolean {
  return req.body !== undefined
    && req.body !== null
    && typeof req.body === 'object'
    && !Array.isArray(req.body);
}

export function sendInvalidGamingSourceRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  try {
    req.logger?.warn?.('gaming.source_request_rejected', {
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
      code: 'GAMING_SOURCE_VALIDATION_ERROR',
      message: 'The Gaming source request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.traceId ? { traceId: req.traceId } : {}),
  });
}

export const gamingSourceBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const resolution = resolveGamingSourceHttpResolution(req);
  if (!resolution) {
    next();
    return;
  }

  const bodyRequest = req as GamingSourceBodyRequest;
  if (bodyRequest[gamingSourceBodyParserApplied]) {
    next();
    return;
  }
  bodyRequest[gamingSourceBodyParserApplied] = true;

  if (!resolution.canonical) {
    sendInvalidGamingSourceRequest(req, res);
    return;
  }

  const operation = resolveGamingSourceHttpOperation(req);
  if (operation?.operationKind === 'read') {
    if (hasRequestBody(req)) {
      sendInvalidGamingSourceRequest(req, res);
      return;
    }
    next();
    return;
  }

  const requestHasBody = hasRequestBody(req) || req.body !== undefined;
  if (!requestHasBody) {
    if (operation?.operationKind === 'write') {
      sendInvalidGamingSourceRequest(req, res);
      return;
    }
    next();
    return;
  }
  const contentLength = readContentLength(req);
  if (contentLength !== null && !Number.isSafeInteger(contentLength)) {
    sendInvalidGamingSourceRequest(req, res);
    return;
  }
  if (
    contentLength !== null
    && contentLength > GAMING_SOURCE_BODY_LIMIT_BYTES
  ) {
    sendInvalidGamingSourceRequest(req, res, 413);
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || !hasJsonContentType(req)
  ) {
    sendInvalidGamingSourceRequest(req, res, 415);
    return;
  }

  if (req.body !== undefined) {
    if (!hasParsedObjectBody(req)) {
      sendInvalidGamingSourceRequest(req, res);
      return;
    }
    next();
    return;
  }

  boundedJsonParser(req, res, (error?: unknown) => {
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
          ? 415
          : 400;
      sendInvalidGamingSourceRequest(req, res, statusCode);
      return;
    }
    if (!hasParsedObjectBody(req)) {
      sendInvalidGamingSourceRequest(req, res);
      return;
    }
    next();
  });
};
