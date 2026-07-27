import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  resolveReinforcementHttpOperation,
} from './reinforcementHttpBoundary.js';

export const REINFORCE_BODY_LIMIT_BYTES = 32 * 1024;
export const REINFORCEMENT_FEEDBACK_BODY_LIMIT_BYTES = 128 * 1024;

const reinforcementBodyParserApplied = Symbol(
  'reinforcementBodyParserApplied'
);
const reinforceJsonParser = express.json({
  inflate: false,
  limit: REINFORCE_BODY_LIMIT_BYTES,
  strict: true,
  type: ['application/json', 'application/*+json'],
});
const feedbackJsonParser = express.json({
  inflate: false,
  limit: REINFORCEMENT_FEEDBACK_BODY_LIMIT_BYTES,
  strict: true,
  type: ['application/json', 'application/*+json'],
});

type ReinforcementBodyRequest = Request & {
  [reinforcementBodyParserApplied]?: true;
};

function normalizeRequestPath(req: Request): string {
  const requestUrl = req.originalUrl || req.url || req.path || '';
  const rawPath = requestUrl.split('?', 1)[0].toLowerCase();
  return rawPath.length > 1 && rawPath.endsWith('/')
    ? rawPath.slice(0, -1)
    : rawPath;
}

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

export function sendInvalidReinforcementRequest(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415 = 400
): void {
  req.logger?.warn?.('reinforcement.request_rejected', {
    statusCode,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'REINFORCEMENT_REQUEST_INVALID',
      message: 'Reinforcement request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

function selectJsonParser(req: Request): RequestHandler {
  return normalizeRequestPath(req) === '/reinforce'
    ? reinforceJsonParser
    : feedbackJsonParser;
}

export const reinforcementBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const reinforcementRequest = req as ReinforcementBodyRequest;
  if (reinforcementRequest[reinforcementBodyParserApplied]) {
    next();
    return;
  }
  reinforcementRequest[reinforcementBodyParserApplied] = true;

  const operation = resolveReinforcementHttpOperation(req);
  if (!operation) {
    next();
    return;
  }
  if (operation.kind === 'read') {
    if (hasRequestBody(req)) {
      sendInvalidReinforcementRequest(req, res);
      return;
    }
    next();
    return;
  }
  if (!hasRequestBody(req)) {
    sendInvalidReinforcementRequest(req, res);
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || !hasJsonContentType(req)
  ) {
    sendInvalidReinforcementRequest(req, res, 415);
    return;
  }

  selectJsonParser(req)(req, res, (error?: unknown) => {
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
      sendInvalidReinforcementRequest(req, res, statusCode);
      return;
    }
    if (
      req.body === undefined
      || req.body === null
      || typeof req.body !== 'object'
      || Array.isArray(req.body)
    ) {
      sendInvalidReinforcementRequest(req, res);
      return;
    }
    next();
  });
};
