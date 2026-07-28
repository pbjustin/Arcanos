/**
 * Narrow request-scoped port for invoking the in-process ARCANOS MCP service.
 *
 * This module intentionally has no dependency on the concrete MCP client or
 * server. Control-plane consumers can depend on the port without creating a
 * service -> MCP server -> control-plane cycle.
 */

import type { Request } from 'express';

export interface ArcanosMcpInvokeOptions {
  toolName: string;
  toolArguments?: Record<string, unknown>;
  request?: Request;
  sessionId?: string;
}

export interface ArcanosMcpListToolsOptions {
  request?: Request;
  sessionId?: string;
}

export interface ArcanosMcpPort {
  invokeTool(options: ArcanosMcpInvokeOptions): Promise<Record<string, unknown>>;
  listTools(options?: ArcanosMcpListToolsOptions): Promise<Record<string, unknown>>;
}

type RequestWithAppLocals = {
  app?: {
    locals?: {
      arcanosMcp?: unknown;
    };
  };
};

function isArcanosMcpPort(candidate: unknown): candidate is ArcanosMcpPort {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const record = candidate as Record<string, unknown>;
  return typeof record.invokeTool === 'function' && typeof record.listTools === 'function';
}

export function resolveArcanosMcpPortFromRequest(request: unknown): ArcanosMcpPort | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }

  const candidate = (request as RequestWithAppLocals).app?.locals?.arcanosMcp;
  return isArcanosMcpPort(candidate) ? candidate : undefined;
}
