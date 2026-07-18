import { z } from 'zod';

import type { McpRequestContext } from '../context.js';
import { MCP_FLAGS } from '../registry.js';
import { mcpError, mcpText } from '../errors.js';
import { requireNonceOrIssue, stripConfirmationFields, wrapTool } from './helpers.js';
import {
  PLAN_STATUSES,
  phase2eActionPlanInputSchema,
  type ActionPlanRecord,
} from '@shared/types/actionPlan.js';
import * as actionPlanStore from '@stores/actionPlanStore.js';
import { buildClear2Summary } from '@services/clear2.js';
import {
  CLEAR_PUBLIC_ERRORS,
  interpretClear2Outcome,
} from '@services/clearDecision.js';
import {
  actionPlanLifecyclePublicCategory,
  classifyActionPlanExpiry,
  evaluateActionPlanLifecycle,
} from '@services/actionPlanLifecycle.js';
import { deriveActionPlanExecutionRealm } from '@services/actionPlanExecution/realm.js';
import { createActionPlanExecutionService } from '@services/actionPlanExecution/service.js';
import {
  ACTION_PLAN_EXECUTION_ERRORS,
  ActionPlanExecutionError,
  isActionPlanExecutionError,
} from '@services/actionPlanExecution/errors.js';

type AnyMcpServer = any;

const SAFE_ACTION_PLAN_MCP_TOOLS = new Set([
  'plans.create',
  'plans.list',
  'plans.get',
  'plans.execute',
  'plans.get_execution',
  'plans.get_execution_result',
]);

const planIdSchema = z.string().min(1).max(128);
const runIdSchema = z.string().min(1).max(128);
const idempotencyKeySchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u);

function safeThrownClass(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof Error) return 'Error';
  return 'ThrownValue';
}

function logActionPlanMcpFailure(
  ctx: McpRequestContext,
  tool: string,
  category: string,
  error?: unknown,
): void {
  try {
    ctx.logger.warn('mcp.action_plan.rejected', {
      tool,
      errorCode: category,
      ...(error === undefined ? {} : { errorClass: safeThrownClass(error) }),
      principalId: ctx.actionPlanPrincipal?.principalId ?? null,
      actorCategory: ctx.actionPlanPrincipal?.role ?? null,
      requestId: ctx.requestId,
      traceId: ctx.traceId,
    });
  } catch {
    // Diagnostics must not alter the fixed MCP response.
  }
}

function executionMcpFailure(ctx: McpRequestContext, tool: string, error: unknown) {
  const publicError = error instanceof z.ZodError
    ? new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid)
    : isActionPlanExecutionError(error)
    ? error
    : new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed);
  logActionPlanMcpFailure(ctx, tool, publicError.code, error);
  return mcpError({
    code: publicError.httpStatus === 404
      ? 'ERR_NOT_FOUND'
      : publicError.httpStatus === 400
        ? 'ERR_BAD_REQUEST'
        : publicError.httpStatus >= 500
          ? 'ERR_INTERNAL'
          : 'ERR_GATED',
    message: publicError.message,
    details: { tool, category: publicError.code },
    requestId: ctx.requestId,
  });
}

function fixedMcpFailure(
  ctx: McpRequestContext,
  tool: string,
  category: string,
  message: string,
  code: 'ERR_GATED' | 'ERR_NOT_FOUND' | 'ERR_INTERNAL' = 'ERR_GATED',
) {
  logActionPlanMcpFailure(ctx, tool, category);
  return mcpError({
    code,
    message,
    details: { tool, category },
    requestId: ctx.requestId,
  });
}

function requireRequester(ctx: McpRequestContext) {
  const principal = ctx.actionPlanPrincipal;
  if (ctx.transport !== 'http' || principal?.role !== 'requester') {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.protocolDisabled);
  }
  return principal;
}

function requireRealm(): string {
  const realm = deriveActionPlanExecutionRealm();
  if (!realm) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.realmUnavailable);
  return realm;
}

async function getVisiblePlan(ctx: McpRequestContext, planId: string): Promise<ActionPlanRecord | null> {
  const principal = requireRequester(ctx);
  const realm = requireRealm();
  const plan = await actionPlanStore.getAuthoritativePlan(planId);
  return plan?.executionRealm === realm && plan.ownerPrincipalId === principal.principalId
    ? plan
    : null;
}

function requesterPlanView(plan: ActionPlanRecord): Omit<ActionPlanRecord, 'executionResults'> {
  const { executionResults: _legacyExecutionResults, ...visible } = plan;
  return visible;
}

function storedPolicyKind(plan: ActionPlanRecord): unknown {
  return plan.clearScore?.decision ?? 'not_evaluated';
}

function buildClearRecheckInput(plan: ActionPlanRecord) {
  return {
    actions: plan.actions.map(action => ({
      action_id: action.id,
      agent_id: action.agentId,
      capability: action.capability,
      params: action.params as Record<string, unknown>,
      timeout_ms: action.timeoutMs,
    })),
    origin: plan.origin,
    confidence: plan.confidence,
    hasRollbacks: plan.actions.some(action => action.rollbackAction != null),
    capabilitiesKnown: true,
    agentsRegistered: true,
  };
}

function lifecycleFailure(
  ctx: McpRequestContext,
  tool: string,
  lifecycle: ReturnType<typeof evaluateActionPlanLifecycle>,
  plan: ActionPlanRecord,
  policyProvenance: 'stored_creation' | 'current_recheck',
) {
  const category = actionPlanLifecyclePublicCategory(lifecycle);
  try {
    ctx.logger.warn('mcp.action_plan.lifecycle', {
      planId: plan.id,
      previousState: PLAN_STATUSES.includes(plan.status) ? plan.status : null,
      operation: 'execute',
      outcome: lifecycle.classification,
      reasonCode: lifecycle.reasonCode,
      category,
      policyProvenance,
      actorCategory: 'mcp',
      versionSupport: 'unavailable',
      requestId: ctx.requestId,
      traceId: ctx.traceId,
    });
  } catch {
    // Diagnostics must not alter the stable lifecycle response.
  }
  return mcpError({
    code: 'ERR_GATED',
    message: 'ActionPlan state does not permit this operation.',
    details: { tool, category, reasonCode: lifecycle.reasonCode },
    requestId: ctx.requestId,
  });
}

/**
 * Hide every legacy ActionPlan and Agent registration. Safe Phase 2E tools are
 * registered separately against the underlying request-scoped server.
 */
export function createLegacyActionPlanMcpRegistrationBoundary(server: AnyMcpServer): AnyMcpServer {
  return new Proxy(server, {
    get(target, property) {
      if (property === 'registerTool') {
        return (name: string, ...args: unknown[]) => {
          if (name.startsWith('plans.') || name.startsWith('agents.')) return undefined;
          return target.registerTool(name, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function registerActionPlanMcpTools(server: AnyMcpServer, ctx: McpRequestContext): void {
  if (ctx.transport !== 'http' || ctx.actionPlanPrincipal?.role !== 'requester') return;

  server.registerTool(
    'plans.create',
    {
      title: 'Create Plan',
      description: 'Creates a requester-owned ActionPlan in the authenticated execution realm.',
      annotations: { readOnlyHint: false },
      inputSchema: phase2eActionPlanInputSchema,
    },
    wrapTool('plans.create', ctx, async (args: unknown) => {
      try {
        const input = phase2eActionPlanInputSchema.parse(args);
        const principal = requireRequester(ctx);
        const plan = await actionPlanStore.createPlan(input, {
          executionRealm: requireRealm(),
          ownerPrincipalId: principal.principalId,
          executionProtocolVersion: 2,
          executionGeneration: 1,
        });
        return mcpText(requesterPlanView(plan));
      } catch (error) {
        return executionMcpFailure(ctx, 'plans.create', error);
      }
    }),
  );

  server.registerTool(
    'plans.list',
    {
      title: 'List Plans',
      description: 'Lists durable ActionPlans owned by the authenticated requester.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        status: z.enum(PLAN_STATUSES).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }).strict(),
    },
    wrapTool('plans.list', ctx, async (args: unknown) => {
      try {
        const input = z.object({
          status: z.enum(PLAN_STATUSES).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }).strict().parse(args);
        const principal = requireRequester(ctx);
        const plans = await actionPlanStore.listAuthoritativePlans({
          executionRealm: requireRealm(),
          ownerPrincipalId: principal.principalId,
          status: input.status,
          limit: input.limit,
        });
        return mcpText(plans.map(requesterPlanView));
      } catch (error) {
        return executionMcpFailure(ctx, 'plans.list', error);
      }
    }),
  );

  server.registerTool(
    'plans.get',
    {
      title: 'Get Plan',
      description: 'Gets a durable ActionPlan owned by the authenticated requester.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ planId: planIdSchema }).strict(),
    },
    wrapTool('plans.get', ctx, async (args: unknown) => {
      try {
        const input = z.object({ planId: planIdSchema }).strict().parse(args);
        const plan = await getVisiblePlan(ctx, input.planId);
        if (!plan) {
          return fixedMcpFailure(ctx, 'plans.get', 'ACTION_PLAN_EXECUTION_NOT_FOUND', 'ActionPlan was not found.', 'ERR_NOT_FOUND');
        }
        return mcpText(requesterPlanView(plan));
      } catch (error) {
        return executionMcpFailure(ctx, 'plans.get', error);
      }
    }),
  );

  server.registerTool(
    'plans.execute',
    {
      title: 'Request Plan Execution',
      description: 'Creates action-level execution runs; it never accepts or fabricates results.',
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        planId: planIdSchema,
        idempotencyKey: idempotencyKeySchema,
        sessionId: z.string().min(1).max(256).optional(),
        confirmationNonce: z.string().min(1).max(512).optional(),
      }).strict(),
    },
    wrapTool('plans.execute', ctx, async (args: unknown) => {
      if (!MCP_FLAGS.exposeDestructive) {
        return fixedMcpFailure(ctx, 'plans.execute', 'ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED', 'ActionPlan execution protocol is unavailable.');
      }
      const parsed = z.object({
        planId: planIdSchema,
        idempotencyKey: idempotencyKeySchema,
        sessionId: z.string().min(1).max(256).optional(),
        confirmationNonce: z.string().min(1).max(512).optional(),
      }).strict().safeParse(args);
      if (!parsed.success) {
        return executionMcpFailure(ctx, 'plans.execute', new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid));
      }
      const input = parsed.data;

      try {
        const principal = requireRequester(ctx);
        const plan = await getVisiblePlan(ctx, input.planId);
        if (!plan) {
          return fixedMcpFailure(ctx, 'plans.execute', 'ACTION_PLAN_EXECUTION_NOT_FOUND', 'ActionPlan was not found.', 'ERR_NOT_FOUND');
        }

        const executionService = createActionPlanExecutionService();
        const replay = await executionService.replayExecution({
          planId: plan.id,
          actor: principal,
          idempotencyKey: input.idempotencyKey,
          context: {
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            sourceService: 'mcp',
          },
        });
        if (replay) return mcpText(replay);

        const gate = requireNonceOrIssue(input, 'plans.execute', ctx, stripConfirmationFields(input));
        if (!gate.ok) return gate.error;

        const preflight = evaluateActionPlanLifecycle({
          operation: 'execute',
          statusPresent: Object.hasOwn(plan, 'status'),
          status: plan.status,
          policyKind: storedPolicyKind(plan),
          policyProvenance: 'stored_creation',
          expiry: classifyActionPlanExpiry(plan.expiresAt, Date.now()),
        });
        if (!preflight.policyRecheckAllowed) {
          return lifecycleFailure(ctx, 'plans.execute', preflight, plan, 'stored_creation');
        }

        let clearRecheck: unknown;
        try {
          clearRecheck = buildClear2Summary(buildClearRecheckInput(plan));
        } catch (error) {
          logActionPlanMcpFailure(ctx, 'plans.execute', CLEAR_PUBLIC_ERRORS.evaluationUnavailable.code, error);
          return fixedMcpFailure(
            ctx,
            'plans.execute',
            CLEAR_PUBLIC_ERRORS.evaluationUnavailable.code,
            CLEAR_PUBLIC_ERRORS.evaluationUnavailable.message,
            'ERR_INTERNAL',
          );
        }

        const outcome = interpretClear2Outcome(clearRecheck);
        if (outcome.kind === 'indeterminate') {
          return fixedMcpFailure(ctx, 'plans.execute', CLEAR_PUBLIC_ERRORS.evaluationUnavailable.code, CLEAR_PUBLIC_ERRORS.evaluationUnavailable.message, 'ERR_INTERNAL');
        }
        if (outcome.kind === 'invalid') {
          return fixedMcpFailure(
            ctx,
            'plans.execute',
            CLEAR_PUBLIC_ERRORS.resultInvalid.code,
            CLEAR_PUBLIC_ERRORS.resultInvalid.message,
            'ERR_INTERNAL',
          );
        }

        const lifecycle = evaluateActionPlanLifecycle({
          operation: outcome.kind === 'block' ? 'block' : 'execute',
          statusPresent: Object.hasOwn(plan, 'status'),
          status: plan.status,
          policyKind: outcome.decision,
          policyProvenance: 'current_recheck',
          expiry: classifyActionPlanExpiry(plan.expiresAt, Date.now()),
        });

        if (outcome.kind === 'block') {
          if (!lifecycle.operationAllowed || !lifecycle.statusTransitionAllowed) {
            return lifecycleFailure(ctx, 'plans.execute', lifecycle, plan, 'current_recheck');
          }
          let blocked: ActionPlanRecord | null;
          try {
            blocked = await actionPlanStore.updateAuthoritativePlanStatus({
              planId: plan.id,
              executionRealm: requireRealm(),
              status: 'blocked',
              allowedCurrentStatuses: [plan.status],
            });
          } catch (error) {
            logActionPlanMcpFailure(ctx, 'plans.execute', CLEAR_PUBLIC_ERRORS.persistenceFailed.code, error);
            return fixedMcpFailure(
              ctx,
              'plans.execute',
              CLEAR_PUBLIC_ERRORS.persistenceFailed.code,
              CLEAR_PUBLIC_ERRORS.persistenceFailed.message,
              'ERR_INTERNAL',
            );
          }
          if (!blocked) {
            return fixedMcpFailure(ctx, 'plans.execute', CLEAR_PUBLIC_ERRORS.persistenceFailed.code, CLEAR_PUBLIC_ERRORS.persistenceFailed.message, 'ERR_INTERNAL');
          }
          return fixedMcpFailure(ctx, 'plans.execute', 'ACTION_PLAN_POLICY_BLOCKED', 'CLEAR re-evaluation blocked this plan');
        }

        if (!lifecycle.operationAllowed) {
          return lifecycleFailure(ctx, 'plans.execute', lifecycle, plan, 'current_recheck');
        }

        const result = await executionService.requestExecution({
          planId: plan.id,
          actor: principal,
          idempotencyKey: input.idempotencyKey,
          policyExpectation: {
            decision: outcome.decision as 'allow' | 'confirm',
            overall: outcome.overall,
            planExecutionGeneration: plan.executionGeneration!,
          },
          context: {
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            sourceService: 'mcp',
          },
        });
        return mcpText(result);
      } catch (error) {
        return executionMcpFailure(ctx, 'plans.execute', error);
      }
    }),
  );

  const readSchema = z.object({ planId: planIdSchema, runId: runIdSchema }).strict();

  server.registerTool(
    'plans.get_execution',
    {
      title: 'Get Plan Execution',
      description: 'Reads the sanitized status of an owned ActionPlan execution run.',
      annotations: { readOnlyHint: true },
      inputSchema: readSchema,
    },
    wrapTool('plans.get_execution', ctx, async (args: unknown) => {
      try {
        const input = readSchema.parse(args);
        return mcpText(await createActionPlanExecutionService().readStatus({
          ...input,
          actor: requireRequester(ctx),
        }));
      } catch (error) {
        return executionMcpFailure(ctx, 'plans.get_execution', error);
      }
    }),
  );

  server.registerTool(
    'plans.get_execution_result',
    {
      title: 'Get Plan Execution Result',
      description: 'Reads the bounded accepted result of an owned ActionPlan execution run.',
      annotations: { readOnlyHint: true },
      inputSchema: readSchema,
    },
    wrapTool('plans.get_execution_result', ctx, async (args: unknown) => {
      try {
        const input = readSchema.parse(args);
        return mcpText(await createActionPlanExecutionService().readResult({
          ...input,
          actor: requireRequester(ctx),
        }));
      } catch (error) {
        return executionMcpFailure(ctx, 'plans.get_execution_result', error);
      }
    }),
  );
}

export function isSafeActionPlanMcpTool(name: string): boolean {
  return SAFE_ACTION_PLAN_MCP_TOOLS.has(name);
}
