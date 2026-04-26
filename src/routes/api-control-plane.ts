import express, { Request, Response } from 'express';

import { createRateLimitMiddleware, securityHeaders } from '@platform/runtime/security.js';
import { asyncHandler } from '@shared/http/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  executeControlPlaneOperation,
  listControlPlaneAllowlist,
} from '@services/controlPlane/index.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware({
  bucketName: 'control-plane',
  maxRequests: 30,
  windowMs: 15 * 60 * 1000,
}));

function resolveStatusCode(response: { ok: boolean; error?: { code?: string } }): number {
  if (response.ok) {
    return 200;
  }
  switch (response.error?.code) {
    case 'ERR_CONTROL_PLANE_SCHEMA':
    case 'ERR_CONTROL_PLANE_BAD_REQUEST':
      return 400;
    case 'ERR_CONTROL_PLANE_DENIED':
    case 'ERR_CONTROL_PLANE_SCOPE':
      return 403;
    case 'ERR_CONTROL_PLANE_APPROVAL':
      return 428;
    default:
      return 500;
  }
}

router.get(
  '/allowlist',
  (_req: Request, res: Response) => {
    res.json({
      ok: true,
      operations: listControlPlaneAllowlist(),
    });
  }
);

router.post(
  '/operations',
  confirmGate,
  asyncHandler(async (req: Request, res: Response) => {
    const response = await executeControlPlaneOperation(req.body, { request: req });
    res.status(resolveStatusCode(response)).json(response);
  })
);

export default router;
