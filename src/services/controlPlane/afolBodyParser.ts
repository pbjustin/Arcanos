import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { resolveAfolHttpOperation } from './afolHttpBoundary.js';

export const AFOL_DECISION_BODY_LIMIT_BYTES = 64 * 1024;
const AFOL_DECISION_BODY_MAX_DEPTH = 32;

const afolBodyParserApplied = Symbol('afolBodyParserApplied');
const boundedJsonParser = express.json({
  inflate: false,
  limit: AFOL_DECISION_BODY_LIMIT_BYTES,
  strict: true,
  type: ['application/json', 'application/*+json'],
});

type AfolBodyRequest = Request & {
  [afolBodyParserApplied]?: true;
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

function hasBoundedJsonDepth(value: unknown): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [{
    depth: 0,
    value,
  }];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.value === null || typeof current.value !== 'object') {
      continue;
    }
    if (current.depth > AFOL_DECISION_BODY_MAX_DEPTH) {
      return false;
    }
    if (visited.has(current.value)) {
      return false;
    }
    visited.add(current.value);

    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === 'object') {
        pending.push({
          depth: current.depth + 1,
          value: child,
        });
      }
    }
  }

  return true;
}

export function sendInvalidAfolRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  req.logger?.warn?.('afol.request_rejected', {
    statusCode,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'AFOL_REQUEST_INVALID',
      message: 'AFOL request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

export const afolBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const afolRequest = req as AfolBodyRequest;
  if (afolRequest[afolBodyParserApplied]) {
    next();
    return;
  }
  afolRequest[afolBodyParserApplied] = true;

  const operation = resolveAfolHttpOperation(req);
  if (!operation) {
    next();
    return;
  }
  if (operation.kind === 'read') {
    if (hasRequestBody(req)) {
      sendInvalidAfolRequest(req, res);
      return;
    }
    next();
    return;
  }
  if (!hasRequestBody(req)) {
    sendInvalidAfolRequest(req, res);
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || !hasJsonContentType(req)
  ) {
    sendInvalidAfolRequest(req, res, 415);
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
      sendInvalidAfolRequest(req, res, statusCode);
      return;
    }
    if (
      req.body === undefined
      || req.body === null
      || typeof req.body !== 'object'
      || Array.isArray(req.body)
    ) {
      sendInvalidAfolRequest(req, res);
      return;
    }
    if (!hasBoundedJsonDepth(req.body)) {
      sendInvalidAfolRequest(req, res);
      return;
    }
    next();
  });
};
