import { requestQueryAndWait } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import type { CliCommandResult, QueryAndWaitCommandInvocation } from "./types.js";

const DEFAULT_QUERY_AND_WAIT_TIMEOUT_MS = 25_000;

export async function runQueryAndWaitCommand(
  invocation: QueryAndWaitCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const resolvedTimeoutMs = invocation.timeoutMs ?? DEFAULT_QUERY_AND_WAIT_TIMEOUT_MS;
  const payload = await requestQueryAndWait({
    baseUrl: invocation.options.baseUrl,
    gptId: invocation.gptId,
    prompt: invocation.prompt,
    timeoutMs: resolvedTimeoutMs,
    ...(invocation.pollIntervalMs !== undefined
      ? { pollIntervalMs: invocation.pollIntervalMs }
      : {})
  });

  return {
    command: "gpt.query_and_wait",
    request: {
      command: "gpt.query_and_wait",
      baseUrl: invocation.options.baseUrl,
      gptId: invocation.gptId,
      prompt: invocation.prompt,
      timeoutMs: resolvedTimeoutMs,
      ...(invocation.pollIntervalMs !== undefined
        ? { pollIntervalMs: invocation.pollIntervalMs }
        : {})
    },
    response: {
      ok: true,
      data: payload,
      meta: {
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: extractQueryAndWaitHumanOutput(payload, resolvedTimeoutMs)
  };
}

function extractQueryAndWaitHumanOutput(
  payload: Record<string, unknown>,
  timeoutMs: number
): string {
  const directText = extractTextValue(payload.result);
  if (directText) {
    return directText;
  }

  const pendingStatus = typeof payload.status === "string" ? payload.status : "";
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
  if (pendingStatus === "pending" && jobId) {
    const instruction =
      typeof payload.instruction === "string" && payload.instruction.trim().length > 0
        ? payload.instruction
        : `query_and_wait timed out after ${timeoutMs}ms. Use \`arcanos job-result ${jobId}\` to retrieve the final result.`;
    return `Job ${jobId} is still pending. ${instruction}`;
  }

  return serializeDeterministicJson(payload);
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const recordValue = value as Record<string, unknown>;
  for (const key of ["text", "message", "result", "response"]) {
    const candidate = recordValue[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return "";
}
