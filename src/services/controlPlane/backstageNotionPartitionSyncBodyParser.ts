import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  parseBackstageNotionPartitionSyncRequestBody,
  type BackstageNotionPartitionSyncRequestBody,
} from '@shared/jobs/backstageNotionPartitionSyncJob.js';

import {
  resolveBackstageNotionPartitionSyncHttpOperation,
} from './backstageNotionPartitionSyncHttpBoundary.js';

export const BACKSTAGE_NOTION_PARTITION_SYNC_BODY_LIMIT_BYTES = 4 * 1_024;
export const BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_KEY_MAX_LENGTH = 240;

const backstageNotionPartitionSyncBodyParserApplied = Symbol(
  'backstageNotionPartitionSyncBodyParserApplied'
);
const backstageNotionPartitionSyncRequestContext = Symbol(
  'backstageNotionPartitionSyncRequestContext'
);
const boundedJsonParser = express.json({
  inflate: false,
  limit: BACKSTAGE_NOTION_PARTITION_SYNC_BODY_LIMIT_BYTES,
  strict: true,
  type: 'application/json',
});
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,240}$/u;

export interface BackstageNotionPartitionSyncParsedRequest {
  readonly body: BackstageNotionPartitionSyncRequestBody;
  readonly idempotencyKey: string;
}

type BackstageNotionPartitionSyncBodyRequest = Request & {
  [backstageNotionPartitionSyncBodyParserApplied]?: true;
  [backstageNotionPartitionSyncRequestContext]?:
    BackstageNotionPartitionSyncParsedRequest;
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
  return req.body !== undefined
    || req.get('transfer-encoding') !== undefined
    || (
      contentLength !== undefined
      && contentLength.trim() !== ''
      && contentLength.trim() !== '0'
    );
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

function readExactIdempotencyKey(req: Request): string | null {
  if (countRawHeaders(req, 'idempotency-key') !== 1) {
    return null;
  }
  const value = req.get('idempotency-key');
  return typeof value === 'string'
    && value.length >= BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_KEY_MIN_LENGTH
    && value.length <= BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_KEY_MAX_LENGTH
    && IDEMPOTENCY_KEY_PATTERN.test(value)
    ? value
    : null;
}

function hasAmbiguousTransferFraming(req: Request): boolean {
  const transferEncodingCount = countRawHeaders(req, 'transfer-encoding');
  const contentLengthCount = countRawHeaders(req, 'content-length');
  const transferEncoding = req.get('transfer-encoding')?.trim().toLowerCase();
  return transferEncodingCount > 1
    || contentLengthCount > 1
    || (transferEncodingCount > 0 && contentLengthCount > 0)
    || (
      transferEncoding !== undefined
      && transferEncoding !== 'chunked'
    );
}

function parseAndStoreCreateRequest(
  req: Request,
  idempotencyKey: string
): boolean {
  const body = parseBackstageNotionPartitionSyncRequestBody(req.body);
  if (!body) {
    return false;
  }
  const parsedRequest = req as BackstageNotionPartitionSyncBodyRequest;
  parsedRequest[backstageNotionPartitionSyncRequestContext] = Object.freeze({
    body,
    idempotencyKey,
  });
  return true;
}

export function getBackstageNotionPartitionSyncParsedRequest(
  req: Request
): BackstageNotionPartitionSyncParsedRequest | null {
  return (req as BackstageNotionPartitionSyncBodyRequest)[
    backstageNotionPartitionSyncRequestContext
  ] ?? null;
}

export function sendInvalidBackstageNotionPartitionSyncRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  try {
    req.logger?.warn?.('backstage_notion_partition_sync.request_rejected', {
      statusCode,
      method: req.method,
      requestId: req.requestId,
      traceId: req.traceId,
    });
  } catch {
    // Logging must never prevent the bounded fixed response.
  }
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID',
      message: 'Partition synchronization request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

export const backstageNotionPartitionSyncBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const parsedRequest = req as BackstageNotionPartitionSyncBodyRequest;
  if (parsedRequest[backstageNotionPartitionSyncBodyParserApplied]) {
    next();
    return;
  }
  parsedRequest[backstageNotionPartitionSyncBodyParserApplied] = true;

  const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
  if (!operation) {
    next();
    return;
  }
  if (operation.kind === 'status') {
    if (hasRequestBody(req)) {
      sendInvalidBackstageNotionPartitionSyncRequest(req, res);
      return;
    }
    next();
    return;
  }

  if (!hasRequestBody(req)) {
    sendInvalidBackstageNotionPartitionSyncRequest(req, res);
    return;
  }
  // Reject an absent, duplicated, or malformed idempotency key before the JSON
  // parser allocates a body. The plaintext value remains request-local only.
  const idempotencyKey = readExactIdempotencyKey(req);
  if (!idempotencyKey) {
    sendInvalidBackstageNotionPartitionSyncRequest(req, res);
    return;
  }
  if (hasAmbiguousTransferFraming(req)) {
    sendInvalidBackstageNotionPartitionSyncRequest(req, res);
    return;
  }
  const contentLength = readContentLength(req);
  if (
    contentLength !== null
    && (
      !Number.isSafeInteger(contentLength)
      || contentLength > BACKSTAGE_NOTION_PARTITION_SYNC_BODY_LIMIT_BYTES
    )
  ) {
    sendInvalidBackstageNotionPartitionSyncRequest(
      req,
      res,
      Number.isSafeInteger(contentLength) ? 413 : 400
    );
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') !== 1
    || countRawHeaders(req, 'content-encoding') > 1
    || !hasJsonContentType(req)
  ) {
    sendInvalidBackstageNotionPartitionSyncRequest(req, res, 415);
    return;
  }

  if (req.body !== undefined) {
    if (!parseAndStoreCreateRequest(req, idempotencyKey)) {
      sendInvalidBackstageNotionPartitionSyncRequest(req, res);
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
      sendInvalidBackstageNotionPartitionSyncRequest(req, res, statusCode);
      return;
    }
    if (!parseAndStoreCreateRequest(req, idempotencyKey)) {
      sendInvalidBackstageNotionPartitionSyncRequest(req, res);
      return;
    }
    next();
  });
};
