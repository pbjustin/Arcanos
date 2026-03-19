import {
  type ContextInspectResponseData,
  type DaemonCapabilitiesResponseData,
  type ExecStartResponseData,
  type ProtocolRequest,
  type ProtocolResponse,
  type TaskCreateResponseData,
  type PlanGenerateResponseData,
  type ToolInvokeResponseData
} from "@arcanos/protocol";

import type { CliGlobalOptions } from "../commands/types.js";
import { dispatchProtocolRequest } from "../transport.js";
import {
  assertCapabilitiesResponse,
  assertExecStartResponse,
  assertPlanGenerateResponse,
  assertStatusResponse,
  assertTaskCreateResponse,
  assertToolInvokeResponse
} from "./protocol.js";

export interface BackendStatusSnapshot {
  state: Record<string, unknown>;
  health: Record<string, unknown>;
}

export async function executeTaskCreate(
  request: ProtocolRequest<{ prompt: string }>,
  options: CliGlobalOptions
): Promise<ProtocolResponse<TaskCreateResponseData>> {
  const prompt = request.payload?.prompt;
  if (!prompt) {
    throw new Error("Invalid payload for task.create: prompt is missing or empty.");
  }

  const backendResponse = await postJson(options.baseUrl, "/ask", {
    prompt,
    sessionId: request.context?.sessionId,
    metadata: {
      protocolCommand: request.command,
      protocolRequestId: request.requestId
    }
  });

  return assertTaskCreateResponse({
    protocol: request.protocol,
    requestId: request.requestId,
    ok: true,
    data: {
      task: {
        id: `task-${request.requestId}`,
        command: request.command,
        payload: request.payload,
        context: request.context
      },
      backendResponse
    },
    meta: {
      version: "0.1.0",
      executedBy: "http-backend-cli"
    }
  });
}

export async function executePlanGenerate(
  request: ProtocolRequest<{ prompt: string }>,
  options: CliGlobalOptions
): Promise<ProtocolResponse<PlanGenerateResponseData>> {
  const prompt = request.payload?.prompt;
  if (!prompt) {
    throw new Error("Invalid payload for plan.generate: prompt is missing or empty.");
  }

  const backendResponse = await postJson(options.baseUrl, "/ask", {
    prompt: [
      "Generate an implementation plan for the following request.",
      "Return concise, concrete steps and include key risks.",
      "",
      prompt
    ].join("\n"),
    sessionId: request.context?.sessionId,
    metadata: {
      protocolCommand: request.command,
      protocolRequestId: request.requestId
    }
  });

  return assertPlanGenerateResponse({
    protocol: request.protocol,
    requestId: request.requestId,
    ok: true,
    data: {
      task: {
        id: `plan-${request.requestId}`,
        command: request.command,
        payload: request.payload,
        context: request.context
      },
      backendResponse
    },
    meta: {
      version: "0.1.0",
      executedBy: "http-backend-cli"
    }
  });
}

export async function executeRuntimeRequest<TData>(
  request: ProtocolRequest<unknown>,
  options: CliGlobalOptions
): Promise<ProtocolResponse<TData>> {
  return dispatchProtocolRequest(request, options.transport, {
    pythonBinary: options.pythonBinary
  }) as Promise<ProtocolResponse<TData>>;
}

export async function fetchStatusSnapshot(options: CliGlobalOptions): Promise<BackendStatusSnapshot> {
  const [state, health] = await Promise.all([
    getJson(options.baseUrl, "/status"),
    getJson(options.baseUrl, "/health")
  ]);

  return { state, health };
}

export function validateStatusResponse(
  response: ProtocolResponse<ContextInspectResponseData>
): ProtocolResponse<ContextInspectResponseData> {
  return assertStatusResponse(response);
}

export function validateCapabilitiesResponse(
  response: ProtocolResponse<DaemonCapabilitiesResponseData>
): ProtocolResponse<DaemonCapabilitiesResponseData> {
  return assertCapabilitiesResponse(response);
}

export function validateExecStartResponse(
  response: ProtocolResponse<ExecStartResponseData>
): ProtocolResponse<ExecStartResponseData> {
  return assertExecStartResponse(response);
}

export function validateToolInvokeResponse(
  response: ProtocolResponse<ToolInvokeResponseData>
): ProtocolResponse<ToolInvokeResponseData> {
  return assertToolInvokeResponse(response);
}

async function postJson(
  baseUrl: string,
  pathname: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, withTrailingSlash(baseUrl)), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await readJsonPayload(response);
  if (!response.ok) {
    throw new Error(`Backend ${pathname} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function getJson(baseUrl: string, pathname: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, withTrailingSlash(baseUrl)));
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    throw new Error(`Backend ${pathname} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function readJsonPayload(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Backend returned a non-object JSON payload.");
  }
  return payload as Record<string, unknown>;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
