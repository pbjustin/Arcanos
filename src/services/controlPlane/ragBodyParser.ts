import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  resolveRagHttpOperation,
  type RagHttpOperationKind,
} from './ragHttpBoundary.js';

export const RAG_FETCH_BODY_LIMIT_BYTES = 8 * 1024;
export const RAG_QUERY_BODY_LIMIT_BYTES = 16 * 1024;
export const RAG_SAVE_BODY_LIMIT_BYTES = 256 * 1024;

const ragBodyParserApplied = Symbol('ragBodyParserApplied');
const boundedJsonParsers: Readonly<Record<RagHttpOperationKind, RequestHandler>> = {
  ingestion: express.json({
    inflate: false,
    limit: RAG_SAVE_BODY_LIMIT_BYTES,
    strict: true,
  }),
  query: express.json({
    inflate: false,
    limit: RAG_QUERY_BODY_LIMIT_BYTES,
    strict: true,
  }),
};
const fetchJsonParser = express.json({
  inflate: false,
  limit: RAG_FETCH_BODY_LIMIT_BYTES,
  strict: true,
});

type RagBodyRequest = Request & {
  [ragBodyParserApplied]?: true;
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

export function sendInvalidRagRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  req.logger?.warn?.('rag.request_rejected', {
    statusCode,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'RAG_REQUEST_INVALID',
      message: 'RAG request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

function selectJsonParser(req: Request): RequestHandler | null {
  const operation = resolveRagHttpOperation(req);
  if (!operation) {
    return null;
  }
  const normalizedPath = (req.originalUrl || req.url || req.path || '')
    .split('?', 1)[0]
    .toLowerCase()
    .replace(/\/+$/u, '');
  return normalizedPath === '/rag/fetch'
    ? fetchJsonParser
    : boundedJsonParsers[operation.kind];
}

export const ragBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const ragRequest = req as RagBodyRequest;
  if (ragRequest[ragBodyParserApplied]) {
    next();
    return;
  }
  ragRequest[ragBodyParserApplied] = true;

  const jsonParser = selectJsonParser(req);
  if (!jsonParser) {
    next();
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || (hasRequestBody(req) && !hasJsonContentType(req))
  ) {
    sendInvalidRagRequest(req, res, 415);
    return;
  }

  jsonParser(req, res, (error?: unknown) => {
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
      sendInvalidRagRequest(req, res, statusCode);
      return;
    }
    if (
      req.body === undefined
      || req.body === null
      || typeof req.body !== 'object'
      || Array.isArray(req.body)
    ) {
      sendInvalidRagRequest(req, res, 400);
      return;
    }
    next();
  });
};
