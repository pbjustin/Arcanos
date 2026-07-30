import type { NextFunction, Request, Response } from 'express';

export { requestContext } from '@middleware/requestContext.js';
export { requestId } from '@middleware/requestId.js';

export function noStoreResponse(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
