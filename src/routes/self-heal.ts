import { Router, Request, Response, type NextFunction } from 'express';
import { z } from 'zod';
import { capabilityGate } from '@transport/http/middleware/capabilityGate.js';
import { createRateLimitMiddleware } from '@platform/runtime/security.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import {
  runPredictiveHealingDecision,
  type PredictiveHealingSimulationInput
} from '@services/selfImprove/predictiveHealingService.js';
import {
  buildSelfHealEventsSnapshot,
  buildSelfHealInspectionSnapshot,
  buildSelfHealProviderHealthSnapshot,
  buildSelfHealRuntimeSnapshot,
} from '@services/selfHealRuntimeInspectionService.js';
import {
  selfHealingControlHttpBoundary,
} from '@services/controlPlane/selfHealingControlHttpBoundary.js';
import { authorizeControlPlaneHttpScopes } from '@services/controlPlane/httpAuth.js';
import {
  getSelfHealingPrincipalRateLimitKey,
  SELF_HEALING_CONTROL_RATE_LIMIT_WINDOW_MS,
  selfHealingDecisionRateLimit,
} from '@services/controlPlane/selfHealingControlRateLimits.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';

const router = Router();
const SELF_HEAL_PROVIDER_PROBE_RATE_LIMIT_MAX = 10;
const SELF_HEAL_INTERNAL_ERROR = 'SELF_HEAL_INTERNAL_ERROR';

export const SELF_HEAL_READ_SCOPE = 'arcanos:read';
export const SELF_HEAL_DECIDE_SCOPE = 'self-heal:decide';
export const SELF_HEAL_EXECUTE_SCOPE = 'self-heal:execute';
export const SELF_HEAL_PROVIDER_PROBE_SCOPE = 'self-heal:probe';

function isExecuteRequested(req: Request): boolean {
  return (
    req.body !== null
    && typeof req.body === 'object'
    && !Array.isArray(req.body)
    && (req.body as Record<string, unknown>).execute === true
  );
}

export function isActiveSelfHealProviderProbe(req: Request): boolean {
  return (
    typeof req.query.probe === 'string'
    && ['1', 'true', 'yes'].includes(req.query.probe.trim().toLowerCase())
  );
}

function requireSelfHealScopes(
  req: Request,
  res: Response,
  next: NextFunction,
  requiredScopes: readonly string[]
): void {
  authorizeControlPlaneHttpScopes(
    req,
    res,
    next,
    requiredScopes,
    'self_heal.http_authorization.denied'
  );
}

function requireSelfHealReadScope(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  requireSelfHealScopes(req, res, next, [SELF_HEAL_READ_SCOPE]);
}

function requireSelfHealProviderHealthScopes(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  requireSelfHealScopes(
    req,
    res,
    next,
    isActiveSelfHealProviderProbe(req)
      ? [SELF_HEAL_READ_SCOPE, SELF_HEAL_PROVIDER_PROBE_SCOPE]
      : [SELF_HEAL_READ_SCOPE]
  );
}

function requireSelfHealDecisionScopes(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  requireSelfHealScopes(
    req,
    res,
    next,
    isExecuteRequested(req)
      ? [SELF_HEAL_DECIDE_SCOPE, SELF_HEAL_EXECUTE_SCOPE]
      : [SELF_HEAL_DECIDE_SCOPE]
  );
}

function sendSelfHealRouteFailure(
  req: Request,
  res: Response,
  where: string
): void {
  req.logger?.error?.('self_heal.http_request.failed', {
    where,
    method: req.method,
    requestId: req.requestId,
  });
  sendInternalErrorPayload(res, {
    error: SELF_HEAL_INTERNAL_ERROR,
    where,
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

const selfHealProviderProbeRateLimit = createRateLimitMiddleware({
  bucketName: 'self-heal-provider-probe',
  maxRequests: SELF_HEAL_PROVIDER_PROBE_RATE_LIMIT_MAX,
  windowMs: SELF_HEALING_CONTROL_RATE_LIMIT_WINDOW_MS,
  keyGenerator: getSelfHealingPrincipalRateLimitKey,
  skip: (req) => !isActiveSelfHealProviderProbe(req),
});

router.use('/api/self-heal', selfHealingControlHttpBoundary);

const simulatedWorkerSchema = z.object({
  workerId: z.string().trim().min(1).max(128),
  healthStatus: z.string().trim().min(1).max(64),
  currentJobId: z.string().trim().min(1).max(128).nullable().optional()
});

const simulatedTrinityStageSchema = z.object({
  observationsInWindow: z.number().int().min(0).optional(),
  attempts: z.number().int().min(0).optional(),
  activeAction: z.enum(['enable_degraded_mode', 'bypass_final_stage']).nullable().optional(),
  verified: z.boolean().optional(),
  cooldownUntil: z.string().datetime().nullable().optional(),
  failedActions: z.array(
    z.enum(['enable_degraded_mode', 'bypass_final_stage'])
  ).max(2).optional()
}).partial();

const decidePredictiveSelfHealSchema = z.object({
  execute: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  source: z.string().trim().min(1).max(64).optional(),
  simulate: z.object({
    requestCount: z.number().int().min(0).optional(),
    errorRate: z.number().min(0).max(1).optional(),
    timeoutRate: z.number().min(0).max(1).optional(),
    avgLatencyMs: z.number().min(0).optional(),
    p95LatencyMs: z.number().min(0).optional(),
    maxLatencyMs: z.number().min(0).optional(),
    degradedCount: z.number().int().min(0).optional(),
    memory: z.object({
      rssMb: z.number().min(0).optional(),
      heapUsedMb: z.number().min(0).optional(),
      heapTotalMb: z.number().min(0).optional(),
      externalMb: z.number().min(0).optional(),
      arrayBuffersMb: z.number().min(0).optional()
    }).partial().optional(),
    workerHealth: z.object({
      overallStatus: z.enum(['healthy', 'degraded', 'unhealthy', 'offline']).nullable().optional(),
      alertCount: z.number().int().min(0).optional(),
      alerts: z.array(z.string().trim().min(1).max(256)).max(50).optional(),
      pending: z.number().int().min(0).optional(),
      running: z.number().int().min(0).optional(),
      delayed: z.number().int().min(0).optional(),
      stalledRunning: z.number().int().min(0).optional(),
      oldestPendingJobAgeMs: z.number().min(0).optional(),
      degradedWorkerIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      unhealthyWorkerIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      workers: z.array(simulatedWorkerSchema).max(100).optional()
    }).partial().optional(),
    workerRuntime: z.object({
      enabled: z.boolean().optional(),
      started: z.boolean().optional(),
      configuredCount: z.number().int().min(0).optional(),
      activeListeners: z.number().int().min(0).optional(),
      maxActiveWorkers: z.number().int().min(0).optional(),
      surgeWorkerCount: z.number().int().min(0).optional(),
      workerIds: z.array(z.string().trim().min(1).max(128)).max(100).optional()
    }).partial().optional(),
    promptRoute: z.object({
      active: z.boolean().optional(),
      mode: z.enum(['reduced_latency', 'degraded_response']).nullable().optional(),
      reason: z.string().trim().min(1).nullable().optional()
    }).partial().optional(),
    trinity: z.object({
      enabled: z.boolean().optional(),
      activeStage: z.enum(['intake', 'reasoning', 'final']).nullable().optional(),
      activeAction: z.enum(['enable_degraded_mode', 'bypass_final_stage']).nullable().optional(),
      verified: z.boolean().optional(),
      config: z.object({
        triggerThreshold: z.number().int().min(1).optional(),
        maxAttempts: z.number().int().min(1).optional()
      }).partial().optional(),
      stages: z.object({
        intake: simulatedTrinityStageSchema.optional(),
        reasoning: simulatedTrinityStageSchema.optional(),
        final: simulatedTrinityStageSchema.optional()
      }).partial().optional()
    }).partial().optional()
  }).partial().optional()
}).strip().superRefine((value, context) => {
  if (
    value.simulate !== undefined
    && (value.dryRun !== true || value.execute === true)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Simulation requires explicit dryRun=true and execute must not be true.',
      path: ['simulate'],
    });
  }
});

router.post(
  '/api/self-heal/decide',
  selfHealingDecisionRateLimit,
  requireSelfHealDecisionScopes,
  capabilityGate('self_improve_admin'),
  async (req: Request, res: Response) => {
    try {
      const parsed = decidePredictiveSelfHealSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid predictive self-heal payload',
          issues: parsed.error.issues
        });
        return;
      }
      const runtimeConfig = getConfig();
      const liveExecutionRequested =
        parsed.data.execute === true && parsed.data.dryRun !== true;
      if (
        liveExecutionRequested
        && (
          runtimeConfig.predictiveHealingEnabled !== true
          || runtimeConfig.predictiveHealingDryRun === true
        )
      ) {
        res.status(409).json({
          error: runtimeConfig.predictiveHealingEnabled !== true
            ? 'PREDICTIVE_HEALING_EXECUTION_DISABLED'
            : 'PREDICTIVE_HEALING_DRY_RUN_ENFORCED',
        });
        return;
      }

      req.logger?.info?.('self_heal.http_decision.authorized', {
        principalId: req.controlPlanePrincipal?.principalId,
        executeRequested: parsed.data.execute === true,
        sourceLabelPresent: parsed.data.source !== undefined,
      });
      const result = await runPredictiveHealingDecision({
        source: parsed.data.source ?? 'api_self_heal_decide',
        execute: parsed.data.execute,
        dryRun: parsed.data.dryRun,
        simulate: parsed.data.simulate as PredictiveHealingSimulationInput | undefined
      });

      res.json({
        status: 'ok',
        predictiveHealing: result
      });
    } catch {
      sendSelfHealRouteFailure(req, res, 'self-heal/decide');
    }
  }
);

router.get('/api/self-heal/runtime', requireSelfHealReadScope, (req: Request, res: Response) => {
  try {
    res.json(buildSelfHealRuntimeSnapshot());
  } catch {
    sendSelfHealRouteFailure(req, res, 'self-heal/runtime');
  }
});

router.get('/api/self-heal/events', requireSelfHealReadScope, (req: Request, res: Response) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
    res.json(buildSelfHealEventsSnapshot(limit));
  } catch {
    sendSelfHealRouteFailure(req, res, 'self-heal/events');
  }
});

router.get('/api/self-heal/inspection', requireSelfHealReadScope, async (req: Request, res: Response) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10;
    res.json(await buildSelfHealInspectionSnapshot(limit));
  } catch {
    sendSelfHealRouteFailure(req, res, 'self-heal/inspection');
  }
});

router.get(
  '/api/self-heal/provider-health',
  selfHealProviderProbeRateLimit,
  requireSelfHealProviderHealthScopes,
  async (req: Request, res: Response) => {
    try {
      const activeProbe = isActiveSelfHealProviderProbe(req);
      if (activeProbe) {
        req.logger?.info?.('self_heal.provider_probe.authorized', {
          principalId: req.controlPlanePrincipal?.principalId,
          requestId: req.requestId,
          activeProbe: true,
        });
      }
      res.json(await buildSelfHealProviderHealthSnapshot(activeProbe));
    } catch {
      sendSelfHealRouteFailure(req, res, 'self-heal/provider-health');
    }
  }
);

router.use('/api/self-heal', (_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
});

export default router;
