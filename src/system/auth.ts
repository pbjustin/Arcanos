import { Router, Request, Response, NextFunction } from 'express';

let adminRouter: Router | null = null;
let adminKey: string | null = null;
let enabled = false;

/**
 * Enable admin control routes protected by a shared ADMIN_KEY.
 * When enabled, requests must include `Authorization: Bearer <ADMIN_KEY>`.
 */
export function enableAdminControl(key: string): void {
  if (enabled) return;
  adminKey = key;
  adminRouter = Router();

  adminRouter.use((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers['authorization'];
    const token = Array.isArray(auth) ? auth[0] : auth;
    if (token === `Bearer ${adminKey}`) {
      return next();
    }
    res.status(403).json({ error: 'Forbidden' });
  });

  adminRouter.get('/status', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  enabled = true;
  console.log('[ADMIN] Admin control routes enabled');
}

/**
 * Retrieve the admin router if admin control is enabled.
 */
export function getAdminRouter(): Router | null {
  return adminRouter;
}
