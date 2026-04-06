import { Request, Response, NextFunction } from 'express';
import { AppError } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { resolveSafeRequestPath } from "@shared/requestPathSanitizer.js";

function isAppError(err: unknown): err is AppError {
  //audit Assumption: AppError may cross module boundaries and fail instanceof in some build contexts; failure risk: valid operational errors treated as 500; expected invariant: error-like objects with numeric httpCode and string message are treated as AppError; handling strategy: structural guard plus instanceof.
  if (err instanceof AppError) {
    return true;
  }

  if (!err || typeof err !== 'object') {
    return false;
  }

  const candidate = err as Record<string, unknown>;
  return typeof candidate.httpCode === 'number' && typeof candidate.message === 'string';
}

function isJsonSchemaParseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const candidate = err as Record<string, unknown>;
  const type = typeof candidate.type === 'string' ? candidate.type : '';
  const status = typeof candidate.status === 'number' ? candidate.status : null;
  const body = candidate.body;

  //audit Assumption: malformed JSON bodies should surface as client schema errors, not internal server failures; failure risk: operator dashboards count client mistakes as backend incidents; expected invariant: body-parser syntax failures map to HTTP 400; handling strategy: detect the parser-specific status/type/body shape before generic 500 handling.
  return type === 'entity.parse.failed' || (status === 400 && typeof body === 'string');
}

/**
 * Purpose: Centralize HTTP error responses with request-id correlation and stack logging.
 * Inputs/Outputs: Express error middleware; writes JSON error payload and status code.
 * Edge cases: Falls back to 500/internal message for unknown error types.
 */
const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.requestId ?? 'unknown';
  const traceId = req.traceId ?? requestId;
  const requestPath = resolveSafeRequestPath(req);

  // Normalize unknown error input into an Error-like shape for safe logging.
  let name = 'UnknownError';
  let message = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (err instanceof Error) {
    name = err.name || 'Error';
    message = err.message || message;
    stack = err.stack;
  } else if (err && typeof err === 'object') {
    const candidate = err as Record<string, unknown>;
    if (typeof candidate.name === 'string') {
      name = candidate.name;
    }
    if (typeof candidate.message === 'string') {
      message = candidate.message;
    }
    if (typeof candidate.stack === 'string') {
      stack = candidate.stack;
    }
  } else if (typeof err === 'string') {
    message = err;
  } else if (err !== undefined) {
    message = String(err);
  }

  let statusCode = 500;
  let payload: Record<string, unknown> = {
    error: 'Internal Server Error',
    code: 500
  };

  if (isJsonSchemaParseError(err)) {
    statusCode = 400;
    payload = {
      error: 'invalid request schema',
      code: 400
    };
  } else if (isAppError(err)) {
    const appError = err as AppError;
    statusCode = appError.httpCode;
    payload = {
      error: appError.message,
      code: appError.httpCode
    };
  }

  const logDetails = {
    traceId,
    requestId,
    method: req.method,
    path: requestPath,
    errorType: name,
    statusCode,
    name,
    message,
    stack
  };

  const logLevel: 'warn' | 'error' = statusCode >= 500 ? 'error' : 'warn';
  if (req.logger) {
    req.logger[logLevel]('request.failed', logDetails);
  } else {
    logger[logLevel]('request.failed', logDetails);
  }

  res.status(statusCode).json(payload);
};

export default errorHandler;
