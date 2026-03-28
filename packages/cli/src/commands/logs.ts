import { fetchRecentLogsSnapshot, type BackendRecentLogsSnapshot } from "../client/backend.js";
import type { CliProtocolCommandResult, LogsCommandInvocation } from "./types.js";

export async function runLogsCommand(
  invocation: LogsCommandInvocation
): Promise<CliProtocolCommandResult<BackendRecentLogsSnapshot>> {
  const snapshot = await fetchRecentLogsSnapshot(invocation.options, invocation.recent ? 20 : 20);
  const eventCount =
    typeof snapshot.events.count === "number"
      ? snapshot.events.count
      : Array.isArray(snapshot.events.events)
      ? snapshot.events.events.length
      : 0;

  return {
    command: "logs",
    request: {
      command: "logs",
      recent: invocation.recent,
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
    humanOutput: `Logs: recent runtime events=${eventCount}`,
    extraJson: {
      backendLogs: snapshot,
    }
  };
}
