import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';
import type { Request } from 'express';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { createRuntimeBudget, type RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { generateRequestId } from '@core/lib/requestId.js';
import { createMcpLogger, type McpLogger } from './log.js';
import {
  conflictsWithActionPlanCredential,
  resolveActionPlanAuthConfiguration,
  type ActionPlanPrincipal,
} from '@services/actionPlanExecution/auth.js';

export type McpTransportKind = 'http' | 'internal' | 'stdio';

export interface McpRequestContext {
  requestId: string;
  traceId: string;
  openai: OpenAI;
  runtimeBudget: RuntimeBudget;
  sessionId?: string;
  req: Request;
  logger: McpLogger;
  transport: McpTransportKind;
  actionPlanPrincipal?: ActionPlanPrincipal;
}

const mcpRequestContextStorage = new AsyncLocalStorage<McpRequestContext>();

/**
 * Execute a callback inside a request-local MCP context.
 */
export function runWithMcpRequestContext<T>(
  ctx: McpRequestContext,
  callback: () => Promise<T> | T
): Promise<T> | T {
  return mcpRequestContextStorage.run(ctx, callback);
}

/**
 * Create a context proxy that resolves values from AsyncLocalStorage at access-time.
 * This enables a singleton MCP server while still exposing request-specific context to tools.
 */
export function createMcpRequestContextProxy(): McpRequestContext {
  return new Proxy({} as McpRequestContext, {
    get(_target, prop) {
      const activeContext = mcpRequestContextStorage.getStore();
      if (!activeContext) {
        throw new Error('MCP request context unavailable');
      }
      return (activeContext as any)[prop as keyof McpRequestContext];
    },
  });
}

/**
 * Build per-request context for MCP tools.
 * Keeps tool handlers thin and reuses existing runtime budget / request id patterns.
 */
export function buildMcpRequestContext(req: Request): McpRequestContext {
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error('OpenAI client unavailable (adapter not initialized)');
  }

  const sessionId =
    (req.header('mcp-session-id') ?? undefined) ||
    (req.header('x-session-id') ?? undefined) ||
    (typeof (req.body as any)?.sessionId === 'string' ? (req.body as any).sessionId : undefined);

  const requestId = req.requestId ?? generateRequestId('mcp');
  const traceId = req.traceId ?? requestId;
  const logger = createMcpLogger({ requestId, traceId, sessionId, transport: 'http' });
  const actionPlanPrincipalId = readMcpActionPlanRequesterPrincipalId(process.env);

  return {
    requestId,
    traceId,
    openai: client,
    runtimeBudget: createRuntimeBudget(),
    sessionId,
    req,
    logger,
    transport: 'http',
    ...(actionPlanPrincipalId ? {
      actionPlanPrincipal: {
        role: 'requester' as const,
        principalId: actionPlanPrincipalId,
      },
    } : {}),
  };
}

const ACTION_PLAN_MCP_PRINCIPAL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

/** Resolve the fixed requester identity bound to the already-authenticated HTTP MCP bearer. */
export function readMcpActionPlanRequesterPrincipalId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID;
  const mcpCredential = env.MCP_BEARER_TOKEN;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || !ACTION_PLAN_MCP_PRINCIPAL_PATTERN.test(value)
    || typeof mcpCredential !== 'string'
    || mcpCredential.length < 32
    || mcpCredential.length > 4096
    || mcpCredential !== mcpCredential.trim()
  ) {
    return null;
  }

  const actionPlanAuth = resolveActionPlanAuthConfiguration(env);
  if (!actionPlanAuth.valid) return null;
  if (
    actionPlanAuth.principals.some(principal => principal.principalId === value)
    || conflictsWithActionPlanCredential(mcpCredential, env)
  ) {
    return null;
  }
  return value;
}

/**
 * Build context for detached MCP transports that run without an Express Request.
 *
 * Purpose:
 * - Reuse one context constructor for stdio and in-process backend MCP execution.
 *
 * Inputs/outputs:
 * - Input: optional session id plus a transport label for logging.
 * - Output: MCP request context with OpenAI client, runtime budget, and detached logger metadata.
 *
 * Edge case behavior:
 * - Throws when the OpenAI adapter is unavailable because detached transports cannot proceed without it.
 */
function buildDetachedMcpContext(sessionId: string | undefined, transport: 'internal' | 'stdio'): McpRequestContext {
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error('OpenAI client unavailable (adapter not initialized)');
  }

  const requestId = generateRequestId('mcp');
  const traceId = requestId;
  const logger = createMcpLogger({ requestId, traceId, sessionId, transport });

  return {
    requestId,
    traceId,
    openai: client,
    runtimeBudget: createRuntimeBudget(),
    sessionId,
    // No HTTP request in stdio transport; keep as empty object.
    req: {} as any,
    logger,
    transport,
  };
}

/**
 * Build context for stdio-based MCP (no Express Request available).
 *
 * Purpose:
 * - Support desktop MCP clients that communicate over stdio.
 *
 * Inputs/outputs:
 * - Input: optional session identifier supplied by the stdio client.
 * - Output: detached MCP request context tagged with `stdio` transport metadata.
 *
 * Edge case behavior:
 * - Throws when the OpenAI adapter is unavailable.
 */
export function buildMcpStdioContext(sessionId?: string): McpRequestContext {
  return buildDetachedMcpContext(sessionId, 'stdio');
}

/**
 * Build context for in-process backend MCP calls (no Express Request available).
 *
 * Purpose:
 * - Let backend services and workers reuse the ARCANOS MCP registry without routing through HTTP.
 *
 * Inputs/outputs:
 * - Input: optional backend-managed session identifier.
 * - Output: detached MCP request context tagged with `internal` transport metadata.
 *
 * Edge case behavior:
 * - Throws when the OpenAI adapter is unavailable.
 */
export function buildMcpInternalContext(sessionId?: string): McpRequestContext {
  return buildDetachedMcpContext(sessionId, 'internal');
}
