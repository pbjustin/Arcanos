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
import {
  CLEAR_PUBLIC_ERRORS,
  interpretClear2Outcome,
  type ClearPublicError,
} from '../services/clearDecision.js';
import { getAuthoritativePlan } from '../stores/actionPlanStore.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import { asyncHandler, validateBody, validateParams } from '@shared/http/index.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  getRequestClientAddress,
} from '@platform/runtime/security.js';
import {
  actionPlanAuthenticationMiddleware,
  requireActionPlanRoles,
} from '@services/actionPlanExecution/auth.js';
import { deriveActionPlanExecutionRealm } from '@services/actionPlanExecution/realm.js';
import {
  actionPlanRateLimitOperation,
  sendActionPlanExecutionError,
  setActionPlanNoStore,
} from '@services/actionPlanExecution/http.js';
import {
  ACTION_PLAN_EXECUTION_ERRORS,
  ActionPlanExecutionError,
} from '@services/actionPlanExecution/errors.js';

const router = express.Router();

function safeThrownClass(error: unknown): string {
  try {
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof Error) return 'Error';
    return 'ThrownValue';
  } catch {
    return 'ThrownValue';
  }
}

function logClearRouteFailure(
  req: express.Request,
  failure: ClearPublicError,
  params: { error?: unknown; errorCaptured?: boolean; outcomeReason?: string; retryable: boolean },
): void {
  try {
    apiLogger.error('CLEAR evaluation failed', {
      module: 'clear',
      errorCode: failure.code,
      operation: 'clear.evaluate',
      dependency: 'clear2',
      ...(params.errorCaptured || params.error !== undefined ? { errorClass: safeThrownClass(params.error) } : {}),
      ...(params.outcomeReason ? { outcomeReason: params.outcomeReason } : {}),
      requestId: req.requestId ?? 'unknown',
      traceId: req.traceId ?? req.requestId ?? 'unknown',
      retryable: params.retryable,
    });
  } catch {
    // Diagnostics must not mask the stable public response.
  }
}

function sendClearRouteFailure(res: express.Response, failure: ClearPublicError): void {
  res.status(failure.httpStatus).json({ error: failure.code, message: failure.message });
}

const planIdSchema = z.object({
  planId: z.string().min(1).max(128),
}).strict();
const storedClearClientRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-clear-client',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}`,
});
const storedClearCredentialRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-clear-credential',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}:${getRequestActorKey(req)}`,
});
const storedClearPrincipalRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-clear-principal',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `principal:${req.actionPlanPrincipal!.role}:${req.actionPlanPrincipal!.principalId}:operation:${actionPlanRateLimitOperation(req)}`,
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

      const outcome = interpretClear2Outcome(score);
      if (outcome.kind === 'indeterminate') {
        const failure = CLEAR_PUBLIC_ERRORS.evaluationUnavailable;
        logClearRouteFailure(req, failure, { outcomeReason: outcome.reason, retryable: true });
        sendClearRouteFailure(res, failure);
        return;
      }
      if (outcome.kind === 'invalid') {
        const failure = CLEAR_PUBLIC_ERRORS.resultInvalid;
        logClearRouteFailure(req, failure, { outcomeReason: outcome.reason, retryable: false });
        sendClearRouteFailure(res, failure);
        return;
      }

      res.json(score);
    } catch (error: unknown) {
      const failure = CLEAR_PUBLIC_ERRORS.evaluationUnavailable;
      logClearRouteFailure(req, failure, { error, errorCaptured: true, retryable: true });
      sendClearRouteFailure(res, failure);
    }
  })
);

/**
 * GET /clear/:planId — Get CLEAR score for an existing plan
 */
router.get(
  '/clear/:planId',
  (_req, res, next) => {
    setActionPlanNoStore(res);
    next();
  },
  storedClearClientRateLimit,
  storedClearCredentialRateLimit,
  actionPlanAuthenticationMiddleware,
  storedClearPrincipalRateLimit,
  requireActionPlanRoles('requester', 'operator'),
  validateParams(planIdSchema),
  asyncHandler(async (req, res) => {
    try {
      const { planId } = req.validated!.params as z.infer<typeof planIdSchema>;
      const realm = deriveActionPlanExecutionRealm();
      if (!realm) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.realmUnavailable);
      const plan = await getAuthoritativePlan(planId);
      const principal = req.actionPlanPrincipal!;
      if (
        !plan
        || plan.executionRealm !== realm
        || (principal.role === 'requester' && plan.ownerPrincipalId !== principal.principalId)
        || !plan.clearScore
      ) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      }
      res.json(plan.clearScore);
    } catch (error: unknown) {
      apiLogger.error('Get score failed', {
        module: 'clear',
        errorCode: 'CLEAR_SCORE_READ_FAILED',
        errorClass: error instanceof Error ? 'Error' : 'ThrownValue',
      });
      sendActionPlanExecutionError(res, error, {
        requestId: req.requestId,
        traceId: req.traceId,
      });
    }
  })
);

export default router;
