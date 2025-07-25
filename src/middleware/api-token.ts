import { Request, Response, NextFunction } from 'express';

/**
 * Enhanced middleware to enforce ARCANOS API token authentication.
 * Requires Authorization header: "Bearer <token>".
 * More strict on Railway environments.
 */
export function requireApiToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ARCANOS_API_TOKEN;
  const isRailway = !!(process.env.RAILWAY_ENVIRONMENT || 
                       process.env.RAILWAY_PROJECT_ID || 
                       process.env.RAILWAY_SERVICE_ID ||
                       process.env.RAILWAY_PROJECT);
  
  if (!expected) {
    if (isRailway) {
      // On Railway, missing token is an error
      return res.status(500).json({ 
        error: 'ARCANOS_API_TOKEN not configured',
        message: 'This Railway deployment requires ARCANOS_API_TOKEN to be set'
      });
    } else {
      // In development, log warning but allow access
      console.warn('ARCANOS_API_TOKEN not set - memory endpoints are unprotected');
      return next();
    }
  }

  const auth = req.headers['authorization'];
  const token = Array.isArray(auth) ? auth[0] : auth;
  
  if (token !== `Bearer ${expected}`) {
    return res.status(403).json({ 
      error: 'Forbidden',
      message: 'Valid ARCANOS_API_TOKEN required for this endpoint'
    });
  }
  
  next();
}

/**
 * Middleware for ARCANOS routing endpoints that require authentication
 */
export function requireArcanosToken(req: Request, res: Response, next: NextFunction) {
  // Apply stricter validation for ARCANOS routing endpoints
  return requireApiToken(req, res, next);
}
