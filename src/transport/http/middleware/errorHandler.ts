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

/**
 * Purpose: Centralize HTTP error responses with request-id correlation and stack logging.
 * Inputs/Outputs: Express error middleware; writes JSON error payload and status code.
 * Edge cases: Falls back to 500/internal message for unknown error types.
 */
const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.requestId ?? 'unknown';
  const requestPath = resolveSafeRequestPath(req);

  const logDetails = {
    requestId,
    method: req.method,
    path: requestPath,
    name: err.name,
    message: err.message,
    stack: err.stack
  };

  if (req.logger) {
    req.logger.error('request.failed', logDetails);
  } else {
    logger.error('request.failed', logDetails);
  }

  //audit Assumption: operational AppError instances carry client-safe status/message; failure risk: leaking internal error details; expected invariant: unknown errors return generic message; handling strategy: branch on AppError type.
  if (isAppError(err)) {
    const appError = err as AppError;
    res.status(appError.httpCode).json({
      error: appError.message,
      requestId
    });
    return;
  }

  res.status(500).json({
    error: 'An unexpected error occurred.',
    requestId
  });
};

export default errorHandler;
