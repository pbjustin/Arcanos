import type { Request, Response, NextFunction } from 'express';

/**
 * Purpose: Backwards-compatible middleware placeholder for daemon routes.
 * Inputs/Outputs: request/response/next; always sets a default daemon token.
 */
export function requireDaemonAuth(req: Request, _res: Response, next: NextFunction): void {
  req.daemonToken = 'anonymous-daemon';
  next();
}

