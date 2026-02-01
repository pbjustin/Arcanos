import type { Request, Response, NextFunction } from 'express';

/**
 * Purpose: Extract Bearer token from Authorization header.
 * Inputs/Outputs: request; returns token string or null.
 * Edge cases: returns null for missing or malformed headers.
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    //audit Assumption: authorization header missing or invalid; risk: auth bypass; invariant: null returned; handling: reject.
    return null;
  }
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    //audit Assumption: header not Bearer format; risk: malformed auth; invariant: null returned; handling: reject.
    return null;
  }
  return parts[1] || null;
}

/**
 * Purpose: Enforce daemon Bearer token authentication.
 * Inputs/Outputs: request/response/next; stores token on req or returns 401.
 * Edge cases: missing token returns 401 without calling next.
 */
export function requireDaemonAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    //audit Assumption: missing token is unauthorized; risk: unauthorized access; invariant: 401 returned; handling: reject.
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token required in Authorization header'
    });
    return;
  }

  // Store token in request for later use
  req.daemonToken = token;
  next();
}
