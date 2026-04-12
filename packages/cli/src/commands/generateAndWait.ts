import { generatePromptAndWait } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import type { CliCommandResult, GenerateAndWaitCommandInvocation } from "./types.js";

const DEFAULT_GENERATE_AND_WAIT_TIMEOUT_MS = 20_000;

export async function runGenerateAndWaitCommand(
  invocation: GenerateAndWaitCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const resolvedTimeoutMs = invocation.timeoutMs ?? DEFAULT_GENERATE_AND_WAIT_TIMEOUT_MS;
  const request: Record<string, unknown> = {
    command: "gpt.generate_and_wait",
    baseUrl: invocation.options.baseUrl,
    gptId: invocation.gptId,
    prompt: invocation.prompt,
    timeoutMs: resolvedTimeoutMs,
    ...(invocation.pollIntervalMs !== undefined
      ? { pollIntervalMs: invocation.pollIntervalMs }
      : {})
  };
  const backendResponse = await generatePromptAndWait({
    baseUrl: invocation.options.baseUrl,
    gptId: invocation.gptId,
    prompt: invocation.prompt,
    timeoutMs: resolvedTimeoutMs,
    ...(invocation.pollIntervalMs !== undefined
      ? { pollIntervalMs: invocation.pollIntervalMs }
      : {})
  });

  return {
    command: "gpt.generate_and_wait",
    request,
    response: {
      ok: true,
      data: backendResponse,
      meta: {
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: extractGenerateAndWaitHumanOutput(backendResponse, resolvedTimeoutMs)
  };
}

function extractGenerateAndWaitHumanOutput(
  payload: Record<string, unknown>,
  timeoutMs: number
): string {
  const directText = extractBackendText(payload);
  if (directText) {
    return directText;
  }

  const pendingStatus = typeof payload.status === "string" ? payload.status : "";
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
  if (pendingStatus === "pending" && jobId) {
    const jobStatus =
      typeof payload.jobStatus === "string" && payload.jobStatus.trim().length > 0
        ? payload.jobStatus
        : pendingStatus;
    const instruction =
      typeof payload.instruction === "string" && payload.instruction.trim().length > 0
        ? payload.instruction
        : `Direct wait timed out after ${timeoutMs}ms. Use GET /jobs/${jobId}/result to retrieve the final result.`;
    return `Timed out waiting for a direct result. Job ${jobId} is ${jobStatus}. ${instruction}`;
  }

  return serializeDeterministicJson(payload);
}

function extractBackendText(payload: Record<string, unknown>): string {
  const directResult = extractTextValue(payload.result);
  if (directResult) {
    return directResult;
  }

  const message = extractTextValue(payload.message);
  if (message) {
    return message;
  }

  return "";
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const recordValue = value as Record<string, unknown>;
  const nestedResult = recordValue.result;
  if (typeof nestedResult === "string" && nestedResult.trim().length > 0) {
    return nestedResult.trim();
  }

  const nestedPrompt = recordValue.prompt;
  if (typeof nestedPrompt === "string" && nestedPrompt.trim().length > 0) {
    return nestedPrompt.trim();
  }

  const nestedMessage = recordValue.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
    return nestedMessage.trim();
  }

  return "";
}
