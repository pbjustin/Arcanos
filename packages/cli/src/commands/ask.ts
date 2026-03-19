import type { TaskCreateResponseData } from "@arcanos/protocol";

import { executeTaskCreate } from "../client/backend.js";
import { buildTaskCreateRequest } from "../client/protocol.js";
import type { AskCommandInvocation, CliProtocolCommandResult } from "./types.js";

export async function runAskCommand(
  invocation: AskCommandInvocation
): Promise<CliProtocolCommandResult<TaskCreateResponseData>> {
  const request = buildTaskCreateRequest(invocation.prompt, invocation.options);
  const response = await executeTaskCreate(request, invocation.options);

  return {
    command: request.command,
    request,
    response,
    humanOutput: extractBackendText(response.data?.backendResponse) || "Task submitted successfully."
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
