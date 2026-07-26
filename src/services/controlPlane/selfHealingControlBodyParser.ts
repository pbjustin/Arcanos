import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

export const SELF_HEALING_CONTROL_BODY_LIMIT_BYTES = 256 * 1024;

const boundedJsonParser = express.json({
  limit: SELF_HEALING_CONTROL_BODY_LIMIT_BYTES,
  strict: true,
});

function hasRequestBody(req: Request): boolean {
  const contentLength = req.get('content-length');
  return req.get('transfer-encoding') !== undefined
    || (contentLength !== undefined && contentLength !== '0');
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

function sendInvalidBody(
  req: Request,
  res: Response,
  statusCode: 400 | 413 | 415
): void {
  req.logger?.warn?.('self_healing_control.request_rejected', {
    statusCode,
    method: req.method,
    requestId: req.requestId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).json({
    ok: false,
    error: {
      code: 'SELF_HEALING_CONTROL_REQUEST_INVALID',
      message: 'Self-healing control request is invalid.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

export const selfHealingControlBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.method.toUpperCase() !== 'POST') {
    next();
    return;
  }

  if (hasRequestBody(req) && !hasJsonContentType(req)) {
    sendInvalidBody(req, res, 415);
    return;
  }

  boundedJsonParser(req, res, (error?: unknown) => {
    if (error === undefined) {
      next();
      return;
    }

    const parserError = error && typeof error === 'object'
      ? error as { status?: unknown; statusCode?: unknown; type?: unknown }
      : {};
    const statusCode = parserError.type === 'entity.too.large'
      || parserError.status === 413
      || parserError.statusCode === 413
      ? 413
      : 400;

    sendInvalidBody(req, res, statusCode);
  });
};
