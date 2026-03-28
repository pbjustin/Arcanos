import { fetchSelfHealInspectionSnapshot } from "../client/backend.js";
import type { CliProtocolCommandResult, InspectCommandInvocation } from "./types.js";

export async function runInspectCommand(
  invocation: InspectCommandInvocation
): Promise<CliProtocolCommandResult<Record<string, unknown>>> {
  const snapshot = await fetchSelfHealInspectionSnapshot(invocation.options);

  return {
    command: "inspect",
    request: {
      command: "inspect",
      subject: invocation.subject,
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
    humanOutput: `Inspect ${invocation.subject}: ${String(snapshot.status ?? "unknown")}`,
    extraJson: {
      inspection: snapshot,
    }
  };
}
