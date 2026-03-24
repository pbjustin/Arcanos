import type { ExecStartResponseData } from "@arcanos/protocol";

import { executeRuntimeRequest, validateExecStartResponse } from "../client/backend.js";
import { buildExecStartRequest } from "../client/protocol.js";
import type { CliProtocolCommandResult, ExecCommandInvocation } from "./types.js";

export async function runExecCommand(
  invocation: ExecCommandInvocation
): Promise<CliProtocolCommandResult<ExecStartResponseData>> {
  const request = buildExecStartRequest(invocation.prompt, invocation.options);
  const response = validateExecStartResponse(
    await executeRuntimeRequest<ExecStartResponseData>(request, invocation.options)
  );
  const executionState = response.data?.state;
  if (!executionState?.executionId) {
    throw new Error("Invalid response for exec.start: executionId is missing.");
  }

  if (!executionState.status) {
    throw new Error("Invalid response for exec.start: status is missing.");
  }

  return {
    command: request.command,
    request,
    response,
    humanOutput: `Execution queued: ${executionState.executionId} (${executionState.status})`
  };
}
