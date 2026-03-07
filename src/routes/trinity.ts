import express, { NextFunction, Request, Response } from 'express';
import { asyncHandler, sendInternalErrorPayload } from '@shared/http/index.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  getTrinityStatus,
  type TrinityStatusResponse
} from '@services/trinityStatusService.js';

const router = express.Router();

/**
 * GET /trinity/status - Expose live Trinity pipeline bindings and health.
 *
 * Purpose:
 * - Give operators and probes one explicit endpoint that confirms Trinity worker connectivity, memory sync visibility, and recent dispatch activity.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: `TrinityStatusResponse`.
 *
 * Edge case behavior:
 * - Returns `503` only when the Trinity pipeline is effectively offline; degraded states still return `200` with explicit status detail.
 */
router.get(
  '/trinity/status',
  asyncHandler(async (_req: Request, res: Response<TrinityStatusResponse>) => {
    const payload = await getTrinityStatus();
    const statusCode = payload.status === 'offline' ? 503 : 200;

    res.status(statusCode).json(payload);
  })
);

router.use((
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  //audit Assumption: Trinity status failures should still produce a structured health-route error; failure risk: probes receive an opaque Express stack trace; expected invariant: the route returns JSON on unexpected exceptions; handling strategy: convert route errors into one internal-error payload.
  sendInternalErrorPayload(res, {
    error: 'TRINITY_STATUS_FAILED',
    message: resolveErrorMessage(error)
  });
});

export default router;
