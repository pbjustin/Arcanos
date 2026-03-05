import { Router, Request, Response } from "express";
import { capabilityGate } from "@transport/http/middleware/capabilityGate.js";
import { runSelfImproveCycle } from "@services/selfImprove/controller.js";
import {
  freezeSelfImprove,
  unfreezeSelfImprove,
  setAutonomyLevel,
  getKillSwitchStatus
} from "@services/incidentResponse/killSwitch.js";
import { sendInternalErrorPayload } from "@shared/http/index.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

const router = Router();

/**
 * Self-improve status
 */
router.get('/api/self-improve/status', capabilityGate('self_improve_admin'), (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    killSwitch: getKillSwitchStatus()
  });
});

/**
 * Run a self-improve cycle (proposal only).
 * Protected by capability gate; use staged rollout via SELF_IMPROVE_AUTONOMY_LEVEL.
 */
router.post('/api/self-improve/run', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    const result = await runSelfImproveCycle(req.body ?? { trigger: 'manual' });
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
router.post('/api/self-improve/freeze', capabilityGate('self_improve_admin'), (req: Request, res: Response) => {
  const reason = String(req.body?.reason ?? 'manual');
  freezeSelfImprove(reason);
  res.json({ status: 'ok', killSwitch: getKillSwitchStatus() });
});

router.post('/api/self-improve/unfreeze', capabilityGate('self_improve_admin'), (req: Request, res: Response) => {
  const reason = String(req.body?.reason ?? 'manual');
  unfreezeSelfImprove(reason);
  res.json({ status: 'ok', killSwitch: getKillSwitchStatus() });
});

router.post('/api/self-improve/autonomy', capabilityGate('self_improve_admin'), (req: Request, res: Response) => {
  const level = Number(req.body?.level);
  if (!Number.isFinite(level)) {
    res.status(400).json({ error: 'Missing or invalid level' });
    return;
  }
  const reason = String(req.body?.reason ?? 'manual');
  setAutonomyLevel(level, reason);
  res.json({ status: 'ok', killSwitch: getKillSwitchStatus() });
});

export default router;
