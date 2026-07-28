import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

export const SYSTEM_STATE_BODY_LIMIT_BYTES = 64 * 1024;
const SYSTEM_STATE_BODY_MAX_DEPTH = 32;

const systemStateBodyParserApplied = Symbol('systemStateBodyParserApplied');
const boundedJsonParser = express.json({
  limit: SYSTEM_STATE_BODY_LIMIT_BYTES,
  strict: true,
  type: ['application/json', 'application/*+json'],
});

type SystemStateBodyRequest = Request & {
  [systemStateBodyParserApplied]?: true;
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
  if (value === undefined) {
    return true;
  }

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
    if (current.depth > SYSTEM_STATE_BODY_MAX_DEPTH) {
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

function sendInvalidSystemStateBody(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415
): void {
  req.logger?.warn?.('system_state.request_rejected', {
    statusCode,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'SYSTEM_STATE_REQUEST_INVALID',
      message: 'System-state request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

export const systemStateBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const systemStateRequest = req as SystemStateBodyRequest;
  if (systemStateRequest[systemStateBodyParserApplied]) {
    next();
    return;
  }
  systemStateRequest[systemStateBodyParserApplied] = true;

  if (req.method.toUpperCase() !== 'POST') {
    next();
    return;
  }
  if (
    hasUnsupportedContentEncoding(req)
    || countRawHeaders(req, 'content-type') > 1
    || (hasRequestBody(req) && !hasJsonContentType(req))
  ) {
    sendInvalidSystemStateBody(req, res, 415);
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
        : 400;
      sendInvalidSystemStateBody(req, res, statusCode);
      return;
    }
    if (
      req.body !== undefined
      && (
        req.body === null
        || typeof req.body !== 'object'
        || Array.isArray(req.body)
      )
    ) {
      sendInvalidSystemStateBody(req, res, 400);
      return;
    }
    if (!hasBoundedJsonDepth(req.body)) {
      sendInvalidSystemStateBody(req, res, 400);
      return;
    }
    next();
  });
};
