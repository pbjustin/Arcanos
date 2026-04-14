import { serializeDeterministicJson } from "../client/protocol.js";
import { getJobStatus } from "../client/backend.js";
import type { CliCommandResult, JobStatusCommandInvocation } from "./types.js";

export async function runJobStatusCommand(
  invocation: JobStatusCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const snapshot = await getJobStatus({
    baseUrl: invocation.options.baseUrl,
    jobId: invocation.jobId
  });

  return {
    command: "job.status",
    request: {
      command: "job.status",
      baseUrl: invocation.options.baseUrl,
      jobId: invocation.jobId
    },
    response: {
      ok: true,
      data: snapshot,
      meta: {
        version: "0.1.0",
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: extractJobStatusHumanOutput(invocation.jobId, snapshot)
  };
}

function extractJobStatusHumanOutput(jobId: string, payload: Record<string, unknown>): string {
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  if (status.length > 0) {
    return `Job ${jobId}: ${status}`;
  }

  return serializeDeterministicJson(payload);
}
