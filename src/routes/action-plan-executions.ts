import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import {
  actionPlanExecutionClaimInputSchema,
  actionPlanExecutionCommandInputSchema,
  actionPlanExecutionResultInputSchema,
  actionPlanExecutionStartInputSchema,
  type ActionPlanExecutionResultInput,
} from '@shared/types/actionPlanExecution.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  getRequestClientAddress,
} from '@platform/runtime/security.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import {
  actionPlanAuthenticationMiddleware,
  requireActionPlanRoles,
} from '@services/actionPlanExecution/auth.js';
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
  isActionPlanExecutionError,
} from '@services/actionPlanExecution/errors.js';
import type { CanonicalJsonValue } from '@services/actionPlanExecution/canonical.js';

const router = express.Router();
const executionParamsSchema = z.object({
  planId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
}).strict();

const executionClientRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-execution-client',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}`,
});
const executionCredentialRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-execution-credential',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}:${getRequestActorKey(req)}`,
});
const executionPrincipalRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-execution-principal',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `principal:${req.actionPlanPrincipal!.role}:${req.actionPlanPrincipal!.principalId}:operation:${actionPlanRateLimitOperation(req)}`,
});

router.use(['/action-plan-executions', '/plans/:planId/executions'], (_req, res, next) => {
  setActionPlanNoStore(res);
  next();
}, executionClientRateLimit, executionCredentialRateLimit, actionPlanAuthenticationMiddleware, executionPrincipalRateLimit);

function operationContext(req: Request) {
  return {
    requestId: req.requestId,
    traceId: req.traceId,
    sourceService: 'web' as const,
  };
}

function safeThrownClass(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof Error) return 'Error';
  return 'ThrownValue';
}

function logProtocolFailure(req: Request, operation: string, error: unknown): void {
  try {
    apiLogger.warn('ActionPlan execution protocol operation rejected', {
      module: 'action-plan-executions',
      operation,
      errorCode: isActionPlanExecutionError(error)
        ? error.code
        : 'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED',
      errorClass: safeThrownClass(error),
      principalId: req.actionPlanPrincipal?.principalId ?? null,
      actorCategory: req.actionPlanPrincipal?.role ?? null,
      requestId: req.requestId ?? 'unknown',
      traceId: req.traceId ?? req.requestId ?? 'unknown',
    });
  } catch {
    // Diagnostics cannot replace the stable protocol response.
  }
}

async function handle(
  req: Request,
  res: Response,
  operation: string,
  callback: () => Promise<unknown>,
  successStatus = 200,
): Promise<void> {
  try {
    const payload = await callback();
    if (payload === null) {
      res.status(204).end();
      return;
    }
    res.status(successStatus).json(payload);
  } catch (error) {
    logProtocolFailure(req, operation, error);
    sendActionPlanExecutionError(res, error, {
      requestId: req.requestId,
      traceId: req.traceId,
    });
  }
}

router.get(
  '/action-plan-executions/protocol',
  requireActionPlanRoles('requester', 'operator', 'executor'),
  (req, res) => handle(req, res, 'protocol', async () => {
    return createActionPlanExecutionService().capability(req.actionPlanPrincipal!);
  }),
);

router.post(
  '/action-plan-executions/claim-next',
  requireActionPlanRoles('executor'),
  (req, res) => handle(req, res, 'claim-next', async () => {
    const body = actionPlanExecutionClaimInputSchema.safeParse(req.body ?? {});
    if (!body.success) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    return createActionPlanExecutionService().claimExecution({
      actor: req.actionPlanPrincipal!,
      idempotencyKey: readActionPlanIdempotencyKey(req),
      context: operationContext(req),
    });
  }),
);

router.post(
  '/plans/:planId/executions/:runId/claim',
  requireActionPlanRoles('executor'),
  (req, res) => handle(req, res, 'claim', async () => {
    const params = executionParamsSchema.safeParse(req.params);
    const body = actionPlanExecutionClaimInputSchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }
    return createActionPlanExecutionService().claimExecution({
      planId: params.data.planId,
      runId: params.data.runId,
      actor: req.actionPlanPrincipal!,
      idempotencyKey: readActionPlanIdempotencyKey(req),
      context: operationContext(req),
    });
  }),
);

router.post(
  '/plans/:planId/executions/:runId/start',
  requireActionPlanRoles('executor'),
  (req, res) => handle(req, res, 'start', async () => {
    const params = executionParamsSchema.safeParse(req.params);
    const body = actionPlanExecutionStartInputSchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }
    return createActionPlanExecutionService().startExecution({
      ...params.data,
      actor: req.actionPlanPrincipal!,
      idempotencyKey: readActionPlanIdempotencyKey(req),
      context: operationContext(req),
    });
  }),
);

router.post(
  '/plans/:planId/executions/:runId/result',
  requireActionPlanRoles('executor'),
  (req, res) => handle(req, res, 'submit-result', async () => {
    const params = executionParamsSchema.safeParse(req.params);
    const body = actionPlanExecutionResultInputSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }
    const result = body.data as ActionPlanExecutionResultInput;
    return createActionPlanExecutionService().submitResult({
      planId: params.data.planId,
      runId: params.data.runId,
      actionId: result.action_id,
      snapshotId: result.snapshot_id,
      actor: req.actionPlanPrincipal!,
      idempotencyKey: readActionPlanIdempotencyKey(req),
      outcome: result.outcome,
      ...(result.output === undefined ? {} : { output: result.output as CanonicalJsonValue }),
      ...(result.error === undefined ? {} : { error: result.error as CanonicalJsonValue }),
      context: operationContext(req),
    });
  }),
);

router.get(
  '/plans/:planId/executions/:runId',
  requireActionPlanRoles('requester', 'operator', 'executor'),
  (req, res) => handle(req, res, 'read-status', async () => {
    const params = executionParamsSchema.safeParse(req.params);
    if (!params.success) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    return createActionPlanExecutionService().readStatus({
      ...params.data,
      actor: req.actionPlanPrincipal!,
    });
  }),
);

router.get(
  '/plans/:planId/executions/:runId/result',
  requireActionPlanRoles('requester', 'operator', 'executor'),
  (req, res) => handle(req, res, 'read-result', async () => {
    const params = executionParamsSchema.safeParse(req.params);
    if (!params.success) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    return createActionPlanExecutionService().readResult({
      ...params.data,
      actor: req.actionPlanPrincipal!,
    });
  }),
);

export default router;

export { actionPlanExecutionCommandInputSchema };
