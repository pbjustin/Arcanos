import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';
import type { Request } from 'express';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { createRuntimeBudget, type RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { generateRequestId } from '@core/lib/requestId.js';
import { createMcpLogger, type McpLogger } from './log.js';

export interface McpRequestContext {
  requestId: string;
  openai: OpenAI;
  runtimeBudget: RuntimeBudget;
  sessionId?: string;
  req: Request;
  logger: McpLogger;
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

  const requestId = generateRequestId('mcp');
  const logger = createMcpLogger({ requestId, sessionId, transport: 'http' });

  return {
    requestId,
    openai: client,
    runtimeBudget: createRuntimeBudget(),
    sessionId,
    req,
    logger,
  };
}

/**
 * Build context for stdio-based MCP (no Express Request available).
 */
export function buildMcpStdioContext(sessionId?: string): McpRequestContext {
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error('OpenAI client unavailable (adapter not initialized)');
  }

  const requestId = generateRequestId('mcp');
  const logger = createMcpLogger({ requestId, sessionId, transport: 'stdio' });

  return {
    requestId,
    openai: client,
    runtimeBudget: createRuntimeBudget(),
    sessionId,
    // No HTTP request in stdio transport; keep as empty object.
    req: {} as any,
    logger,
  };
}
