import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { createRateLimitMiddleware, securityHeaders } from '@platform/runtime/security.js';
import {
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneHttpScopes,
  requireControlPlaneOperator,
} from '@services/controlPlane/httpAuth.js';
import { getLatestAiRoutingDebugSnapshot } from '@services/aiRoutingDebugService.js';

const router = express.Router();
const requireAiRoutingDebugReadScope = requireControlPlaneHttpScopes(
  ['arcanos:read'],
  'ai_routing_debug.http_authorization.denied',
);

function setAiRoutingDebugNoStore(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

router.use(
  '/api/ai-routing/debug',
  securityHeaders,
  setAiRoutingDebugNoStore,
  createRateLimitMiddleware(60, 5 * 60 * 1000),
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
  requireAiRoutingDebugReadScope,
);

router.get('/api/ai-routing/debug/latest', (req: Request, res: Response) => {
  const requestId =
    typeof req.query.requestId === 'string' && req.query.requestId.trim().length > 0
      ? req.query.requestId.trim()
      : undefined;

  res.json({
    latest: getLatestAiRoutingDebugSnapshot(requestId),
  });
});

router.use('/api/ai-routing/debug', (_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
});

export default router;
