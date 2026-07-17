import { sendBadRequest, sendNotFound, sendInternalErrorCode } from '@shared/http/index.js';
/**
 * ActionPlan API Routes
 *
 * POST   /plans                  — Create plan, compute CLEAR, return plan+score
 * GET    /plans/:planId          — Get plan by ID with CLEAR score
 * POST   /plans/:planId/approve  — Approve plan (only if CLEAR allows/confirms)
 * POST   /plans/:planId/block    — Block plan
 * POST   /plans/:planId/expire   — Expire plan
 * POST   /plans/:planId/execute  — Dispatch plan to agent, create ExecutionResult
 * GET    /plans/:planId/results  — Get execution results for plan
 */

import express, { Request, Response } from 'express';
import { actionPlanInputSchema, executionResultInputSchema } from '@shared/types/actionPlan.js';
import {
  createPlan,
  getPlan,
  approvePlan,
  blockPlan,
  expirePlan,
  listPlans,
  createExecutionResult,
  getExecutionResults,
} from '../stores/actionPlanStore.js';
import { validateCapability } from '../stores/agentRegistry.js';
import { buildClear2Summary } from '../services/clear2.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import type { PlanStatus, ActionPlanRecord } from '@shared/types/actionPlan.js';
import { acquireExecutionLock } from '../services/safety/executionLock.js';
import { emitSafetyAuditEvent } from '../services/safety/auditEvents.js';
import {
  CLEAR_PUBLIC_ERRORS,
  interpretClear2Outcome,
  type ClearPublicError,
} from '../services/clearDecision.js';

const router = express.Router();

function safeThrownClass(error: unknown): string {
  try {
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof Error) return 'Error';
    if (error === null) return 'ThrownNull';
    if (error === undefined) return 'ThrownUndefined';
    if (typeof error === 'string') return 'ThrownString';
    if (typeof error === 'number') return 'ThrownNumber';
    if (typeof error === 'boolean') return 'ThrownBoolean';
    return 'ThrownObject';
  } catch {
    return 'ThrownValue';
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  try {
    if (error instanceof Error || typeof error === 'string') {
      return resolveErrorMessage(error).includes('Unique constraint');
    }
    if (error && typeof error === 'object') {
      const message = Reflect.get(error, 'message');
      return typeof message === 'string' && message.includes('Unique constraint');
    }
  } catch {
    // Error classification must never replace the stable failure response.
  }
  return false;
}

function logClearExecutionFailure(
  req: Request,
  failure: ClearPublicError,
  params: {
    operation: string;
    dependency: string;
    error?: unknown;
    errorCaptured?: boolean;
    outcomeReason?: string;
    retryable: boolean;
  },
): void {
  try {
    apiLogger.error('CLEAR execution failed', {
      module: 'plans',
      errorCode: failure.code,
      operation: params.operation,
      dependency: params.dependency,
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

function sendClearFailure(res: Response, failure: ClearPublicError): void {
  res.status(failure.httpStatus).json({ error: failure.code, message: failure.message });
}

/**
 * POST /plans — Create a new ActionPlan
 */
router.post('/plans', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const parsed = actionPlanInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBadRequest(
        res,
        'Invalid plan input',
        parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      );
      return;
    }

    const plan = await createPlan(parsed.data);
    res.status(201).json(plan);
  } catch (error: unknown) {
    // Idempotency key conflict
    if (isUniqueConstraintError(error)) {
      res.status(409).json({ error: 'Plan with this idempotency_key already exists' });
      return;
    }
    apiLogger.error('Create failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to create plan');
  }
});

/**
 * GET /plans — List plans with optional filters
 */
router.get('/plans', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const status = req.query.status as string | undefined;
    const createdBy = req.query.created_by as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const plans = await listPlans({ status: status as PlanStatus | undefined, createdBy, limit });
    res.json({ plans, count: plans.length });
  } catch (error: unknown) {
    apiLogger.error('List failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to list plans');
  }
});

/**
 * GET /plans/:planId — Get plan by ID
 */
router.get('/plans/:planId', async (req: Request, res: Response) => {
  try {
    const plan = await getPlan(req.params.planId);
    if (!plan) {
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    apiLogger.error('Get failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to get plan');
  }
});

/**
 * POST /plans/:planId/approve — Approve a plan
 */
router.post('/plans/:planId/approve', async (req: Request, res: Response) => {
  try {
    const plan = await approvePlan(req.params.planId);
    if (!plan) {
      // Determine reason
      const existing = await getPlan(req.params.planId);
      if (!existing) {
        sendNotFound(res, 'Plan not found');
        return;
      }
      if (existing.clearScore?.decision === 'block') {
        res.status(403).json({
          error: 'Cannot approve blocked plan',
          clearDecision: existing.clearScore.decision,
          clearOverall: existing.clearScore.overall,
        });
        return;
      }
      res.status(409).json({
        error: `Cannot approve plan in ${existing.status} status`,
        currentStatus: existing.status,
      });
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    apiLogger.error('Approve failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to approve plan');
  }
});

/**
 * POST /plans/:planId/block — Block a plan
 */
router.post('/plans/:planId/block', async (req: Request, res: Response) => {
  try {
    const plan = await blockPlan(req.params.planId);
    if (!plan) {
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    apiLogger.error('Block failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to block plan');
  }
});

/**
 * POST /plans/:planId/expire — Expire a plan
 */
router.post('/plans/:planId/expire', async (req: Request, res: Response) => {
  try {
    const plan = await expirePlan(req.params.planId);
    if (!plan) {
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    apiLogger.error('Expire failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to expire plan');
  }
});

/** Validate all actions have registered agent capabilities. Returns the first failing action or null. */
async function findMissingCapability(plan: ActionPlanRecord) {
  for (const action of plan.actions) {
    const hasCapability = await validateCapability(action.agentId, action.capability);
    if (!hasCapability) return action;
  }
  return null;
}

/** Build CLEAR 2.0 re-evaluation input from an existing plan record. */
function buildClearRecheckInput(plan: ActionPlanRecord) {
  return {
    actions: plan.actions.map(a => ({
      action_id: a.id,
      agent_id: a.agentId,
      capability: a.capability,
      params: a.params as Record<string, unknown>,
      timeout_ms: a.timeoutMs,
    })),
    origin: plan.origin,
    confidence: plan.confidence,
    hasRollbacks: plan.actions.some(a => a.rollbackAction != null),
    capabilitiesKnown: true,
    agentsRegistered: true,
  };
}

/**
 * POST /plans/:planId/execute — Execute plan actions
 */
router.post('/plans/:planId/execute', async (req: Request, res: Response) => {
  try {
    const plan = await getPlan(req.params.planId);
    if (!plan) {
      sendNotFound(res, 'Plan not found');
      return;
    }

    // Guard: blocked plans never execute
    if (plan.status === 'blocked' || plan.clearScore?.decision === 'block') {
      res.status(403).json({ error: 'Cannot execute blocked plan', clearDecision: plan.clearScore?.decision });
      return;
    }

    // Guard: only approved plans can execute
    if (plan.status !== 'approved') {
      res.status(409).json({ error: `Plan must be approved before execution, current status: ${plan.status}` });
      return;
    }

    // Validate agent capabilities
    const missingAction = await findMissingCapability(plan);
    if (missingAction) {
      res.status(403).json({ error: `Agent ${missingAction.agentId} lacks capability: ${missingAction.capability}`, actionId: missingAction.id });
      return;
    }

    // Re-evaluate CLEAR before execution.
    let clearRecheck: unknown;
    try {
      clearRecheck = buildClear2Summary(buildClearRecheckInput(plan));
    } catch (error) {
      const failure = CLEAR_PUBLIC_ERRORS.evaluationUnavailable;
      logClearExecutionFailure(req, failure, {
        operation: 'plans.execute.clear_recheck',
        dependency: 'clear2',
        error,
        errorCaptured: true,
        retryable: true,
      });
      sendClearFailure(res, failure);
      return;
    }

    const clearOutcome = interpretClear2Outcome(clearRecheck);
    if (clearOutcome.kind === 'indeterminate') {
      const failure = CLEAR_PUBLIC_ERRORS.evaluationUnavailable;
      logClearExecutionFailure(req, failure, {
        operation: 'plans.execute.clear_recheck',
        dependency: 'clear2',
        outcomeReason: clearOutcome.reason,
        retryable: true,
      });
      sendClearFailure(res, failure);
      return;
    }
    if (clearOutcome.kind === 'invalid') {
      const failure = CLEAR_PUBLIC_ERRORS.resultInvalid;
      logClearExecutionFailure(req, failure, {
        operation: 'plans.execute.clear_recheck',
        dependency: 'clear2',
        outcomeReason: clearOutcome.reason,
        retryable: false,
      });
      sendClearFailure(res, failure);
      return;
    }

    if (clearOutcome.kind === 'block') {
      let blockedPlan: ActionPlanRecord | null;
      try {
        blockedPlan = await blockPlan(plan.id);
      } catch (error) {
        const failure = CLEAR_PUBLIC_ERRORS.persistenceFailed;
        logClearExecutionFailure(req, failure, {
          operation: 'plans.execute.persist_block',
          dependency: 'actionPlanStore',
          error,
          errorCaptured: true,
          retryable: true,
        });
        sendClearFailure(res, failure);
        return;
      }
      if (!blockedPlan) {
        const failure = CLEAR_PUBLIC_ERRORS.persistenceFailed;
        logClearExecutionFailure(req, failure, {
          operation: 'plans.execute.persist_block',
          dependency: 'actionPlanStore',
          outcomeReason: 'missing_persistence_result',
          retryable: true,
        });
        sendClearFailure(res, failure);
        return;
      }
      res.status(403).json({ error: 'CLEAR re-evaluation blocked this plan', clearScore: clearRecheck });
      return;
    }

    const lock = await acquireExecutionLock(`policy-task:${plan.id}`);
    //audit Assumption: policy task execution must be single-active per plan; failure risk: duplicate execution and conflicting writes; expected invariant: duplicate starts suppressed; handling strategy: return 409 and emit audit.
    if (!lock) {
      emitSafetyAuditEvent({
        event: 'policy_task_duplicate_suppressed',
        severity: 'warn',
        details: {
          planId: plan.id
        }
      });
      res.status(409).json({
        error: 'Policy task execution suppressed due to duplicate lock',
        planId: plan.id
      });
      return;
    }

    let results: Awaited<ReturnType<typeof createExecutionResult>>[] | undefined;
    let persistenceFailed = false;
    let persistenceError: unknown;
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      // Dispatch: create execution results (actual execution is handled by agents)
      results = await Promise.all(
        plan.actions.map(action => createExecutionResult(plan.id, action.id, action.agentId, 'success', clearOutcome.decision))
      );
    } catch (error) {
      persistenceFailed = true;
      persistenceError = error;
    } finally {
      try {
        await lock.release();
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
    }

    if (releaseFailed) {
      const failure = CLEAR_PUBLIC_ERRORS.operationFailed;
      logClearExecutionFailure(req, failure, {
        operation: 'plans.execute.release_lock',
        dependency: 'executionLock',
        error: releaseError,
        errorCaptured: true,
        retryable: true,
      });
    }

    if (persistenceFailed) {
      if (isUniqueConstraintError(persistenceError)) {
        res.status(409).json({ error: 'Actions already executed (replay protection)' });
        return;
      }
      const failure = CLEAR_PUBLIC_ERRORS.persistenceFailed;
      logClearExecutionFailure(req, failure, {
        operation: 'plans.execute.persist_results',
        dependency: 'actionPlanStore',
        error: persistenceError,
        errorCaptured: true,
        retryable: true,
      });
      sendClearFailure(res, failure);
      return;
    }

    if (releaseFailed) {
      const failure = CLEAR_PUBLIC_ERRORS.operationFailed;
      sendClearFailure(res, failure);
      return;
    }

    res.json({ plan_id: plan.id, status: 'executed', results });
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      res.status(409).json({ error: 'Actions already executed (replay protection)' });
      return;
    }
    const failure = CLEAR_PUBLIC_ERRORS.operationFailed;
    logClearExecutionFailure(req, failure, {
      operation: 'plans.execute',
      dependency: 'operation',
      error,
      errorCaptured: true,
      retryable: false,
    });
    sendClearFailure(res, failure);
  }
});

/**
 * GET /plans/:planId/results — Get execution results
 */
router.get('/plans/:planId/results', async (req: Request, res: Response) => {
  try {
    const results = await getExecutionResults(req.params.planId);
    res.json({ plan_id: req.params.planId, results });
  } catch (error: unknown) {
    apiLogger.error('Results failed', { module: 'plans', error: resolveErrorMessage(error) });
    sendInternalErrorCode(res, 'Failed to get execution results');
  }
});

export default router;
