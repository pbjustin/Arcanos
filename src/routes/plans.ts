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
import {
  actionPlanLifecyclePublicCategory,
  classifyActionPlanExpiry,
  evaluateActionPlanLifecycle,
  isActionPlanLifecycleStatus,
  type ActionPlanLifecycleOperation,
  type ActionPlanPolicyProvenance,
  type ActionPlanLifecycleResult,
} from '../services/actionPlanLifecycle.js';

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

function logActionPlanMutationFailure(
  req: Request,
  operation: 'approve' | 'block' | 'expire',
  error: unknown,
): void {
  try {
    apiLogger.error('ActionPlan mutation failed', {
      module: 'plans',
      planId: req.params.planId,
      operation,
      errorCode: 'ACTION_PLAN_OPERATION_FAILED',
      errorClass: safeThrownClass(error),
      requestId: req.requestId ?? 'unknown',
      traceId: req.traceId ?? req.requestId ?? 'unknown',
      retryable: true,
    });
  } catch {
    // Diagnostics must not mask the stable public response.
  }
}

function logLifecycleWriteFailure(
  req: Request,
  planId: string,
  operation: 'approve' | 'block' | 'expire',
  reasonCode: string,
): void {
  try {
    apiLogger.warn('ActionPlan lifecycle write suppressed', {
      module: 'plans',
      planId,
      operation,
      errorCode: 'ACTION_PLAN_STATE_WRITE_FAILED',
      reasonCode,
      requestId: req.requestId ?? 'unknown',
      traceId: req.traceId ?? req.requestId ?? 'unknown',
      retryable: true,
    });
  } catch {
    // Diagnostics must not mask the stable public response.
  }
}

function sendClearFailure(res: Response, failure: ClearPublicError): void {
  res.status(failure.httpStatus).json({ error: failure.code, message: failure.message });
}

function storedPolicyKind(plan: ActionPlanRecord): unknown {
  return plan.clearScore?.decision ?? 'not_evaluated';
}

function evaluateStoredPlanLifecycle(
  plan: ActionPlanRecord,
  operation: ActionPlanLifecycleOperation,
): ActionPlanLifecycleResult {
  return evaluateActionPlanLifecycle({
    operation,
    statusPresent: Object.hasOwn(plan, 'status'),
    status: plan.status,
    policyKind: operation === 'block' || operation === 'expire' ? 'not_evaluated' : storedPolicyKind(plan),
    policyProvenance: operation === 'block' || operation === 'expire' ? 'operator' : 'stored_creation',
    expiry: classifyActionPlanExpiry(plan.expiresAt, Date.now()),
  });
}

function storedPolicyProvenance(
  operation: ActionPlanLifecycleOperation,
): ActionPlanPolicyProvenance {
  return operation === 'block' || operation === 'expire' ? 'operator' : 'stored_creation';
}

function logLifecycleDecision(
  req: Request,
  planId: string,
  operation: ActionPlanLifecycleOperation,
  lifecycle: ActionPlanLifecycleResult,
  status: unknown,
  policyProvenance: ActionPlanPolicyProvenance,
): void {
  const accepted = lifecycle.operationAllowed || lifecycle.policyRecheckAllowed;
  const metadata = {
    module: 'plans',
    planId,
    previousState: isActionPlanLifecycleStatus(status) ? status : null,
    operation,
    targetState: lifecycle.targetStatus,
    outcome: lifecycle.classification,
    reasonCode: lifecycle.reasonCode,
    ...(!accepted ? { category: actionPlanLifecyclePublicCategory(lifecycle) } : {}),
    policyProvenance,
    requestId: req.requestId ?? 'unknown',
    traceId: req.traceId ?? req.requestId ?? 'unknown',
    actorCategory: 'http',
    versionSupport: 'unavailable',
  };
  try {
    if (accepted) {
      apiLogger.info('ActionPlan lifecycle evaluated', metadata);
    } else {
      apiLogger.warn('ActionPlan lifecycle evaluated', metadata);
    }
  } catch {
    // Lifecycle diagnostics must never alter the operation result.
  }
}

function lifecycleFailureMessage(
  operation: ActionPlanLifecycleOperation,
  lifecycle: ActionPlanLifecycleResult,
  status: unknown,
): string {
  if (operation === 'execute' && lifecycle.reasonCode === 'lifecycle_blocked') {
    return 'Cannot execute blocked plan';
  }
  if (operation === 'execute' && lifecycle.reasonCode === 'stored_policy_conflict') {
    return 'Cannot execute blocked plan';
  }
  if (operation === 'execute'
    && (lifecycle.reasonCode === 'approval_required'
      || lifecycle.reasonCode === 'durable_approval_required')) {
    return isActionPlanLifecycleStatus(status)
      ? `Plan must be approved before execution, current status: ${status}`
      : 'Plan must be approved before execution';
  }
  if (operation === 'approve' && lifecycle.classification === 'policy_blocked') {
    return 'Cannot approve blocked plan';
  }
  if (lifecycle.classification === 'terminal') {
    return `Cannot ${operation} a terminal plan`;
  }
  if (lifecycle.classification === 'unavailable') {
    return 'ActionPlan lifecycle state is unavailable';
  }
  if (lifecycle.classification === 'invalid') {
    return 'ActionPlan lifecycle state is invalid';
  }
  return isActionPlanLifecycleStatus(status)
    ? `Cannot ${operation} plan in ${status} status`
    : `Cannot ${operation} plan in its current status`;
}

function sendLifecycleFailure(
  req: Request,
  res: Response,
  planId: string,
  operation: ActionPlanLifecycleOperation,
  lifecycle: ActionPlanLifecycleResult,
  status: unknown,
  policyProvenance: ActionPlanPolicyProvenance,
): void {
  logLifecycleDecision(req, planId, operation, lifecycle, status, policyProvenance);
  const category = actionPlanLifecyclePublicCategory(lifecycle);
  const httpStatus = category === 'ACTION_PLAN_POLICY_BLOCKED'
    || lifecycle.reasonCode === 'stored_policy_conflict'
    ? 403
    : 409;
  res.status(httpStatus).json({
    error: lifecycleFailureMessage(operation, lifecycle, status),
    category,
    reasonCode: lifecycle.reasonCode,
    ...(isActionPlanLifecycleStatus(status) ? { currentStatus: status } : {}),
  });
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
    const existing = await getPlan(req.params.planId);
    if (!existing) {
      sendNotFound(res, 'Plan not found');
      return;
    }

    const lifecycle = evaluateStoredPlanLifecycle(existing, 'approve');
    if (!lifecycle.operationAllowed || !lifecycle.statusTransitionAllowed) {
      sendLifecycleFailure(
        req,
        res,
        existing.id,
        'approve',
        lifecycle,
        existing.status,
        storedPolicyProvenance('approve'),
      );
      return;
    }
    logLifecycleDecision(
      req,
      existing.id,
      'approve',
      lifecycle,
      existing.status,
      storedPolicyProvenance('approve'),
    );

    const plan = await approvePlan(req.params.planId);
    if (!plan) {
      logLifecycleWriteFailure(req, existing.id, 'approve', 'state_changed_before_write');
      res.status(409).json({
        error: 'ActionPlan state changed before approval',
        category: 'ACTION_PLAN_TRANSITION_FORBIDDEN',
        reasonCode: 'state_changed_before_write',
      });
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    logActionPlanMutationFailure(req, 'approve', error);
    sendInternalErrorCode(res, 'Failed to approve plan');
  }
});

/**
 * POST /plans/:planId/block — Block a plan
 */
router.post('/plans/:planId/block', async (req: Request, res: Response) => {
  try {
    const existing = await getPlan(req.params.planId);
    if (!existing) {
      sendNotFound(res, 'Plan not found');
      return;
    }

    const lifecycle = evaluateStoredPlanLifecycle(existing, 'block');
    if (!lifecycle.operationAllowed) {
      sendLifecycleFailure(
        req,
        res,
        existing.id,
        'block',
        lifecycle,
        existing.status,
        storedPolicyProvenance('block'),
      );
      return;
    }
    logLifecycleDecision(
      req,
      existing.id,
      'block',
      lifecycle,
      existing.status,
      storedPolicyProvenance('block'),
    );
    if (!lifecycle.statusTransitionAllowed) {
      res.json(existing);
      return;
    }

    const plan = await blockPlan(req.params.planId);
    if (!plan) {
      logLifecycleWriteFailure(req, existing.id, 'block', 'missing_write_result');
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    logActionPlanMutationFailure(req, 'block', error);
    sendInternalErrorCode(res, 'Failed to block plan');
  }
});

/**
 * POST /plans/:planId/expire — Expire a plan
 */
router.post('/plans/:planId/expire', async (req: Request, res: Response) => {
  try {
    const existing = await getPlan(req.params.planId);
    if (!existing) {
      sendNotFound(res, 'Plan not found');
      return;
    }

    const lifecycle = evaluateStoredPlanLifecycle(existing, 'expire');
    if (!lifecycle.operationAllowed) {
      sendLifecycleFailure(
        req,
        res,
        existing.id,
        'expire',
        lifecycle,
        existing.status,
        storedPolicyProvenance('expire'),
      );
      return;
    }
    logLifecycleDecision(
      req,
      existing.id,
      'expire',
      lifecycle,
      existing.status,
      storedPolicyProvenance('expire'),
    );
    if (!lifecycle.statusTransitionAllowed) {
      res.json(existing);
      return;
    }

    const plan = await expirePlan(req.params.planId);
    if (!plan) {
      logLifecycleWriteFailure(req, existing.id, 'expire', 'missing_write_result');
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    logActionPlanMutationFailure(req, 'expire', error);
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

    const lifecyclePreflight = evaluateStoredPlanLifecycle(plan, 'execute');
    if (!lifecyclePreflight.policyRecheckAllowed) {
      sendLifecycleFailure(
        req,
        res,
        plan.id,
        'execute',
        lifecyclePreflight,
        plan.status,
        storedPolicyProvenance('execute'),
      );
      return;
    }
    logLifecycleDecision(
      req,
      plan.id,
      'execute',
      lifecyclePreflight,
      plan.status,
      storedPolicyProvenance('execute'),
    );

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

    const currentLifecycle = evaluateActionPlanLifecycle({
      operation: clearOutcome.kind === 'block' ? 'block' : 'execute',
      statusPresent: Object.hasOwn(plan, 'status'),
      status: plan.status,
      policyKind: clearOutcome.decision,
      policyProvenance: 'current_recheck',
      expiry: classifyActionPlanExpiry(plan.expiresAt, Date.now()),
    });

    if (clearOutcome.kind === 'block') {
      if (!currentLifecycle.operationAllowed || !currentLifecycle.statusTransitionAllowed) {
        sendLifecycleFailure(
          req,
          res,
          plan.id,
          'block',
          currentLifecycle,
          plan.status,
          'current_recheck',
        );
        return;
      }
      logLifecycleDecision(
        req,
        plan.id,
        'block',
        currentLifecycle,
        plan.status,
        'current_recheck',
      );
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
      res.status(403).json({
        error: 'CLEAR re-evaluation blocked this plan',
        clearScore: clearRecheck,
      });
      return;
    }

    if (!currentLifecycle.operationAllowed) {
      sendLifecycleFailure(
        req,
        res,
        plan.id,
        'execute',
        currentLifecycle,
        plan.status,
        'current_recheck',
      );
      return;
    }
    logLifecycleDecision(
      req,
      plan.id,
      'execute',
      currentLifecycle,
      plan.status,
      'current_recheck',
    );

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
