import { Router, Request, Response } from "express";
import { z } from "zod";
import { capabilityGate } from "@transport/http/middleware/capabilityGate.js";
import { runSelfHealingLoop } from "@services/selfImprove/selfHealingLoop.js";
import {
  freezeSelfImprove,
  unfreezeSelfImprove,
  setAutonomyLevel,
  getKillSwitchStatus
} from "@services/incidentResponse/killSwitch.js";
import { sendInternalErrorPayload } from "@shared/http/index.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

const router = Router();

const selfImproveRunSchema = z.object({
  trigger: z.enum(['manual', 'self_test', 'clear', 'incident']).default('manual'),
  component: z.string().min(1).max(260).optional(),
  clearOverall: z.number().min(0).max(5).optional(),
  clearMin: z.number().min(0).max(5).optional(),
  selfTestFailed: z.boolean().optional(),
  selfTestFailureCount: z.number().int().min(0).max(1000).optional(),
  context: z.record(z.unknown()).optional()
}).strip();

/**
 * Self-improve status
 */
router.get('/api/self-improve/status', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    res.json({
      status: 'ok',
      killSwitch: await getKillSwitchStatus()
    });
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-improve/status'
    });
  }
});

/**
 * Run one self-healing loop iteration on demand.
 * Protected by capability gate so the same bounded runtime path can be triggered manually.
 */
router.post('/api/self-improve/run', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    const parsed = selfImproveRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid self-improve payload',
        issues: parsed.error.issues
      });
      return;
    }
    const result = await runSelfHealingLoop({
      trigger: 'manual',
      requestedCycle: parsed.data
    });
    res.json({ status: 'ok', result });
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-improve/run'
    });
  }
});

/**
 * Kill switch: freeze / unfreeze.
 */
router.post('/api/self-improve/freeze', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    const reason = String(req.body?.reason ?? 'manual');
    await freezeSelfImprove(reason);
    res.json({ status: 'ok', killSwitch: await getKillSwitchStatus() });
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-improve/freeze'
    });
  }
});

router.post('/api/self-improve/unfreeze', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    const reason = String(req.body?.reason ?? 'manual');
    await unfreezeSelfImprove(reason);
    res.json({ status: 'ok', killSwitch: await getKillSwitchStatus() });
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-improve/unfreeze'
    });
  }
});

router.post('/api/self-improve/autonomy', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    const level = Number(req.body?.level);
    if (!Number.isFinite(level)) {
      res.status(400).json({ error: 'Missing or invalid level' });
      return;
    }
    const reason = String(req.body?.reason ?? 'manual');
    await setAutonomyLevel(level, reason);
    res.json({ status: 'ok', killSwitch: await getKillSwitchStatus() });
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-improve/autonomy'
    });
  }
});

export default router;
