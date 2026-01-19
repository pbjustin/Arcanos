import { RequestHandler } from 'express';

/**
 * Utility to wrap async Express route handlers.
 * Ensures any thrown errors are forwarded to Express error middleware,
 * providing consistent error handling across routes.
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
