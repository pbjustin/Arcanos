import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  resolveAssistantRegistryHttpOperation,
} from './assistantRegistryHttpBoundary.js';

export const ASSISTANT_REGISTRY_SYNC_BODY_LIMIT_BYTES = 1024;

const assistantRegistryBodyParserApplied = Symbol(
  'assistantRegistryBodyParserApplied'
);
const boundedJsonParser = express.json({
  inflate: false,
  limit: ASSISTANT_REGISTRY_SYNC_BODY_LIMIT_BYTES,
  strict: true,
  type: ['application/json', 'application/*+json'],
});

type AssistantRegistryBodyRequest = Request & {
  [assistantRegistryBodyParserApplied]?: true;
};

function hasRequestBody(req: Request): boolean {
  const contentLength = req.get('content-length');
  return req.get('transfer-encoding') !== undefined
    || (
      contentLength !== undefined
      && contentLength.trim() !== ''
      && contentLength.trim() !== '0'
    );
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

function isEmptyJsonObject(value: unknown): value is Record<string, never> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null)
    && Object.keys(value).length === 0
  );
}

export function sendInvalidAssistantRegistryRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  try {
    req.logger?.warn?.('assistant_registry.request_rejected', {
      statusCode,
      method: req.method,
      requestId: req.requestId,
    });
  } catch {
    // Request logging must not prevent the bounded rejection response.
  }
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'ASSISTANT_REGISTRY_REQUEST_INVALID',
      message: 'Assistant registry request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

export const assistantRegistryBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const assistantRegistryRequest = req as AssistantRegistryBodyRequest;
  if (assistantRegistryRequest[assistantRegistryBodyParserApplied]) {
    next();
    return;
  }
  assistantRegistryRequest[assistantRegistryBodyParserApplied] = true;

  const operation = resolveAssistantRegistryHttpOperation(req);
  if (!operation) {
    next();
    return;
  }
  if (operation.kind === 'read') {
    if (hasRequestBody(req)) {
      sendInvalidAssistantRegistryRequest(req, res);
      return;
    }
    next();
    return;
  }
  if (!hasRequestBody(req)) {
    sendInvalidAssistantRegistryRequest(req, res);
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || countRawHeaders(req, 'content-encoding') > 1
    || !hasJsonContentType(req)
  ) {
    sendInvalidAssistantRegistryRequest(req, res, 415);
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
      sendInvalidAssistantRegistryRequest(req, res, statusCode);
      return;
    }
    if (!isEmptyJsonObject(req.body)) {
      sendInvalidAssistantRegistryRequest(req, res);
      return;
    }
    next();
  });
};
