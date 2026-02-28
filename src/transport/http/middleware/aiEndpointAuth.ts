import type { NextFunction, Request, Response } from 'express';

/**
 * Purpose: Backwards-compatible middleware placeholder for AI endpoints.
 * Inputs/Outputs: Express middleware pass-through.
 */
export function requireAiEndpointAuth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export default requireAiEndpointAuth;

