import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to enforce ARCANOS API token authentication.
 * Requires Authorization header: "Bearer <token>".
 */
export function requireApiToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ARCANOS_API_TOKEN;
  if (!expected) {
    console.warn('ARCANOS_API_TOKEN not set - memory endpoints are unprotected');
    return next();
  }
  const auth = req.headers['authorization'];
  const token = Array.isArray(auth) ? auth[0] : auth;
  if (token !== `Bearer ${expected}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
