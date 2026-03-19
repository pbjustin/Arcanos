import type { ToolInvokeResponseData } from "@arcanos/protocol";

import { executeRuntimeRequest, validateToolInvokeResponse } from "../client/backend.js";
import { buildDoctorImplementationRequest } from "../client/protocol.js";
import type { CliProtocolCommandResult, DoctorCommandInvocation } from "./types.js";

export async function runDoctorCommand(
  invocation: DoctorCommandInvocation
): Promise<CliProtocolCommandResult<ToolInvokeResponseData>> {
  const request = buildDoctorImplementationRequest(invocation.options);
  const response = validateToolInvokeResponse(
    await executeRuntimeRequest<ToolInvokeResponseData>(request, invocation.options)
  );

  return {
    command: request.command,
    request,
    response,
    humanOutput: `doctor implementation: ${readDoctorStatus(response.data?.result)}`
  };
}

function readDoctorStatus(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "unknown";
  }

  const status = (result as Record<string, unknown>).status;
  return typeof status === "string" ? status : "unknown";
}
