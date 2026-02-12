import { Request, Response, NextFunction } from 'express';
import { AppError } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";

function isAppError(err: Error): err is AppError {
  return err instanceof AppError;
}

const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
  if (isAppError(err)) {
    logger.error(err.name, {
      message: err.message,
      httpCode: err.httpCode,
      isOperational: err.isOperational,
      stack: err.stack,
    });
    res.status(err.httpCode).json({
      name: err.name,
      message: err.message,
    });
  } else {
    logger.error('UnhandledError', {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      name: 'InternalServerError',
      message: 'An unexpected error occurred.',
    });
  }
};

export default errorHandler;
