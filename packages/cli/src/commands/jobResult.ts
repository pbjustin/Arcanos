import { serializeDeterministicJson } from "../client/protocol.js";
import { getJobResult } from "../client/backend.js";
import type { CliCommandResult, JobResultCommandInvocation } from "./types.js";

export async function runJobResultCommand(
  invocation: JobResultCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const payload = await getJobResult({
    baseUrl: invocation.options.baseUrl,
    jobId: invocation.jobId
  });

  return {
    command: "job.result",
    request: {
      command: "job.result",
      baseUrl: invocation.options.baseUrl,
      jobId: invocation.jobId
    },
    response: {
      ok: true,
      data: payload,
      meta: {
        version: "0.1.0",
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: extractJobResultHumanOutput(payload)
  };
}

function extractJobResultHumanOutput(payload: Record<string, unknown>): string {
  const directResult = payload.result;
  if (typeof directResult === "string" && directResult.trim().length > 0) {
    return directResult.trim();
  }

  if (directResult && typeof directResult === "object" && !Array.isArray(directResult)) {
    const nestedMessage = (directResult as Record<string, unknown>).message;
    if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
      return nestedMessage.trim();
    }
  }

  return serializeDeterministicJson(payload);
}
