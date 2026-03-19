import type {
  ContextInspectResponseData,
  DaemonCapabilitiesResponseData
} from "@arcanos/protocol";

import {
  executeRuntimeRequest,
  fetchStatusSnapshot,
  validateCapabilitiesResponse,
  validateStatusResponse
} from "../client/backend.js";
import { buildCapabilitiesRequest, buildStatusRequest } from "../client/protocol.js";
import type { CliProtocolCommandResult, StatusCommandInvocation } from "./types.js";

export async function runStatusCommand(
  invocation: StatusCommandInvocation
): Promise<CliProtocolCommandResult<ContextInspectResponseData>> {
  const request = buildStatusRequest(invocation.options);
  const capabilitiesRequest = buildCapabilitiesRequest(invocation.options);
  const [response, capabilitiesResponse, backendStatus] = await Promise.all([
    executeRuntimeRequest<ContextInspectResponseData>(request, invocation.options),
    executeRuntimeRequest<DaemonCapabilitiesResponseData>(capabilitiesRequest, invocation.options),
    fetchStatusSnapshot(invocation.options)
  ]);

  const validatedResponse = validateStatusResponse(response);
  const validatedCapabilitiesResponse = validateCapabilitiesResponse(capabilitiesResponse);
  const healthStatus = typeof backendStatus.health.status === "string"
    ? backendStatus.health.status
    : "unknown";
  const cwd = validatedResponse.data?.environment.cwd ?? invocation.options.cwd ?? "unknown";

  return {
    command: request.command,
    request,
    response: validatedResponse,
    humanOutput: `Status: ${healthStatus} | cwd=${cwd} | supportedCommands=${validatedCapabilitiesResponse.data?.supportedCommands.length ?? 0}`,
    extraJson: {
      capabilitiesRequest,
      capabilitiesResponse: validatedCapabilitiesResponse,
      backendStatus
    }
  };
}
