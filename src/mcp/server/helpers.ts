import type { McpRequestContext } from '../context.js';
import { MCP_FLAGS } from '../registry.js';
import { mcpError } from '../errors.js';
import { issueConfirmationNonce, verifyAndConsumeNonce } from '../confirm.js';
import type { ActionPlanRecord } from '@shared/types/actionPlan.js';
import { validateCapability } from '@stores/agentRegistry.js';

const MCP_OPERATION_ERROR = Object.freeze({
  category: 'MCP_OPERATION_FAILED',
  message: 'MCP operation failed.',
});

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

function logBestEffort(
  ctx: McpRequestContext,
  level: 'info' | 'error',
  event: string,
  metadata: Record<string, unknown>,
): void {
  try {
    ctx.logger[level](event, metadata);
  } catch {
    // Diagnostics must not change tool behavior or error presentation.
  }
}

export function sessionKey(ctx: McpRequestContext, args: any): string {
  // Prefer explicit session passed by the client; fall back to context; then requestId
  return String(args?.sessionId ?? ctx.sessionId ?? ctx.requestId);
}
export function stripConfirmationFields(args: any) {
  if (!args || typeof args !== 'object') return args;
  const { confirmationNonce, confirmed, ...rest } = args as any;
  return rest;
}
export function requireNonceOrIssue(args: any, toolName: string, ctx: McpRequestContext, bindTo: unknown) {
  if (!MCP_FLAGS.requireConfirmation) return { ok: true as const };

  const key = sessionKey(ctx, args);
  const nonce = args?.confirmationNonce ?? null;

  const verify = verifyAndConsumeNonce({ tool: toolName, sessionKey: key, payloadToBind: bindTo, nonce });
  if (verify.ok) return { ok: true as const };

  // Missing or invalid -> issue new nonce
  const issued = issueConfirmationNonce({ tool: toolName, sessionKey: key, payloadToBind: bindTo });

  const code = verify.reason === 'missing' ? 'ERR_CONFIRM_REQUIRED' : 'ERR_CONFIRM_INVALID';
  return {
    ok: false as const,
    error: mcpError({
      code,
      message:
        verify.reason === 'missing'
          ? `Confirmation required for tool '${toolName}'. Re-run with { confirmationNonce: "${issued.nonce}" } within ${Math.round(
              issued.expiresInMs / 1000
            )}s.`
          : `Invalid/expired confirmation for tool '${toolName}'. Re-run with { confirmationNonce: "${issued.nonce}" } within ${Math.round(
              issued.expiresInMs / 1000
            )}s.`,
      details: { tool: toolName, confirmationNonce: issued.nonce, expiresInMs: issued.expiresInMs },
      requestId: ctx.requestId,
    }),
  };
}
export function notExposed(toolName: string, ctx: McpRequestContext) {
  return mcpError({
    code: 'ERR_DISABLED',
    message: `Tool '${toolName}' is disabled on this deployment (MCP_EXPOSE_DESTRUCTIVE=false).`,
    details: { tool: toolName },
    requestId: ctx.requestId,
  });
}

export function buildClearRecheckInput(plan: ActionPlanRecord) {
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

export function wrapTool(toolName: string, ctx: McpRequestContext, handler: (args: any) => Promise<any>) {
  return async (args: any) => {
    const start = Date.now();
    logBestEffort(ctx, 'info', 'mcp.tool.start', { tool: toolName });

    try {
      const out = await handler(args);
      const durationMs = Date.now() - start;
      logBestEffort(ctx, 'info', 'mcp.tool.end', {
        tool: toolName,
        durationMs,
        isError: Boolean(out?.isError),
      });
      return out;
    } catch (err) {
      const durationMs = Date.now() - start;
      logBestEffort(ctx, 'error', 'mcp.tool.error', {
        tool: toolName,
        durationMs,
        errorCode: MCP_OPERATION_ERROR.category,
        errorClass: safeThrownClass(err),
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        retryable: false,
      });

      return mcpError({
        code: 'ERR_INTERNAL',
        message: MCP_OPERATION_ERROR.message,
        details: { tool: toolName, category: MCP_OPERATION_ERROR.category },
        requestId: ctx.requestId,
      });
    }
  };
}
