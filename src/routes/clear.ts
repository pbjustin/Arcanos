/**
 * CLEAR 2.0 API Routes
 *
 * POST /clear/evaluate  — Evaluate CLEAR score for a plan payload
 * GET  /clear/:planId   — Get CLEAR score for an existing plan
 */

import express from 'express';
import { z } from 'zod';
import { clearEvaluateInputSchema } from '@shared/types/actionPlan.js';
import { buildClear2Summary } from '../services/clear2.js';
import { getClearScore } from '../stores/actionPlanStore.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import { asyncHandler, validateBody, validateParams, sendNotFoundError, sendInternalError } from '@shared/http/index.js';

const router = express.Router();

const planIdSchema = z.object({
  planId: z.string().min(1)
});

/**
 * POST /clear/evaluate — Evaluate CLEAR 2.0 score for a plan payload (without creating a plan)
 */
router.post(
  '/clear/evaluate',
  validateBody(clearEvaluateInputSchema),
  asyncHandler(async (req, res) => {
    try {
      const config = getConfig();
      if (!config.enableClear2) {
        res.status(503).json({ error: 'CLEAR 2.0 is not enabled' });
        return;
      }

      const { actions, origin, confidence } = req.validated!.body as any;
      const hasRollbacks = actions.some((a: { rollback_action?: unknown }) => a.rollback_action != null);

      const score = buildClear2Summary({
        actions,
        origin,
        confidence,
        hasRollbacks,
        capabilitiesKnown: false,
        agentsRegistered: false,
      });

      res.json(score);
    } catch (error: unknown) {
      apiLogger.error('Evaluate failed', { module: 'clear', error: resolveErrorMessage(error) });
      sendInternalError(res, 'Failed to evaluate CLEAR score');
    }
  })
);

/**
 * GET /clear/:planId — Get CLEAR score for an existing plan
 */
router.get(
  '/clear/:planId',
  validateParams(planIdSchema),
  asyncHandler(async (req, res) => {
    try {
      const { planId } = req.validated!.params as z.infer<typeof planIdSchema>;
      const score = await getClearScore(planId);
      if (!score) {
        sendNotFoundError(res, 'CLEAR score not found for plan');
        return;
      }
      res.json(score);
    } catch (error: unknown) {
      apiLogger.error('Get score failed', { module: 'clear', error: resolveErrorMessage(error) });
      sendInternalError(res, 'Failed to get CLEAR score');
    }
  })
);

export default router;
