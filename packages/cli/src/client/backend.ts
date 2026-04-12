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

export interface BackendWorkersSnapshot {
  workers: Record<string, unknown>;
  health: Record<string, unknown>;
}

export interface BackendRecentLogsSnapshot {
  source: "runtime-events";
  events: Record<string, unknown>;
}

export interface GptRouteRequestBody {
  prompt?: string;
  gptVersion?: string;
  action?: string;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface InvokeGptRouteOptions {
  baseUrl: string;
  gptId: string;
  prompt?: string;
  gptVersion?: string;
  action?: string;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface FetchGptJobResultOptions {
  baseUrl: string;
  jobId: string;
  headers?: Record<string, string>;
}

export interface FetchGptJobStatusOptions {
  baseUrl: string;
  jobId: string;
  headers?: Record<string, string>;
}

const DEFAULT_BACKEND_GPT_ID =
  process.env.ARCANOS_BACKEND_GPT_ID?.trim() ||
  process.env.BACKEND_GPT_ID?.trim() ||
  "arcanos-daemon";

function resolveDefaultBackendGptId(): string {
  return DEFAULT_BACKEND_GPT_ID;
}

export async function executeTaskCreate(
  request: ProtocolRequest<{ prompt: string }>,
  options: CliGlobalOptions
): Promise<ProtocolResponse<TaskCreateResponseData>> {
  const prompt = request.payload?.prompt;
  if (!prompt) {
    throw new Error("Invalid payload for task.create: prompt is missing or empty.");
  }

  const backendResponse = await invokeGptRoute({
    baseUrl: options.baseUrl,
    gptId: resolveDefaultBackendGptId(),
    prompt
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

  const backendResponse = await invokeGptRoute({
    baseUrl: options.baseUrl,
    gptId: resolveDefaultBackendGptId(),
    prompt: [
      "Generate an implementation plan for the following request.",
      "Return concise, concrete steps and include key risks.",
      "",
      prompt
    ].join("\n")
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

export async function fetchWorkersSnapshot(options: CliGlobalOptions): Promise<BackendWorkersSnapshot> {
  const [workers, health] = await Promise.all([
    getJson(options.baseUrl, "/workers/status"),
    getJson(options.baseUrl, "/worker-helper/health")
  ]);

  return { workers, health };
}

export async function fetchRecentLogsSnapshot(options: CliGlobalOptions, limit = 20): Promise<BackendRecentLogsSnapshot> {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  const events = await getJson(options.baseUrl, `/api/self-heal/events?limit=${boundedLimit}`);

  return {
    source: "runtime-events",
    events
  };
}

export async function fetchSelfHealInspectionSnapshot(options: CliGlobalOptions): Promise<Record<string, unknown>> {
  return getJson(options.baseUrl, "/status/safety/self-heal");
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

/**
 * Builds the prompt-first GPT route request body for `/gpt/{gptId}`.
 * Inputs/Outputs: caller-provided prompt/action/payload/context fields; returns the JSON body with no duplicated `gptId`.
 * Edge cases: blank `action` values are omitted so clients do not silently inject unsupported defaults such as `"ask"`.
 */
export function buildGptRouteRequestBody(options: Omit<InvokeGptRouteOptions, "baseUrl" | "gptId" | "headers">): GptRouteRequestBody {
  const prompt = options.prompt?.trim();
  const action = options.action?.trim();
  if (!prompt && !action) {
    throw new Error("GPT route prompt is required when action is not supplied.");
  }

  const body: GptRouteRequestBody = {};

  if (prompt) {
    body.prompt = prompt;
  }

  const gptVersion = options.gptVersion?.trim();
  if (gptVersion) {
    body.gptVersion = gptVersion;
  }

  // Keep the route generic: only include action when the caller explicitly requested one.
  if (action) {
    body.action = action;
  }

  if (options.payload) {
    body.payload = options.payload;
  }

  if (options.context) {
    body.context = options.context;
  }

  return body;
}

/**
 * Invokes the canonical GPT route contract at `/gpt/{gptId}`.
 * Inputs/Outputs: base URL, path-bound gptId, and a prompt-first request body; returns the backend JSON payload.
 * Edge cases: rejects blank gpt ids locally and never duplicates gptId in the JSON body.
 */
export async function invokeGptRoute(options: InvokeGptRouteOptions): Promise<Record<string, unknown>> {
  const gptId = options.gptId.trim();
  if (!gptId) {
    throw new Error("GPT route gptId is required.");
  }

  const body = buildGptRouteRequestBody(options);
  return postJson(
    options.baseUrl,
    `/gpt/${encodeURIComponent(gptId)}`,
    body,
    options.headers
  );
}

/**
 * Creates async GPT work through the canonical `/gpt/{gptId}` write route.
 * Inputs/Outputs: prompt-first GPT route options; returns the backend JSON payload.
 * Edge cases: preserves the same validation rules as `invokeGptRoute`.
 */
export async function createAsyncGptJob(
  options: InvokeGptRouteOptions
): Promise<Record<string, unknown>> {
  return invokeGptRoute(options);
}

function normalizeJobLookupId(jobId: string): string {
  const normalized = jobId.trim();
  if (!normalized) {
    throw new Error("Job lookup jobId is required.");
  }

  return encodeURIComponent(normalized);
}

/**
 * Reads canonical async job status from `GET /jobs/{jobId}`.
 * Inputs/Outputs: base URL plus job id; returns the backend JSON payload.
 * Edge cases: blank job ids fail locally so callers never fall back to GPT routing.
 */
export async function getJobStatus(
  options: FetchGptJobStatusOptions
): Promise<Record<string, unknown>> {
  const encodedJobId = normalizeJobLookupId(options.jobId);
  return getJson(options.baseUrl, `/jobs/${encodedJobId}`, options.headers);
}

/**
 * Reads canonical async job results from `GET /jobs/{jobId}/result`.
 * Inputs/Outputs: base URL plus job id; returns the backend JSON payload.
 * Edge cases: blank job ids fail locally so callers never fall back to GPT routing.
 */
export async function getJobResult(
  options: FetchGptJobResultOptions
): Promise<Record<string, unknown>> {
  const encodedJobId = normalizeJobLookupId(options.jobId);
  return getJson(options.baseUrl, `/jobs/${encodedJobId}/result`, options.headers);
}

export async function fetchGptJobResult(
  options: FetchGptJobResultOptions
): Promise<Record<string, unknown>> {
  return getJobResult(options);
}

async function postJson(
  baseUrl: string,
  pathname: string,
  body: object,
  extraHeaders: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, withTrailingSlash(baseUrl)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(`Backend ${pathname} failed with HTTP ${response.status}: ${formatResponsePayloadForError(payload)}`);
  }

  return requireJsonObjectPayload(payload);
}

async function getJson(
  baseUrl: string,
  pathname: string,
  extraHeaders: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, withTrailingSlash(baseUrl)), {
    headers: extraHeaders
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(`Backend ${pathname} failed with HTTP ${response.status}: ${formatResponsePayloadForError(payload)}`);
  }

  return requireJsonObjectPayload(payload);
}

interface BackendResponsePayload {
  json: Record<string, unknown> | null;
  rawText: string;
}

const MAX_ERROR_BODY_CHARS = 1000;

async function readResponsePayload(response: Response): Promise<BackendResponsePayload> {
  const rawText = await response.text();
  const trimmedText = rawText.trim();

  if (!trimmedText) {
    return {
      json: null,
      rawText
    };
  }

  try {
    const parsed = JSON.parse(trimmedText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        json: parsed as Record<string, unknown>,
        rawText
      };
    }
  } catch {
    // Preserve the original response body for downstream error reporting.
  }

  return {
    json: null,
    rawText
  };
}

function requireJsonObjectPayload(payload: BackendResponsePayload): Record<string, unknown> {
  if (!payload.json) {
    throw new Error(
      `Backend returned a non-JSON or non-object JSON payload: ${formatResponsePayloadForError(payload)}`
    );
  }

  return payload.json;
}

function formatResponsePayloadForError(payload: BackendResponsePayload): string {
  if (payload.json) {
    return JSON.stringify(payload.json);
  }

  const trimmedText = payload.rawText.trim();
  if (!trimmedText) {
    return "<empty response body>";
  }

  if (trimmedText.length <= MAX_ERROR_BODY_CHARS) {
    return trimmedText;
  }

  return `${trimmedText.slice(0, MAX_ERROR_BODY_CHARS)}\n[truncated]`;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
