import express, { type NextFunction, type Request, type Response } from 'express';

import { createRateLimitMiddleware, securityHeaders } from '@platform/runtime/security.js';
import {
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneHttpScopes,
  requireControlPlaneOperator,
} from '@services/controlPlane/httpAuth.js';
import {
  getLatestPromptDebugTrace,
  listPromptDebugTraces,
} from '@services/promptDebugTraceService.js';

const router = express.Router();
const requirePromptDebugReadScope = requireControlPlaneHttpScopes(
  ['arcanos:read'],
  'prompt_debug.http_authorization.denied'
);

function setPromptDebugNoStore(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

router.use(
  securityHeaders,
  setPromptDebugNoStore,
  createRateLimitMiddleware(60, 5 * 60 * 1000),
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
  requirePromptDebugReadScope
);

function resolveLimit(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

router.get('/latest', async (_req: Request, res: Response) => {
  const requestId =
    typeof _req.query.requestId === 'string' && _req.query.requestId.trim().length > 0
      ? _req.query.requestId.trim()
      : undefined;
  const latest = await getLatestPromptDebugTrace(requestId);

  res.json({
    latest,
  });
});

router.get('/events', async (req: Request, res: Response) => {
  const requestId =
    typeof req.query.requestId === 'string' && req.query.requestId.trim().length > 0
      ? req.query.requestId.trim()
      : undefined;
  const limit = resolveLimit(req.query.limit);
  const events = await listPromptDebugTraces(limit, requestId);

  res.json({
    count: events.length,
    events,
  });
});

router.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404
  });
});

export default router;
