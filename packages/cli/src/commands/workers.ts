import { fetchWorkersSnapshot, type BackendWorkersSnapshot } from "../client/backend.js";
import type { CliProtocolCommandResult, WorkersCommandInvocation } from "./types.js";

export async function runWorkersCommand(
  invocation: WorkersCommandInvocation
): Promise<CliProtocolCommandResult<BackendWorkersSnapshot>> {
  const snapshot = await fetchWorkersSnapshot(invocation.options);

  return {
    command: "workers",
    request: {
      command: "workers",
      baseUrl: invocation.options.baseUrl,
    },
    response: {
      ok: true,
      data: snapshot,
      meta: {
        version: "0.1.0",
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: `Workers: ${String(snapshot.health.overallStatus ?? "unknown")} | runtime=${String(snapshot.workers.totalWorkers ?? "unknown")}`,
    extraJson: {
      backendWorkers: snapshot,
    }
  };
}
