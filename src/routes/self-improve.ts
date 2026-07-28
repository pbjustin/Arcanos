import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { capabilityGate } from "@transport/http/middleware/capabilityGate.js";
import {
  requireControlPlaneHttpScopes,
} from "@services/controlPlane/httpAuth.js";
import {
  selfHealingControlHttpBoundary,
} from "@services/controlPlane/selfHealingControlHttpBoundary.js";
import {
  selfHealingDecisionRateLimit,
  selfImproveControlRateLimit,
} from "@services/controlPlane/selfHealingControlRateLimits.js";
import { runSelfHealingLoop } from "@services/selfImprove/selfHealingLoop.js";
import {
  freezeSelfImprove,
  unfreezeSelfImprove,
  setAutonomyLevel,
  getKillSwitchStatus
} from "@services/incidentResponse/killSwitch.js";
import { sendInternalErrorPayload } from "@shared/http/index.js";

const router = Router();
const SELF_IMPROVE_INTERNAL_ERROR = 'SELF_IMPROVE_INTERNAL_ERROR';

export const SELF_IMPROVE_READ_SCOPE = 'arcanos:read';
export const SELF_IMPROVE_CONTROL_SCOPE = 'self-improve:control';
export const SELF_IMPROVE_RUN_SCOPES = Object.freeze([
  'self-heal:decide',
  'self-heal:execute',
]);

const requireSelfImproveReadScope = requireControlPlaneHttpScopes(
  [SELF_IMPROVE_READ_SCOPE],
  'self_improve.http_authorization.denied'
);
const requireSelfImproveRunScopes = requireControlPlaneHttpScopes(
  SELF_IMPROVE_RUN_SCOPES,
  'self_improve.http_authorization.denied'
);
const requireSelfImproveControlScope = requireControlPlaneHttpScopes(
  [SELF_IMPROVE_CONTROL_SCOPE],
  'self_improve.http_authorization.denied'
);

function sendSelfImproveRouteFailure(
  req: Request,
  res: Response,
  where: string
): void {
  req.logger?.error?.('self_improve.http_request.failed', {
    where,
    method: req.method,
    requestId: req.requestId,
  });
  sendInternalErrorPayload(res, {
    error: SELF_IMPROVE_INTERNAL_ERROR,
    where,
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

function logAuthorizedSelfImproveAction(
  req: Request,
  action: 'run' | 'freeze' | 'unfreeze' | 'autonomy',
  direction: 'execute' | 'restrictive' | 'relaxing' | 'potentially_relaxing',
  details: { requestedLevel?: number } = {}
): void {
  req.logger?.info?.('self_improve.http_action.authorized', {
    principalId: req.controlPlanePrincipal?.principalId,
    action,
    direction,
    requestId: req.requestId,
    ...(details.requestedLevel !== undefined
      ? { requestedLevel: details.requestedLevel }
      : {}),
  });
}

function isRedisDependencyUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  return candidate.dependency === 'redis'
    && candidate.code === 'REDIS_DEPENDENCY_UNAVAILABLE';
}

const selfImproveRunSchema = z.object({
  trigger: z.enum(['manual', 'self_test', 'clear', 'incident']).default('manual'),
  component: z.string().min(1).max(260).optional(),
  clearOverall: z.number().min(0).max(5).optional(),
  clearMin: z.number().min(0).max(5).optional(),
  selfTestFailed: z.boolean().optional(),
  selfTestFailureCount: z.number().int().min(0).max(1000).optional(),
  context: z.record(z.unknown()).optional()
}).strict();
const selfImproveControlReasonSchema = z.object({
  reason: z.string().trim().min(1).max(256).optional()
}).strict();
const selfImproveAutonomySchema = z.object({
  level: z.number().int().min(0).max(3),
  reason: z.string().trim().min(1).max(256).optional()
}).strict();

router.use('/api/self-improve', selfHealingControlHttpBoundary);

/**
 * Self-improve status
 */
router.get(
  '/api/self-improve/status',
  requireSelfImproveReadScope,
  capabilityGate('self_improve_admin'),
  async (req: Request, res: Response) => {
    try {
      res.json({
        status: 'ok',
        killSwitch: await getKillSwitchStatus()
      });
    } catch {
      sendSelfImproveRouteFailure(req, res, 'self-improve/status');
    }
  }
);

/**
 * Run one self-healing loop iteration on demand.
 * Protected by capability gate so the same bounded runtime path can be triggered manually.
 */
router.post(
  '/api/self-improve/run',
  selfHealingDecisionRateLimit,
  requireSelfImproveRunScopes,
  capabilityGate('self_improve_admin'),
  async (req: Request, res: Response) => {
    try {
      const parsed = selfImproveRunSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid self-improve payload',
          issues: parsed.error.issues
        });
        return;
      }
      logAuthorizedSelfImproveAction(req, 'run', 'execute');
      const result = await runSelfHealingLoop({
        trigger: 'manual',
        requestedCycle: parsed.data
      });
      res.json({ status: 'ok', result });
    } catch {
      sendSelfImproveRouteFailure(req, res, 'self-improve/run');
    }
  }
);

/**
 * Kill switch: freeze / unfreeze.
 */
router.post(
  '/api/self-improve/freeze',
  selfImproveControlRateLimit,
  requireSelfImproveControlScope,
  capabilityGate('self_improve_admin'),
  async (req: Request, res: Response) => {
    try {
      const parsed = selfImproveControlReasonSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid self-improve control payload',
          issues: parsed.error.issues
        });
        return;
      }
      const reason = parsed.data.reason ?? 'manual';
      logAuthorizedSelfImproveAction(req, 'freeze', 'restrictive');
      await freezeSelfImprove(reason);
      res.json({ status: 'ok', killSwitch: await getKillSwitchStatus() });
    } catch {
      sendSelfImproveRouteFailure(req, res, 'self-improve/freeze');
    }
  }
);

router.post(
  '/api/self-improve/unfreeze',
  selfImproveControlRateLimit,
  requireSelfImproveControlScope,
  capabilityGate('self_improve_admin'),
  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const parsed = selfImproveControlReasonSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid self-improve control payload',
          issues: parsed.error.issues
        });
        return;
      }
      const reason = parsed.data.reason ?? 'manual';
      logAuthorizedSelfImproveAction(req, 'unfreeze', 'relaxing');
      await unfreezeSelfImprove(reason);
      res.json({ status: 'ok', killSwitch: await getKillSwitchStatus() });
    } catch (error) {
      if (isRedisDependencyUnavailable(error)) {
        next(error);
        return;
      }
      sendSelfImproveRouteFailure(req, res, 'self-improve/unfreeze');
    }
  }
);

router.post(
  '/api/self-improve/autonomy',
  selfImproveControlRateLimit,
  requireSelfImproveControlScope,
  capabilityGate('self_improve_admin'),
  async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const parsed = selfImproveAutonomySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Missing or invalid level' });
        return;
      }
      const reason = parsed.data.reason ?? 'manual';
      logAuthorizedSelfImproveAction(
        req,
        'autonomy',
        'potentially_relaxing',
        { requestedLevel: parsed.data.level }
      );
      await setAutonomyLevel(parsed.data.level, reason);
      res.json({ status: 'ok', killSwitch: await getKillSwitchStatus() });
    } catch (error) {
      if (isRedisDependencyUnavailable(error)) {
        next(error);
        return;
      }
      sendSelfImproveRouteFailure(req, res, 'self-improve/autonomy');
    }
  }
);

router.use('/api/self-improve', (_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
});

export default router;
