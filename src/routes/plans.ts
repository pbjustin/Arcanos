import { sendNotFound, sendInternalErrorCode } from '@shared/http/index.js';
/**
 * ActionPlan API Routes
 *
 * POST   /plans                  — Create plan, compute CLEAR, return plan+score
 * GET    /plans/:planId          — Get plan by ID with CLEAR score
 * POST   /plans/:planId/approve  — Approve plan (only if CLEAR allows/confirms)
 * POST   /plans/:planId/block    — Block plan
 * POST   /plans/:planId/expire   — Expire plan
 * POST   /plans/:planId/execute  — Create authoritative per-action execution runs
 * GET    /plans/:planId/results  — Reject legacy result reads in favor of run results
 */

import express, { Request, Response } from 'express';
import { z } from 'zod';
import {
  PLAN_CREATORS,
  PLAN_STATUSES,
  executionResultInputSchema,
  phase2eActionPlanInputSchema,
} from '@shared/types/actionPlan.js';
import {
  actionPlanExecutionCommandInputSchema,
  actionPlanExecutionResultInputSchema,
} from '@shared/types/actionPlanExecution.js';
import {
  createPlan,
  getAuthoritativePlan,
  listAuthoritativePlans,
  updateAuthoritativePlanStatus,
} from '../stores/actionPlanStore.js';
import { buildClear2Summary } from '../services/clear2.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import type { ActionPlanRecord } from '@shared/types/actionPlan.js';
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
  readActionPlanIdempotencyKey,
  actionPlanRateLimitOperation,
  sendActionPlanExecutionError,
  setActionPlanNoStore,
} from '@services/actionPlanExecution/http.js';
import { createActionPlanExecutionService } from '@services/actionPlanExecution/service.js';
import {
  ACTION_PLAN_EXECUTION_ERRORS,
  ActionPlanExecutionError,
} from '@services/actionPlanExecution/errors.js';

const router = express.Router();
const planIdParamsSchema = z.object({ planId: z.string().min(1).max(128) }).strict();
const emptyMutationBodySchema = z.object({}).strict();
const strictLegacyExecutionResultInputSchema = executionResultInputSchema.strict();
const listPlansQuerySchema = z.object({
  status: z.enum(PLAN_STATUSES).optional(),
  created_by: z.enum(PLAN_CREATORS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

function assertBoundaryInput(schema: z.ZodType, value: unknown): void {
  if (!schema.safeParse(value).success) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
  }
}
const actionPlanClientRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-http-client',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}`,
});
const actionPlanCredentialRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-http-credential',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}:${getRequestActorKey(req)}`,
});
const actionPlanPrincipalRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-http-principal',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `principal:${req.actionPlanPrincipal!.role}:${req.actionPlanPrincipal!.principalId}:operation:${actionPlanRateLimitOperation(req)}`,
});

router.use('/plans', (_req, res, next) => {
  setActionPlanNoStore(res);
  next();
}, actionPlanClientRateLimit, actionPlanCredentialRateLimit, actionPlanAuthenticationMiddleware, actionPlanPrincipalRateLimit);

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

function sendKnownActionPlanExecutionFailure(
  req: Request,
  res: Response,
  error: unknown,
): boolean {
  if (!(error instanceof ActionPlanExecutionError)) return false;
  sendActionPlanExecutionError(res, error, {
    requestId: req.requestId,
    traceId: req.traceId,
  });
  return true;
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

function requireExecutionRealm(): string {
  const realm = deriveActionPlanExecutionRealm();
  if (!realm) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.realmUnavailable);
  return realm;
}

function planVisibleToPrincipal(req: Request, plan: ActionPlanRecord): ActionPlanRecord {
  if (req.actionPlanPrincipal?.role !== 'requester') return plan;
  const { executionResults: _legacyExecutionResults, ...visible } = plan;
  return visible as ActionPlanRecord;
}

async function getVisibleAuthoritativePlan(req: Request): Promise<ActionPlanRecord | null> {
  const plan = await getAuthoritativePlan(req.params.planId);
  if (!plan) return null;
  const realm = requireExecutionRealm();
  const principal = req.actionPlanPrincipal!;
  if (plan.executionRealm !== realm) return null;
  if (principal.role === 'requester' && plan.ownerPrincipalId !== principal.principalId) return null;
  if (principal.role !== 'requester' && principal.role !== 'operator') return null;
  return planVisibleToPrincipal(req, plan);
}

/**
 * POST /plans — Create a new ActionPlan
 */
router.post('/plans', requireActionPlanRoles('requester', 'operator'), async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const parsed = phase2eActionPlanInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }

    const plan = await createPlan(parsed.data, {
      executionRealm: requireExecutionRealm(),
      ownerPrincipalId: req.actionPlanPrincipal!.principalId,
      executionProtocolVersion: 2,
      executionGeneration: 1,
    });
    res.status(201).json(planVisibleToPrincipal(req, plan));
  } catch (error: unknown) {
    if (sendKnownActionPlanExecutionFailure(req, res, error)) return;
    // Idempotency key conflict
    if (isUniqueConstraintError(error)) {
      res.status(409).json({ error: 'Plan with this idempotency_key already exists' });
      return;
    }
    apiLogger.error('Create failed', {
      module: 'plans',
      errorCode: 'ACTION_PLAN_CREATE_FAILED',
      errorClass: safeThrownClass(error),
    });
    sendInternalErrorCode(res, 'Failed to create plan');
  }
});

/**
 * GET /plans — List plans with optional filters
 */
router.get('/plans', requireActionPlanRoles('requester', 'operator'), async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const parsedQuery = listPlansQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }
    const { status, created_by: createdBy, limit } = parsedQuery.data;

    const plans = await listAuthoritativePlans({
      executionRealm: requireExecutionRealm(),
      ...(req.actionPlanPrincipal!.role === 'requester'
        ? { ownerPrincipalId: req.actionPlanPrincipal!.principalId }
        : {}),
      status,
      createdBy,
      limit,
    });
    res.json({ plans, count: plans.length });
  } catch (error: unknown) {
    if (sendKnownActionPlanExecutionFailure(req, res, error)) return;
    apiLogger.error('List failed', {
      module: 'plans',
      errorCode: 'ACTION_PLAN_LIST_FAILED',
      errorClass: safeThrownClass(error),
    });
    sendInternalErrorCode(res, 'Failed to list plans');
  }
});

/**
 * GET /plans/:planId — Get plan by ID
 */
router.get('/plans/:planId', requireActionPlanRoles('requester', 'operator'), async (req: Request, res: Response) => {
  try {
    assertBoundaryInput(planIdParamsSchema, req.params);
    const plan = await getVisibleAuthoritativePlan(req);
    if (!plan) {
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    if (sendKnownActionPlanExecutionFailure(req, res, error)) return;
    apiLogger.error('Get failed', {
      module: 'plans',
      errorCode: 'ACTION_PLAN_GET_FAILED',
      errorClass: safeThrownClass(error),
    });
    sendInternalErrorCode(res, 'Failed to get plan');
  }
});

/**
 * POST /plans/:planId/approve — Approve a plan
 */
router.post('/plans/:planId/approve', requireActionPlanRoles('operator'), async (req: Request, res: Response) => {
  try {
    assertBoundaryInput(planIdParamsSchema, req.params);
    assertBoundaryInput(emptyMutationBodySchema, req.body ?? {});
    const existing = await getVisibleAuthoritativePlan(req);
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

    const plan = await updateAuthoritativePlanStatus({
      planId: req.params.planId,
      executionRealm: requireExecutionRealm(),
      status: 'approved',
      allowedCurrentStatuses: ['planned', 'awaiting_confirmation'],
    });
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
    if (sendKnownActionPlanExecutionFailure(req, res, error)) return;
    logActionPlanMutationFailure(req, 'approve', error);
    sendInternalErrorCode(res, 'Failed to approve plan');
  }
});

/**
 * POST /plans/:planId/block — Block a plan
 */
router.post('/plans/:planId/block', requireActionPlanRoles('operator'), async (req: Request, res: Response) => {
  try {
    assertBoundaryInput(planIdParamsSchema, req.params);
    assertBoundaryInput(emptyMutationBodySchema, req.body ?? {});
    const existing = await getVisibleAuthoritativePlan(req);
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

    const plan = await updateAuthoritativePlanStatus({
      planId: req.params.planId,
      executionRealm: requireExecutionRealm(),
      status: 'blocked',
    });
    if (!plan) {
      logLifecycleWriteFailure(req, existing.id, 'block', 'missing_write_result');
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    if (sendKnownActionPlanExecutionFailure(req, res, error)) return;
    logActionPlanMutationFailure(req, 'block', error);
    sendInternalErrorCode(res, 'Failed to block plan');
  }
});

/**
 * POST /plans/:planId/expire — Expire a plan
 */
router.post('/plans/:planId/expire', requireActionPlanRoles('operator'), async (req: Request, res: Response) => {
  try {
    assertBoundaryInput(planIdParamsSchema, req.params);
    assertBoundaryInput(emptyMutationBodySchema, req.body ?? {});
    const existing = await getVisibleAuthoritativePlan(req);
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

    const plan = await updateAuthoritativePlanStatus({
      planId: req.params.planId,
      executionRealm: requireExecutionRealm(),
      status: 'expired',
    });
    if (!plan) {
      logLifecycleWriteFailure(req, existing.id, 'expire', 'missing_write_result');
      sendNotFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    if (sendKnownActionPlanExecutionFailure(req, res, error)) return;
    logActionPlanMutationFailure(req, 'expire', error);
    sendInternalErrorCode(res, 'Failed to expire plan');
  }
});

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
router.post('/plans/:planId/execute', requireActionPlanRoles('requester', 'operator'), async (req: Request, res: Response) => {
  try {
    assertBoundaryInput(planIdParamsSchema, req.params);
    const bodyValue = req.body ?? {};
    const commandBody = actionPlanExecutionCommandInputSchema.safeParse(bodyValue);
    if (!commandBody.success) {
      const resultShaped = actionPlanExecutionResultInputSchema.safeParse(bodyValue).success
        || strictLegacyExecutionResultInputSchema.safeParse(bodyValue).success;
      throw new ActionPlanExecutionError(
        resultShaped
          ? ACTION_PLAN_EXECUTION_ERRORS.resultEndpointRequired
          : ACTION_PLAN_EXECUTION_ERRORS.requestInvalid,
      );
    }

    const idempotencyKey = readActionPlanIdempotencyKey(req);
    const plan = await getVisibleAuthoritativePlan(req);
    if (!plan) {
      sendNotFound(res, 'Plan not found');
      return;
    }

    const executionService = createActionPlanExecutionService();
    const replay = await executionService.replayExecution({
      planId: plan.id,
      actor: req.actionPlanPrincipal!,
      idempotencyKey,
      context: {
        requestId: req.requestId,
        traceId: req.traceId,
        sourceService: 'web',
      },
    });
    if (replay) {
      res.status(202).json(replay);
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
        blockedPlan = await updateAuthoritativePlanStatus({
          planId: plan.id,
          executionRealm: requireExecutionRealm(),
          status: 'blocked',
          allowedCurrentStatuses: [plan.status],
        });
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

    const result = await executionService.requestExecution({
      planId: plan.id,
      actor: req.actionPlanPrincipal!,
      idempotencyKey,
      policyExpectation: {
        decision: clearOutcome.decision as 'allow' | 'confirm',
        overall: clearOutcome.overall,
        planExecutionGeneration: plan.executionGeneration!,
      },
      context: {
        requestId: req.requestId,
        traceId: req.traceId,
        sourceService: 'web',
      },
    });
    res.status(202).json(result);
  } catch (error: unknown) {
    if (error instanceof ActionPlanExecutionError) {
      try {
        apiLogger.warn('ActionPlan execution request rejected', {
          module: 'plans',
          errorCode: error.code,
          errorClass: safeThrownClass(error),
          operation: 'plans.execute',
          requestId: req.requestId ?? 'unknown',
          traceId: req.traceId ?? req.requestId ?? 'unknown',
          retryable: error.retryable,
        });
      } catch {
        // Diagnostics must not mask the stable public response.
      }
      sendActionPlanExecutionError(res, error, {
        requestId: req.requestId,
        traceId: req.traceId,
      });
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
router.get('/plans/:planId/results', requireActionPlanRoles('requester', 'operator'), async (req: Request, res: Response) => {
  if (!planIdParamsSchema.safeParse(req.params).success) {
    sendActionPlanExecutionError(
      res,
      new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid),
      { requestId: req.requestId, traceId: req.traceId },
    );
    return;
  }
  sendActionPlanExecutionError(
    res,
    new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.legacyResultUnavailable),
    { requestId: req.requestId, traceId: req.traceId },
  );
});

export default router;
