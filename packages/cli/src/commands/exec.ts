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
  const executionId = response.data?.state.executionId ?? "unknown";
  const status = response.data?.state.status ?? "unknown";

  return {
    command: request.command,
    request,
    response,
    humanOutput: `Execution queued: ${executionId} (${status})`
  };
}
