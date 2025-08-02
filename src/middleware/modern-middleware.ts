/**
 * Modern middleware utilities for Express routes
 * Provides reusable middleware patterns with proper TypeScript typing
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Generic rate limiting middleware factory
 * @param limit - Maximum number of concurrent operations
 * @param counterName - Name for the counter (used in error messages)
 * @returns Express middleware function
 */
export function createRateLimitMiddleware(limit: number, counterName: string = 'operations') {
  let activeCount = 0;

  interface RateLimitTracker {
    increment: () => void;
    decrement: () => void;
    getCount: () => number;
    isAtLimit: () => boolean;
    getLimit: () => number;
  }

  interface RequestWithRateLimit extends Request {
    rateLimit: RateLimitTracker;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    (req as RequestWithRateLimit).rateLimit = {
      increment: () => activeCount++,
      decrement: () => activeCount--,
      getCount: () => activeCount,
      isAtLimit: () => activeCount >= limit,
      getLimit: () => limit
    };
    next();
  };
}

/**
 * Error handling middleware with modern async/await support
 * @param handler - Async route handler function
 * @returns Express middleware that catches async errors
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Request timing middleware for performance monitoring
 */
export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  
  // Add timing info to request
  (req as any).startTime = startTime;
  
  // Use res.on('finish') to capture response time without overriding res.end
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    res.setHeader('X-Response-Time', `${duration}ms`);
  });
  
  next();
}

/**
 * JSON validation middleware factory
 * @param schema - Validation schema (basic example)
 * @returns Express middleware for request validation
 */
export function createValidationMiddleware(requiredFields: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];
    
    for (const field of requiredFields) {
      if (!req.body[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    
    if (errors.length > 0) {
      res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
      return;
    }
    
    next();
  };
}