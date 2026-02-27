import { Request, Response, NextFunction } from 'express';
import { AppError } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { resolveSafeRequestPath } from "@shared/requestPathSanitizer.js";

function isAppError(err: Error): err is AppError {
  return err instanceof AppError;
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
    res.status(err.httpCode).json({
      error: err.message,
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
