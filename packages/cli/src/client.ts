import { createHash } from "node:crypto";

import {
  createProtocolRequest,
  type ProtocolCaller,
  type ToolInvokeResponseData
} from "@arcanos/protocol";

import { serializeDeterministicJson } from "./client/protocol.js";
import { dispatchProtocolRequest, type ProtocolTransportName } from "./transport.js";
import { assertTransportSupportsProtocolCommand } from "./transportConstraints.js";

export interface InvokeToolOptions {
  toolId: string;
  inputs?: Record<string, unknown>;
  requestId?: string;
  transport?: ProtocolTransportName;
  transportExplicit?: boolean;
  pythonBinary?: string;
  context?: {
    sessionId?: string;
    projectId?: string;
    environment?: string;
    cwd?: string;
    shell?: string;
  };
  caller?: ProtocolCaller;
}

const DEFAULT_CALLER: ProtocolCaller = {
  id: "arcanos-cli-client",
  type: "cli",
  scopes: ["repo:read", "tools:invoke"]
};

/**
 * Invokes one protocol-visible tool over the selected transport and returns its typed result payload.
 * Inputs: tool id, JSON inputs, optional caller/context overrides, and transport settings.
 * Outputs: resolved tool result from the `tool.invoke` response envelope.
 * Edge cases: failed protocol responses throw so higher layers cannot silently proceed without evidence.
 */
export async function invokeTool(options: InvokeToolOptions): Promise<unknown> {
  const resolvedTransport = options.transport ?? "python";
  assertTransportSupportsProtocolCommand("tool.invoke", {
    transport: resolvedTransport,
    transportExplicit: options.transportExplicit
  });

  const request = createProtocolRequest({
    requestId: options.requestId ?? createInvokeRequestId(options.toolId, options.inputs ?? {}),
    command: "tool.invoke",
    context: {
      environment: options.context?.environment ?? "workspace",
      cwd: options.context?.cwd ?? process.cwd(),
      shell: options.context?.shell,
      projectId: options.context?.projectId,
      sessionId: options.context?.sessionId,
      caller: options.caller ?? DEFAULT_CALLER
    },
    payload: {
      toolId: options.toolId,
      input: options.inputs ?? {}
    }
  });

  const response = await dispatchProtocolRequest(
    request,
    resolvedTransport,
    { pythonBinary: options.pythonBinary }
  );

  if (!response.ok) {
    throw new Error(response.error?.message ?? `Protocol tool "${options.toolId}" failed.`);
  }

  return (response.data as ToolInvokeResponseData).result;
}

export {
  buildGptRouteRequestBody,
  createAsyncGptJob,
  fetchGptJobResult,
  getJobResult,
  getJobStatus,
  invokeGptRoute,
  type FetchGptJobResultOptions,
  type FetchGptJobStatusOptions,
  type GptRouteRequestBody,
  type InvokeGptRouteOptions
} from "./client/backend.js";

function createInvokeRequestId(toolId: string, inputs: Record<string, unknown>): string {
  const digest = createHash("sha1")
    .update(serializeDeterministicJson({ toolId, inputs, command: "tool.invoke" }))
    .digest("hex")
    .slice(0, 12);
  return `tool-${digest}`;
}
