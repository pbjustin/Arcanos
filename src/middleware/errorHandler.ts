import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../utils/structuredLogging.js';

function isAppError(err: Error): err is AppError {
  return err instanceof AppError;
}

const errorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction) => {
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
