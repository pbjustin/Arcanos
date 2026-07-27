import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { resolveCefHttpOperation } from './cefHttpBoundary.js';

export const CEF_EXECUTION_BODY_LIMIT_BYTES = 256 * 1024;

const cefBodyParserApplied = Symbol('cefBodyParserApplied');
const boundedJsonParser = express.json({
  inflate: false,
  limit: CEF_EXECUTION_BODY_LIMIT_BYTES,
  strict: true,
  type: ['application/json', 'application/*+json'],
});

type CefBodyRequest = Request & {
  [cefBodyParserApplied]?: true;
};

function hasRequestBody(req: Request): boolean {
  const contentLength = req.get('content-length');
  return req.get('transfer-encoding') !== undefined
    || (contentLength !== undefined && contentLength !== '0');
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

function hasJsonContentType(req: Request): boolean {
  const mediaType = req.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === 'application/json'
    || (
      mediaType?.startsWith('application/') === true
      && mediaType.endsWith('+json')
    );
}

function hasUnsupportedContentEncoding(req: Request): boolean {
  const contentEncoding = req.get('content-encoding')?.trim().toLowerCase();
  return contentEncoding !== undefined
    && contentEncoding.length > 0
    && contentEncoding !== 'identity';
}

export function sendInvalidCefRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  req.logger?.warn?.('cef.request_rejected', {
    statusCode,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'CEF_REQUEST_INVALID',
      message: 'CEF request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

export const cefBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const cefRequest = req as CefBodyRequest;
  if (cefRequest[cefBodyParserApplied]) {
    next();
    return;
  }
  cefRequest[cefBodyParserApplied] = true;

  const operation = resolveCefHttpOperation(req);
  if (operation?.kind === 'read') {
    if (hasRequestBody(req)) {
      sendInvalidCefRequest(req, res, 400);
      return;
    }
    next();
    return;
  }
  if (operation?.kind !== 'execution') {
    next();
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || (hasRequestBody(req) && !hasJsonContentType(req))
  ) {
    sendInvalidCefRequest(req, res, 415);
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
      sendInvalidCefRequest(req, res, statusCode);
      return;
    }
    if (
      req.body === undefined
      || req.body === null
      || typeof req.body !== 'object'
      || Array.isArray(req.body)
    ) {
      sendInvalidCefRequest(req, res, 400);
      return;
    }
    next();
  });
};
