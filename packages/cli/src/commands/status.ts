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
  const executionContext = buildExecutionContextSummary({
    cwd,
    environmentType: validatedResponse.data?.environment.type ?? invocation.options.environment,
    environmentCapabilities: validatedResponse.data?.environment.capabilities ?? [],
    healthStatus,
    supportedCommandCount: validatedCapabilitiesResponse.data?.supportedCommands.length ?? 0
  });

  return {
    command: request.command,
    request,
    response: validatedResponse,
    humanOutput: renderExecutionContextSummary(executionContext),
    extraJson: {
      executionContext,
      capabilitiesRequest,
      capabilitiesResponse: validatedCapabilitiesResponse,
      backendStatus
    }
  };
}

interface ExecutionContextSummaryInput {
  cwd: string;
  environmentType?: string;
  environmentCapabilities: string[];
  healthStatus: string;
  supportedCommandCount: number;
}

interface ExecutionContextSummary {
  mode: string;
  daemon: string;
  sandbox: string;
  execution: string;
  canAccess: string[];
  cannotAccess: string[];
  environmentWarning?: string;
  canAccessPersonalDesktop: boolean;
  supportedCommandCount: number;
}

function buildExecutionContextSummary(input: ExecutionContextSummaryInput): ExecutionContextSummary {
  const isRailwayRuntime = hasRailwayRuntimeMarker();
  const isRemoteEnvironment = input.environmentType === "remote";
  const bridgeTokenConfigured = Boolean(process.env.ARCANOS_CLI_BRIDGE_TOKEN?.trim());
  const healthConnected = ["ok", "healthy", "ready", "live"].includes(input.healthStatus.toLowerCase());
  const mode = isRailwayRuntime || isRemoteEnvironment
    ? "Production Runtime"
    : bridgeTokenConfigured
    ? "Local Desktop Daemon"
    : healthConnected
    ? "Local CLI Runtime"
    : "Unavailable";

  const canAccess = [
    isRailwayRuntime || isRemoteEnvironment ? "deployed runtime" : "local CLI runtime",
    `${input.cwd} workspace`,
    ...formatCapabilityLabels(input.environmentCapabilities)
  ];

  return {
    mode,
    daemon: healthConnected ? "Connected" : `Health ${input.healthStatus}`,
    sandbox: input.cwd,
    execution: "Confirmation required for CLI daemon actions",
    canAccess,
    cannotAccess: [
      isRailwayRuntime || isRemoteEnvironment ? "your personal desktop" : "paths outside the configured sandbox",
      "unrestricted shell",
      "raw secrets or environment variables",
      "patches touching secret files"
    ],
    environmentWarning: isRailwayRuntime || isRemoteEnvironment
      ? "Production runtime: actions are limited to the deployed container sandbox."
      : undefined,
    canAccessPersonalDesktop: bridgeTokenConfigured && !isRailwayRuntime && !isRemoteEnvironment,
    supportedCommandCount: input.supportedCommandCount
  };
}

function renderExecutionContextSummary(summary: ExecutionContextSummary): string {
  const lines = [
    "Execution Context",
    "-----------------",
    `Mode: ${summary.mode}`,
    `Daemon: ${summary.daemon}`,
    `Sandbox: ${summary.sandbox}`,
    `Execution: ${summary.execution}`
  ];

  if (summary.environmentWarning) {
    lines.push(`Warning: ${summary.environmentWarning}`);
  }

  lines.push(`Can access your personal desktop: ${summary.canAccessPersonalDesktop ? "Yes" : "No"}`);
  lines.push("Can access:");
  for (const item of summary.canAccess) {
    lines.push(`+ ${item}`);
  }
  lines.push("Cannot access:");
  for (const item of summary.cannotAccess) {
    lines.push(`- ${item}`);
  }
  lines.push(`Supported protocol commands: ${summary.supportedCommandCount}`);
  return lines.join("\n");
}

function hasRailwayRuntimeMarker(): boolean {
  return [
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_ENVIRONMENT_ID",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_DEPLOYMENT_ID"
  ].some((name) => Boolean(process.env[name]?.trim()));
}

function formatCapabilityLabels(capabilities: string[]): string[] {
  const normalized = new Set(capabilities.map((capability) => capability.toLowerCase()));
  const labels: string[] = [];
  if (normalized.has("repo-read") || normalized.has("git-read") || normalized.has("fs-read")) {
    labels.push("read-only repository inspection");
  }
  if (normalized.has("protocol-validation")) {
    labels.push("protocol validation");
  }
  if (normalized.has("in-memory-execution")) {
    labels.push("queued protocol execution state");
  }
  return labels;
}
