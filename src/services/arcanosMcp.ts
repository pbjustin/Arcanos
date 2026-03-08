import type { Request } from 'express';

import { resolveErrorMessage } from '@core/lib/errors/index.js';

import type { McpRequestContext } from '../mcp/context.js';

type JsonObject = Record<string, unknown>;

export interface ArcanosMcpInvokeOptions {
  toolName: string;
  toolArguments?: JsonObject;
  request?: Request;
  sessionId?: string;
}

export interface ArcanosMcpListToolsOptions {
  request?: Request;
  sessionId?: string;
}

export interface ArcanosMcpToolCallResult extends JsonObject {
  content?: JsonObject[];
  structuredContent?: JsonObject;
  isError?: boolean;
}

export interface ArcanosMcpToolDefinition extends JsonObject {
  name: string;
}

export interface ArcanosMcpToolListResult extends JsonObject {
  tools: ArcanosMcpToolDefinition[];
}

export interface ArcanosMcpService {
  invokeTool: (options: ArcanosMcpInvokeOptions) => Promise<ArcanosMcpToolCallResult>;
  listTools: (options?: ArcanosMcpListToolsOptions) => Promise<ArcanosMcpToolListResult>;
}

type InternalMcpClient = {
  connect: (transport: unknown) => Promise<void>;
  callTool: (params: { name: string; arguments?: JsonObject }) => Promise<ArcanosMcpToolCallResult>;
  listTools: (params?: JsonObject) => Promise<ArcanosMcpToolListResult>;
  close: () => Promise<void>;
};

type InternalMcpServer = {
  connect: (transport: unknown) => Promise<void>;
  close?: () => Promise<void>;
};

type InternalMcpTransport = {
  close?: () => Promise<void>;
};

type InternalMcpConnection = {
  client: InternalMcpClient;
  clientTransport: InternalMcpTransport;
  server: InternalMcpServer;
  serverTransport: InternalMcpTransport;
};

type InternalMcpSdk = {
  Client: new (
    implementation: { name: string; version: string },
    options?: { capabilities?: Record<string, unknown> }
  ) => InternalMcpClient;
  InMemoryTransport: {
    createLinkedPair: () => [InternalMcpTransport, InternalMcpTransport];
  };
};

async function loadInternalMcpSdk(): Promise<InternalMcpSdk> {
  try {
    const [clientModule, inMemoryModule] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
    ]);

    return {
      Client: clientModule.Client as InternalMcpSdk['Client'],
      InMemoryTransport: inMemoryModule.InMemoryTransport as InternalMcpSdk['InMemoryTransport'],
    };
  } catch (error) {
    const message = resolveErrorMessage(error);
    throw new Error(`ARCANOS internal MCP client is unavailable because @modelcontextprotocol/sdk failed to load: ${message}`);
  }
}

function normalizeToolName(toolName: string): string {
  const normalizedToolName = toolName.trim();
  //audit Assumption: backend callers must provide an explicit MCP tool name; failure risk: empty tool names produce misleading transport errors; expected invariant: each invocation targets one named tool; handling strategy: fail fast before opening the MCP connection.
  if (!normalizedToolName) {
    throw new Error('ARCANOS MCP tool name is required');
  }

  return normalizedToolName;
}

async function buildInvocationContext(
  options: Pick<ArcanosMcpInvokeOptions, 'request' | 'sessionId'> | ArcanosMcpListToolsOptions
): Promise<McpRequestContext> {
  const contextModule = await import('../mcp/context.js');

  //audit Assumption: an Express request should win when available so MCP calls inherit request-scoped session and request id data; failure risk: detached context loses auth-adjacent telemetry or wrong session linkage; expected invariant: HTTP callers reuse HTTP context, background callers use internal context; handling strategy: branch on request presence.
  if (options.request) {
    return contextModule.buildMcpRequestContext(options.request);
  }

  return contextModule.buildMcpInternalContext(options.sessionId);
}

async function closeInternalMcpConnection(connection: InternalMcpConnection, ctx: McpRequestContext): Promise<void> {
  const closeFailures: Array<{ target: string; error: string }> = [];

  for (const [target, closeable] of [
    ['client', connection.client],
    ['server', connection.server],
    ['clientTransport', connection.clientTransport],
    ['serverTransport', connection.serverTransport],
  ] as const) {
    if (typeof closeable.close !== 'function') {
      continue;
    }

    try {
      await closeable.close();
    } catch (error) {
      //audit Assumption: cleanup failures should not hide the primary tool result; failure risk: transport leaks or masked root-cause errors; expected invariant: every close attempt is made and any cleanup error is emitted; handling strategy: collect and log structured cleanup failures after all close attempts.
      closeFailures.push({ target, error: resolveErrorMessage(error) });
    }
  }

  if (closeFailures.length > 0) {
    ctx.logger.error('internal_mcp_cleanup_failed', { closeFailures });
  }
}

async function openInternalMcpConnection(ctx: McpRequestContext): Promise<InternalMcpConnection> {
  const [{ createMcpServer }, { Client, InMemoryTransport }] = await Promise.all([
    import('../mcp/server.js'),
    loadInternalMcpSdk(),
  ]);

  const server = await createMcpServer(ctx) as InternalMcpServer;
  const client = new Client({ name: 'arcanos-backend', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connection: InternalMcpConnection = {
    client,
    clientTransport,
    server,
    serverTransport,
  };

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return connection;
  } catch (error) {
    //audit Assumption: partially-open MCP transports must always be torn down on connection failure; failure risk: orphaned transports leak resources and poison later retries; expected invariant: failed connection attempts leave no live in-memory transport; handling strategy: close the partial connection before surfacing a structured failure.
    await closeInternalMcpConnection(connection, ctx);
    throw new Error(`Failed to open ARCANOS internal MCP connection: ${resolveErrorMessage(error)}`);
  }
}

/**
 * Invoke one ARCANOS MCP tool from backend code without routing through `/mcp`.
 *
 * Purpose:
 * - Let app routes, services, and workers reuse the canonical ARCANOS MCP tool registry in-process.
 *
 * Inputs/outputs:
 * - Input: tool name, optional JSON arguments, plus optional request or session context.
 * - Output: raw MCP `callTool` result returned by the in-process client.
 *
 * Edge case behavior:
 * - Throws on empty tool names, MCP transport startup failures, or tool execution failures.
 */
export async function invokeArcanosMcpTool(options: ArcanosMcpInvokeOptions): Promise<ArcanosMcpToolCallResult> {
  const normalizedToolName = normalizeToolName(options.toolName);
  const context = await buildInvocationContext(options);
  const connection = await openInternalMcpConnection(context);

  try {
    return await connection.client.callTool({
      name: normalizedToolName,
      arguments: options.toolArguments ?? {},
    });
  } catch (error) {
    //audit Assumption: backend callers need a tool-specific failure message rather than a transport-generic exception; failure risk: opaque errors slow debugging and retry strategy; expected invariant: the thrown error names the MCP tool that failed; handling strategy: wrap the SDK error with the tool name while preserving cleanup in `finally`.
    throw new Error(`ARCANOS MCP tool "${normalizedToolName}" failed: ${resolveErrorMessage(error)}`);
  } finally {
    await closeInternalMcpConnection(connection, context);
  }
}

/**
 * List ARCANOS MCP tools from backend code without routing through `/mcp`.
 *
 * Purpose:
 * - Give backend services a discovery path for the canonical ARCANOS MCP registry.
 *
 * Inputs/outputs:
 * - Input: optional request or session context.
 * - Output: raw MCP `listTools` result from the in-process client.
 *
 * Edge case behavior:
 * - Throws when the in-process MCP connection cannot be opened or tool discovery fails.
 */
export async function listArcanosMcpTools(
  options: ArcanosMcpListToolsOptions = {}
): Promise<ArcanosMcpToolListResult> {
  const context = await buildInvocationContext(options);
  const connection = await openInternalMcpConnection(context);

  try {
    return await connection.client.listTools();
  } catch (error) {
    //audit Assumption: discovery failures should surface as explicit MCP list failures; failure risk: callers misread a transport error as "no tools"; expected invariant: list failure remains distinct from an empty tool list; handling strategy: wrap and rethrow the SDK error with list-specific context.
    throw new Error(`ARCANOS MCP tool discovery failed: ${resolveErrorMessage(error)}`);
  } finally {
    await closeInternalMcpConnection(connection, context);
  }
}

export const arcanosMcpService: ArcanosMcpService = Object.freeze({
  invokeTool: invokeArcanosMcpTool,
  listTools: listArcanosMcpTools,
});
