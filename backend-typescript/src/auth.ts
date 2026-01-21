/**
 * Authentication Module
 * JWT-based authentication middleware
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from './logger';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

export interface JWTPayload {
  userId: string;
  email?: string;
  iat?: number;
  exp?: number;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * Generate JWT token
 */
export function generateToken(userId: string, email?: string): string {
  return jwt.sign(
    { userId, email },
    getJwtSecret(),
    { expiresIn: '30d' }
  );
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, getJwtSecret()) as JWTPayload;
  } catch (error) {
    throw new Error('Invalid token');
  }
}

/**
 * JWT Authentication Middleware
 */
export function authenticateJWT(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'No authorization header provided'
    });
    return;
  }

  // Extract token (format: "Bearer <token>")
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid authorization format. Use: Bearer <token>'
    });
    return;
  }

  const token = parts[1];

  try {
    // Verify token
    const payload = verifyToken(token);
    req.user = payload;

    logger.info('Authentication successful', { userId: payload.userId });
    next();
  } catch (error) {
    logger.warn('Authentication failed', { error: (error as Error).message });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid or expired token'
    });
  }
}

/**
 * Optional authentication (doesn't reject unauthenticated requests)
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  void res;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    next();
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    try {
      const payload = verifyToken(parts[1]);
      req.user = payload;
    } catch (error) {
      // Continue without user
    }
  }

  next();
}
