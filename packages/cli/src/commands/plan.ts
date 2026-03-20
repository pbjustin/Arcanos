import type { PlanGenerateResponseData } from "@arcanos/protocol";

import { executePlanGenerate } from "../client/backend.js";
import { buildPlanGenerateRequest } from "../client/protocol.js";
import type { CliProtocolCommandResult, PlanCommandInvocation } from "./types.js";

export async function runPlanCommand(
  invocation: PlanCommandInvocation
): Promise<CliProtocolCommandResult<PlanGenerateResponseData>> {
  const request = buildPlanGenerateRequest(invocation.prompt, invocation.options);
  const response = await executePlanGenerate(request, invocation.options);

  return {
    command: request.command,
    request,
    response,
    humanOutput: extractBackendText(response.data?.backendResponse) || "Plan generated successfully."
  };
}

function extractBackendText(payload: Record<string, unknown> | undefined): string {
  const result = payload?.result;
  if (typeof result === "string" && result.trim().length > 0) {
    return result;
  }

  const message = payload?.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message;
  }

  return "";
}
