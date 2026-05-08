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
  const fallbackExecutionContext = buildExecutionContextSummary({
    cwd,
    environmentType: validatedResponse.data?.environment.type ?? invocation.options.environment,
    environmentCapabilities: validatedResponse.data?.environment.capabilities ?? [],
    healthStatus,
    supportedCommandCount: validatedCapabilitiesResponse.data?.supportedCommands.length ?? 0,
    supportedCommands: validatedCapabilitiesResponse.data?.supportedCommands ?? []
  });
  const executionContext = resolveExecutionContextSummary(
    backendStatus.state.executionContext,
    fallbackExecutionContext
  );

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
  supportedCommands?: string[];
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
  localDesktopDaemonReady: boolean;
  supportedCommandCount: number;
}

function buildExecutionContextSummary(input: ExecutionContextSummaryInput): ExecutionContextSummary {
  const isRailwayRuntime = hasRailwayRuntimeMarker();
  const isRemoteEnvironment = input.environmentType === "remote";
  const isProductionRuntime = isRailwayRuntime || isRemoteEnvironment;
  const bridgeEnabled = process.env.ARCANOS_CLI_BRIDGE_ENABLED?.trim().toLowerCase() === "true";
  const bridgeTokenConfigured = Boolean(process.env.ARCANOS_CLI_BRIDGE_TOKEN?.trim());
  const healthConnected = ["ok", "healthy", "ready", "live"].includes(input.healthStatus.toLowerCase());
  const localDesktopDaemonReady = bridgeEnabled
    && bridgeTokenConfigured
    && healthConnected
    && !isProductionRuntime;
  const mode = isProductionRuntime
    ? "Production Runtime"
    : localDesktopDaemonReady
    ? "Local Desktop Daemon"
    : healthConnected
    ? "Local CLI Runtime"
    : "Unavailable";

  const runtimeLabel = isProductionRuntime
    ? "deployed runtime"
    : localDesktopDaemonReady
    ? "local desktop daemon"
    : healthConnected
    ? "local CLI runtime"
    : undefined;
  const canAccess = [
    ...(runtimeLabel ? [runtimeLabel] : []),
    `${input.cwd} workspace`,
    ...formatCapabilityLabels(input.environmentCapabilities)
  ];

  return {
    mode,
    daemon: healthConnected ? "Connected" : `Health ${input.healthStatus}`,
    sandbox: input.cwd,
    execution: formatExecutionMode(input.supportedCommands, input.supportedCommandCount),
    canAccess,
    cannotAccess: [
      isProductionRuntime
        ? "your personal desktop"
        : localDesktopDaemonReady
        ? "paths outside the configured sandbox"
        : "your personal desktop through the local desktop daemon",
      "unrestricted shell",
      "raw secrets or environment variables",
      "patches touching secret files"
    ],
    environmentWarning: isProductionRuntime
      ? "Production runtime: actions are limited to the deployed container sandbox."
      : undefined,
    canAccessPersonalDesktop: localDesktopDaemonReady,
    localDesktopDaemonReady,
    supportedCommandCount: input.supportedCommandCount
  };
}

function formatExecutionMode(supportedCommands: string[] | undefined, supportedCommandCount: number): string {
  const normalized = new Set((supportedCommands ?? []).map((command) => command.toLowerCase()));
  if (normalized.has("tool.invoke") || normalized.has("exec.start")) {
    return "Confirmation required";
  }
  if (supportedCommandCount > 0) {
    return "Read-only protocol inspection";
  }
  return "Protocol commands unavailable";
}

function resolveExecutionContextSummary(raw: unknown, fallback: ExecutionContextSummary): ExecutionContextSummary {
  if (!isRecord(raw)) {
    return fallback;
  }

  const environmentWarning = readString(raw.environmentWarning);
  return {
    mode: readString(raw.mode) ?? fallback.mode,
    daemon: readString(raw.daemon) ?? fallback.daemon,
    sandbox: readString(raw.sandbox) ?? fallback.sandbox,
    execution: readString(raw.execution) ?? fallback.execution,
    canAccess: readStringArray(raw.canAccess) ?? fallback.canAccess,
    cannotAccess: readStringArray(raw.cannotAccess) ?? fallback.cannotAccess,
    ...(environmentWarning ? { environmentWarning } : {}),
    canAccessPersonalDesktop: typeof raw.canAccessPersonalDesktop === "boolean"
      ? raw.canAccessPersonalDesktop
      : fallback.canAccessPersonalDesktop,
    localDesktopDaemonReady: typeof raw.localDesktopDaemonReady === "boolean"
      ? raw.localDesktopDaemonReady
      : fallback.localDesktopDaemonReady,
    supportedCommandCount: readNumber(raw.supportedCommandCount) ?? fallback.supportedCommandCount
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
