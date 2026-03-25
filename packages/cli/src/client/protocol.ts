import { createHash } from "node:crypto";

import {
  assertValidProtocolRequest,
  assertValidProtocolResponse,
  createProtocolRequest,
  type ContextInspectRequestPayload,
  type ContextInspectResponseData,
  type DaemonCapabilitiesResponseData,
  type ExecResumeRequestPayload,
  type ExecResumeResponseData,
  type ExecStartRequestPayload,
  type ExecStartResponseData,
  type ExecStatusRequestPayload,
  type ExecStatusResponseData,
  type PlanGenerateRequestPayload,
  type PlanGenerateResponseData,
  type ProtocolCommandId,
  type ProtocolContext,
  type ProtocolRequest,
  type ProtocolResponse,
  type TaskCreateRequestPayload,
  type TaskCreateResponseData,
  type ToolInvokeRequestPayload,
  type ToolInvokeResponseData
} from "@arcanos/protocol";

import type { CliGlobalOptions } from "../commands/types.js";

export function buildTaskCreateRequest(
  prompt: string,
  options: CliGlobalOptions
): ProtocolRequest<TaskCreateRequestPayload> {
  return buildRequest("task.create", { prompt }, options);
}

export function buildPlanGenerateRequest(
  prompt: string,
  options: CliGlobalOptions
): ProtocolRequest<PlanGenerateRequestPayload> {
  return buildRequest("plan.generate", { prompt }, options);
}

export function buildExecStartRequest(
  prompt: string | undefined,
  options: CliGlobalOptions
): ProtocolRequest<ExecStartRequestPayload> {
  const taskId = createDeterministicId("exec-task", {
    prompt: prompt ?? "",
    cwd: options.cwd,
    projectId: options.projectId
  });

  return buildRequest(
    "exec.start",
    {
      task: {
        id: taskId,
        command: "task.create",
        payload: prompt ? { prompt } : {},
        context: buildProtocolContext(options)
      }
    },
    options
  );
}

export function buildStatusRequest(options: CliGlobalOptions): ProtocolRequest<ContextInspectRequestPayload> {
  return buildRequest(
    "context.inspect",
    {
      includeProject: true,
      includeAvailableEnvironments: true
    },
    options
  );
}

export function buildCapabilitiesRequest(options: CliGlobalOptions): ProtocolRequest<Record<string, never>> {
  return buildRequest("daemon.capabilities", {}, options);
}

export function buildDoctorImplementationRequest(
  options: CliGlobalOptions
): ProtocolRequest<ToolInvokeRequestPayload> {
  return buildRequest(
    "tool.invoke",
    {
      toolId: "doctor.implementation",
      input: {}
    },
    options,
    {
      caller: {
        id: "arcanos-cli",
        type: "cli",
        scopes: ["repo:read", "tools:invoke"]
      }
    }
  );
}

export function buildExecStatusRequest(
  executionId: string,
  options: CliGlobalOptions
): ProtocolRequest<ExecStatusRequestPayload> {
  return buildRequest("exec.status", { executionId }, options);
}

export function buildExecResumeRequest(
  payload: ExecResumeRequestPayload,
  options: CliGlobalOptions
): ProtocolRequest<ExecResumeRequestPayload> {
  return buildRequest("exec.resume", payload, options);
}

export function assertTaskCreateResponse(
  response: ProtocolResponse<TaskCreateResponseData>
): ProtocolResponse<TaskCreateResponseData> {
  return assertValidProtocolResponse("task.create", response);
}

export function assertPlanGenerateResponse(
  response: ProtocolResponse<PlanGenerateResponseData>
): ProtocolResponse<PlanGenerateResponseData> {
  return assertValidProtocolResponse("plan.generate", response);
}

export function assertExecStartResponse(
  response: ProtocolResponse<ExecStartResponseData>
): ProtocolResponse<ExecStartResponseData> {
  return assertValidProtocolResponse("exec.start", response);
}

export function assertStatusResponse(
  response: ProtocolResponse<ContextInspectResponseData>
): ProtocolResponse<ContextInspectResponseData> {
  return assertValidProtocolResponse("context.inspect", response);
}

export function assertCapabilitiesResponse(
  response: ProtocolResponse<DaemonCapabilitiesResponseData>
): ProtocolResponse<DaemonCapabilitiesResponseData> {
  return assertValidProtocolResponse("daemon.capabilities", response);
}

export function assertToolInvokeResponse(
  response: ProtocolResponse<ToolInvokeResponseData>
): ProtocolResponse<ToolInvokeResponseData> {
  return assertValidProtocolResponse("tool.invoke", response);
}

export function assertExecStatusResponse(
  response: ProtocolResponse<ExecStatusResponseData>
): ProtocolResponse<ExecStatusResponseData> {
  return assertValidProtocolResponse("exec.status", response);
}

export function assertExecResumeResponse(
  response: ProtocolResponse<ExecResumeResponseData>
): ProtocolResponse<ExecResumeResponseData> {
  return assertValidProtocolResponse("exec.resume", response);
}

export function serializeDeterministicJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function buildRequest<TPayload>(
  command: ProtocolCommandId,
  payload: TPayload,
  options: CliGlobalOptions,
  extraContext: Partial<ProtocolContext> = {}
): ProtocolRequest<TPayload> {
  return assertValidProtocolRequest(
    createProtocolRequest({
      requestId: createDeterministicId(command, {
        payload,
        context: buildProtocolContext(options)
      }),
      command,
      context: {
        ...buildProtocolContext(options),
        ...extraContext
      },
      payload
    })
  );
}

function buildProtocolContext(options: CliGlobalOptions): ProtocolContext {
  return {
    sessionId: options.sessionId,
    projectId: options.projectId,
    environment: options.environment,
    cwd: options.cwd,
    shell: options.shell
  };
}

function createDeterministicId(prefix: string, seed: unknown): string {
  return `${prefix}-${createHash("sha1").update(serializeDeterministicJson(seed)).digest("hex").slice(0, 12)}`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([entryKey, entryValue]) => [entryKey, sortJsonValue(entryValue)])
    );
  }

  return value;
}
