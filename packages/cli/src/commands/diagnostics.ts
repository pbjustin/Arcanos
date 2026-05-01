import { requestGptDiagnostics } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import type { CliCommandResult, DiagnosticsCommandInvocation } from "./types.js";

export async function runDiagnosticsCommand(
  invocation: DiagnosticsCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const payload = await requestGptDiagnostics({
    baseUrl: invocation.options.baseUrl,
    gptId: invocation.gptId,
    root: invocation.root
  });

  return {
    command: invocation.root ? "gpt_access.root_deep_diagnostics" : "gpt_access.diagnostics",
    request: {
      command: invocation.root ? "gpt_access.root_deep_diagnostics" : "gpt_access.diagnostics",
      baseUrl: invocation.options.baseUrl,
      endpoint: "/gpt-access/diagnostics/deep",
      gptId: invocation.gptId,
      action: "diagnostics.deep",
      authorization: "Bearer [REDACTED]"
    },
    response: {
      ok: true,
      data: payload,
      meta: {
        executedBy: "http-backend-cli"
      }
    },
    humanOutput: extractDiagnosticsHumanOutput(payload, invocation.root)
  };
}

function extractDiagnosticsHumanOutput(payload: Record<string, unknown>, root: boolean): string {
  const traceId = typeof payload.traceId === "string" ? payload.traceId : "unknown";
  const ok = payload.ok !== false ? "ok" : "degraded";
  const report = Array.isArray(payload.report) ? payload.report : [];
  const failedChecks = report.filter((entry) => {
    return Boolean(entry) && typeof entry === "object" && (entry as Record<string, unknown>).ok === false;
  }).length;

  if (root) {
    return `Root diagnostics: ${ok} | checks=${report.length} | failed=${failedChecks} | traceId=${traceId}`;
  }

  return serializeDeterministicJson(payload);
}
