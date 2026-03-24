import type { McpRequestContext } from '../context.js';
import { MCP_FLAGS } from '../registry.js';
import { mcpError } from '../errors.js';
import { issueConfirmationNonce, verifyAndConsumeNonce } from '../confirm.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import type { ActionPlanRecord } from '@shared/types/actionPlan.js';
import { validateCapability } from '@stores/agentRegistry.js';

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
    ctx.logger.info('mcp.tool.start', { tool: toolName });

    try {
      const out = await handler(args);
      const durationMs = Date.now() - start;
      ctx.logger.info('mcp.tool.end', {
        tool: toolName,
        durationMs,
        isError: Boolean(out?.isError),
      });
      return out;
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = resolveErrorMessage(err);
      ctx.logger.error('mcp.tool.error', { tool: toolName, durationMs, message });

      return mcpError({
        code: 'ERR_INTERNAL',
        message,
        details: { tool: toolName },
        requestId: ctx.requestId,
      });
    }
  };
}
