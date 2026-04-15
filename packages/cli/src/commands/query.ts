import { requestQuery } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import { extractHumanReadableText } from "./humanOutput.js";
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
  const resultText = extractHumanReadableText(payload.result, payload.message);
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
