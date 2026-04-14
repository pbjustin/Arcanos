import { requestQuery } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import type { CliCommandResult, QueryCommandInvocation } from "./types.js";

export async function runQueryCommand(
  invocation: QueryCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const payload = await requestQuery({
    baseUrl: invocation.options.baseUrl,
    gptId: invocation.gptId,
    prompt: invocation.prompt
  });

  return {
    command: "gpt.query",
    request: {
      command: "gpt.query",
      baseUrl: invocation.options.baseUrl,
      gptId: invocation.gptId,
      prompt: invocation.prompt
    },
    response: {
      ok: true,
      data: payload,
      meta: {
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: extractQueryHumanOutput(payload)
  };
}

function extractQueryHumanOutput(payload: Record<string, unknown>): string {
  const resultText = extractTextValue(payload.result);
  if (resultText) {
    return resultText;
  }

  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
  if (status && jobId) {
    return `Queued job ${jobId} (${status}). Use \`arcanos job-status ${jobId}\` or \`arcanos job-result ${jobId}\`.`;
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
