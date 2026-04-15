import { generatePromptAndWait } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import { extractHumanReadableText } from "./humanOutput.js";
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
  const directText = extractHumanReadableText(payload.result, payload.message);
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
