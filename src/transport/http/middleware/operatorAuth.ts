import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    operatorActor?: string;
  }
}

/**
 * Purpose: Backwards-compatible middleware placeholder for operator routes.
 */
export function operatorAuth(req: Request, _res: Response, next: NextFunction): void {
  req.operatorActor = 'operator:anonymous';
  next();
}

export default operatorAuth;
