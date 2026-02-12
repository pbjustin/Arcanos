/**
 * CLEAR 2.0 API Routes
 *
 * POST /clear/evaluate  — Evaluate CLEAR score for a plan payload
 * GET  /clear/:planId   — Get CLEAR score for an existing plan
 */

import express, { Request, Response } from 'express';
import { clearEvaluateInputSchema } from '@shared/types/actionPlan.js';
import { buildClear2Summary } from '../services/clear2.js';
import { getClearScore } from '../stores/actionPlanStore.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';

const router = express.Router();

/**
 * POST /clear/evaluate — Evaluate CLEAR 2.0 score for a plan payload (without creating a plan)
 */
router.post('/clear/evaluate', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableClear2) {
      res.status(503).json({ error: 'CLEAR 2.0 is not enabled' });
      return;
    }

    const parsed = clearEvaluateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid evaluate input', details: parsed.error.issues });
      return;
    }

    const { actions, origin, confidence } = parsed.data;
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
    res.status(500).json({ error: 'Failed to evaluate CLEAR score' });
  }
});

/**
 * GET /clear/:planId — Get CLEAR score for an existing plan
 */
router.get('/clear/:planId', async (req: Request, res: Response) => {
  try {
    const score = await getClearScore(req.params.planId);
    if (!score) {
      res.status(404).json({ error: 'CLEAR score not found for plan' });
      return;
    }
    res.json(score);
  } catch (error: unknown) {
    apiLogger.error('Get score failed', { module: 'clear', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to get CLEAR score' });
  }
});

export default router;
