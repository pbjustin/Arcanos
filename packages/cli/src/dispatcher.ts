import type {
  ContextInspectRequestPayload,
  ContextInspectResponseData,
  DaemonCapabilitiesResponseData,
  EnvironmentDescriptor,
  ExecResumeRequestPayload,
  ExecResumeResponseData,
  ExecStartRequestPayload,
  ExecStartResponseData,
  ExecStatusRequestPayload,
  ExecStatusResponseData,
  ProtocolRequest,
  ProtocolResponse,
  ToolDefinition,
  ToolRegistryRequestPayload,
  ToolRegistryResponseData
} from "@arcanos/protocol";
import { ARCANOS_PROTOCOL_VERSION } from "@arcanos/protocol";

export interface LocalDispatcherDependencies {
  now: () => Date;
  cwd: () => string;
  platform: NodeJS.Platform;
}

export interface ProtocolCommandDispatcher {
  dispatch(request: ProtocolRequest<unknown>): Promise<ProtocolResponse<unknown>>;
}

const DEFAULT_ALLOWED_CLIENTS = ["cli", "ide", "automation"] as const;
const DEFAULT_RUNTIME_CAPABILITIES = ["protocol-validation", "in-memory-execution"] as const;
const VALID_ENVIRONMENT_TYPES = ["workspace", "sandbox", "host", "remote"] as const;
const LOCAL_PROTOCOL_SCHEMA_ROOT = "embedded://packages/protocol/schemas/v1";
const LOCAL_TOOL_DEFINITIONS = [
  {
    id: "context.inspect",
    description: "Inspect the active protocol context and selected execution environment.",
    inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/context.inspect.request.schema.json",
    outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/context.inspect.response.schema.json",
    approvalRequired: false,
    allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
    scopes: ["context:read"],
    requiredCapabilities: ["protocol-validation"],
    preferredEnvironmentType: "workspace"
  },
  {
    id: "daemon.capabilities",
    description: "Report runtime capabilities, supported commands, and environment types for the local dispatcher.",
    inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/daemon.capabilities.request.schema.json",
    outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/daemon.capabilities.response.schema.json",
    approvalRequired: false,
    allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
    scopes: ["runtime:read"],
    requiredCapabilities: ["protocol-validation"],
    preferredEnvironmentType: "host"
  },
  {
    id: "exec.resume",
    description: "Advance a local execution scaffold with stdout, stderr, and terminal status updates.",
    inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/exec.resume.request.schema.json",
    outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/exec.resume.response.schema.json",
    approvalRequired: false,
    allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
    scopes: ["exec:resume"],
    requiredCapabilities: ["protocol-validation", "in-memory-execution"],
    preferredEnvironmentType: "workspace"
  },
  {
    id: "exec.start",
    description: "Queue an execution state scaffold for a task inside an explicit environment.",
    inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/exec.start.request.schema.json",
    outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/exec.start.response.schema.json",
    approvalRequired: true,
    allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
    scopes: ["exec:start"],
    requiredCapabilities: ["protocol-validation", "in-memory-execution"],
    preferredEnvironmentType: "workspace"
  },
  {
    id: "exec.status",
    description: "Inspect the current state of a queued or completed local execution scaffold.",
    inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/exec.status.request.schema.json",
    outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/exec.status.response.schema.json",
    approvalRequired: false,
    allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
    scopes: ["exec:read"],
    requiredCapabilities: ["protocol-validation", "in-memory-execution"],
    preferredEnvironmentType: "workspace"
  },
  {
    id: "tool.registry",
    description: "List declarative tool contracts exposed through the protocol.",
    inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.registry.request.schema.json",
    outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.registry.response.schema.json",
    approvalRequired: false,
    allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
    scopes: ["tools:read"],
    requiredCapabilities: ["protocol-validation"],
    preferredEnvironmentType: "workspace"
  }
] as const satisfies readonly ToolDefinition[];
type LocalSupportedCommand = (typeof LOCAL_TOOL_DEFINITIONS)[number]["id"];
type LocalCommandHandler = (
  request: ProtocolRequest<unknown>,
  startedAt: string
) => unknown;
type LocalCommandHandlerMap = Record<LocalSupportedCommand, LocalCommandHandler>;
const LOCAL_SUPPORTED_COMMANDS: LocalSupportedCommand[] = LOCAL_TOOL_DEFINITIONS.map(
  (tool) => tool.id
);

/**
 * Creates a local dispatcher for scaffolded protocol-visible commands.
 * Inputs: dependency providers for time, cwd, and platform information.
 * Outputs: async dispatcher that returns protocol responses in-process.
 * Edge cases: unsupported commands return a protocol error response instead of throwing so transports stay deterministic.
 */
export function createLocalProtocolDispatcher(dependencies: LocalDispatcherDependencies): ProtocolCommandDispatcher {
  const executionStates = new Map<string, ExecStartResponseData["state"]>();
  const commandHandlers: LocalCommandHandlerMap = {
    "context.inspect": (request, startedAt) => handleContextInspect(request, dependencies, startedAt),
    "daemon.capabilities": () => handleDaemonCapabilities(),
    "exec.resume": (request) => handleExecResume(request, dependencies, executionStates),
    "exec.start": (request, startedAt) => handleExecStart(request, dependencies, startedAt, executionStates),
    "exec.status": (request) => handleExecStatus(request, executionStates),
    "tool.registry": (request) => handleToolRegistry(request, dependencies)
  };
  assertLocalCommandAlignment(commandHandlers);

  return {
    async dispatch(request) {
      const startedAt = dependencies.now().toISOString();

      //audit assumption: only scaffolded commands should resolve locally. failure risk: callers may attempt unsupported commands before the daemon exists. invariant: unsupported commands produce protocol errors instead of partial state changes. handling: return an explicit unsupported-command response.
      try {
        const handler = commandHandlers[request.command as LocalSupportedCommand];
        if (!handler) {
          return createErrorResponse(
            request,
            "unsupported_command",
            `Command "${request.command}" is not implemented in the local CLI dispatcher.`,
            dependencies
          );
        }

        return createSuccessResponse(
          request,
          handler(request, startedAt),
          dependencies
        );
      } catch (error) {
        return createErrorResponse(
          request,
          "runtime_error",
          error instanceof Error ? error.message : String(error),
          dependencies
        );
      }
    }
  };
}

function handleContextInspect(
  request: ProtocolRequest<unknown>,
  dependencies: LocalDispatcherDependencies,
  _startedAt: string
): ContextInspectResponseData {
  const payload = (request.payload ?? {}) as ContextInspectRequestPayload;
  const environmentType = request.context?.environment ?? "workspace";
  const resolvedShell = request.context?.shell ?? resolveShellPath(dependencies.platform);
  const currentEnvironment: EnvironmentDescriptor = {
    type: normalizeEnvironmentType(environmentType),
    label: `${environmentType} environment`,
    cwd: request.context?.cwd ?? dependencies.cwd(),
    shell: resolvedShell,
    capabilities: [...DEFAULT_RUNTIME_CAPABILITIES]
  };

  const responseData: ContextInspectResponseData = {
    context: {
      sessionId: request.context?.sessionId,
      projectId: request.context?.projectId,
      environment: currentEnvironment.type,
      cwd: currentEnvironment.cwd,
      shell: currentEnvironment.shell
    },
    environment: currentEnvironment
  };

  //audit assumption: project metadata should only be emitted when explicitly requested. failure risk: callers may infer a project contract from placeholder data. invariant: project info is opt-in and deterministic. handling: gate placeholder project output behind the request payload flag.
  if (payload.includeProject) {
    responseData.project = {
      id: request.context?.projectId ?? "workspace-project",
      name: "Arcanos Workspace",
      rootPath: currentEnvironment.cwd
    };
  }

  //audit assumption: environment enumeration is static in the CLI scaffold. failure risk: clients may assume richer environment orchestration already exists. invariant: the list is explicit, typed, and obviously scaffold-level. handling: return the fixed environment set only when requested.
  if (payload.includeAvailableEnvironments) {
    responseData.availableEnvironments = buildAvailableEnvironments(currentEnvironment.cwd, resolvedShell);
  }

  return responseData;
}

function handleDaemonCapabilities(): DaemonCapabilitiesResponseData {
  return {
    protocolVersion: ARCANOS_PROTOCOL_VERSION,
    runtimeVersion: "0.1.0",
    supportedCommands: [...LOCAL_SUPPORTED_COMMANDS],
    supportedEnvironmentTypes: [...VALID_ENVIRONMENT_TYPES].sort(),
    schemaRoot: LOCAL_PROTOCOL_SCHEMA_ROOT,
    toolCount: LOCAL_TOOL_DEFINITIONS.length
  };
}

function assertLocalCommandAlignment(commandHandlers: LocalCommandHandlerMap): void {
  const handledCommands = Object.keys(commandHandlers);
  const duplicateAdvertisedCommands = LOCAL_SUPPORTED_COMMANDS.filter(
    (command, index) => LOCAL_SUPPORTED_COMMANDS.indexOf(command) !== index
  );
  const missingHandledCommands = LOCAL_SUPPORTED_COMMANDS.filter((command) => !handledCommands.includes(command));
  const unexpectedHandledCommands = handledCommands.filter(
    (command) => !LOCAL_SUPPORTED_COMMANDS.includes(command as LocalSupportedCommand)
  );

  if (
    duplicateAdvertisedCommands.length === 0
    && missingHandledCommands.length === 0
    && unexpectedHandledCommands.length === 0
  ) {
    return;
  }

  throw new Error(
    [
      "Local dispatcher command alignment is invalid.",
      duplicateAdvertisedCommands.length > 0
        ? `Duplicate advertised commands: ${[...new Set(duplicateAdvertisedCommands)].join(", ")}.`
        : null,
      missingHandledCommands.length > 0 ? `Missing handlers: ${missingHandledCommands.join(", ")}.` : null,
      unexpectedHandledCommands.length > 0 ? `Unexpected handlers: ${unexpectedHandledCommands.join(", ")}.` : null
    ].filter(Boolean).join(" ")
  );
}

function handleToolRegistry(
  request: ProtocolRequest<unknown>,
  _dependencies: LocalDispatcherDependencies
): ToolRegistryResponseData {
  const payload = (request.payload ?? {}) as ToolRegistryRequestPayload;
  const tools = buildToolDefinitions().filter((tool) => {
    //audit assumption: environment filtering is advisory for registry reads. failure risk: clients may receive tools that cannot execute in their current environment. invariant: filtered responses only include matching preferred environments when the caller asks for them. handling: apply an exact preferred-environment filter.
    if (payload.preferredEnvironmentType && tool.preferredEnvironmentType !== payload.preferredEnvironmentType) {
      return false;
    }

    //audit assumption: scope filters should be restrictive, not permissive. failure risk: callers may overestimate available permissions. invariant: every requested scope must be present on the tool definition. handling: require full scope inclusion for matches.
    if (payload.scopes && payload.scopes.length > 0) {
      return payload.scopes.every((scope) => tool.scopes.includes(scope));
    }

    return true;
  });

  return { tools };
}

function handleExecStart(
  request: ProtocolRequest<unknown>,
  dependencies: LocalDispatcherDependencies,
  startedAt: string,
  executionStates: Map<string, ExecStartResponseData["state"]>
): ExecStartResponseData {
  const payload = request.payload as ExecStartRequestPayload;
  const environmentType = request.context?.environment ?? payload.task.context?.environment ?? "workspace";
  const executionId = `exec-${request.requestId}`;

  const state: ExecStartResponseData["state"] = {
    executionId,
    command: payload.task.command,
    status: "queued",
    environment: {
      type: normalizeEnvironmentType(environmentType),
      label: `${environmentType} environment`,
      cwd: request.context?.cwd ?? payload.task.context?.cwd ?? dependencies.cwd(),
      shell: request.context?.shell ?? payload.task.context?.shell ?? resolveShellPath(dependencies.platform),
      capabilities: [...DEFAULT_RUNTIME_CAPABILITIES]
    },
    runResult: {
      status: "queued",
      exitCode: null,
      stdout: "",
      stderr: "",
      startedAt
    },
    artifacts: [],
    createdAt: startedAt,
    updatedAt: startedAt
  };
  executionStates.set(executionId, structuredClone(state));

  return { state };
}

function handleExecStatus(
  request: ProtocolRequest<unknown>,
  executionStates: Map<string, ExecStartResponseData["state"]>
): ExecStatusResponseData {
  const payload = request.payload as ExecStatusRequestPayload;
  const state = executionStates.get(payload.executionId);
  if (!state) {
    throw new Error(`Execution "${payload.executionId}" was not found.`);
  }

  return { state: structuredClone(state) };
}

function handleExecResume(
  request: ProtocolRequest<unknown>,
  dependencies: LocalDispatcherDependencies,
  executionStates: Map<string, ExecStartResponseData["state"]>
): ExecResumeResponseData {
  const payload = request.payload as ExecResumeRequestPayload;
  const existingState = executionStates.get(payload.executionId);
  if (!existingState) {
    throw new Error(`Execution "${payload.executionId}" was not found.`);
  }

  const updatedAt = dependencies.now().toISOString();
  const stdoutAppend = payload.stdoutAppend ?? "";
  const stderrAppend = payload.stderrAppend ?? "";
  const state: ExecStartResponseData["state"] = {
    ...structuredClone(existingState),
    status: payload.status,
    updatedAt,
    artifacts: payload.artifacts
      ? [...(existingState.artifacts ?? []), ...payload.artifacts]
      : [...(existingState.artifacts ?? [])],
    runResult: {
      status: payload.status,
      exitCode: payload.exitCode ?? existingState.runResult?.exitCode ?? null,
      stdout: `${existingState.runResult?.stdout ?? ""}${stdoutAppend}`,
      stderr: `${existingState.runResult?.stderr ?? ""}${stderrAppend}`,
      startedAt: existingState.runResult?.startedAt ?? updatedAt,
      finishedAt:
        payload.finishedAt
        ?? (payload.status === "completed" || payload.status === "failed" ? updatedAt : existingState.runResult?.finishedAt)
    }
  };

  executionStates.set(payload.executionId, structuredClone(state));
  return { state };
}

function createSuccessResponse<TData>(
  request: ProtocolRequest<unknown>,
  data: TData,
  dependencies: LocalDispatcherDependencies
): ProtocolResponse<TData> {
  return {
    protocol: ARCANOS_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    data,
    meta: {
      version: "0.1.0",
      executedBy: `local-cli-${dependencies.platform}`,
      timingMs: 0
    }
  };
}

function createErrorResponse(
  request: ProtocolRequest<unknown>,
  code: string,
  message: string,
  dependencies: LocalDispatcherDependencies
): ProtocolResponse<never> {
  return {
    protocol: ARCANOS_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: false,
    error: {
      code,
      message,
      retryable: false
    },
    meta: {
      version: "0.1.0",
      executedBy: `local-cli-${dependencies.platform}`,
      timingMs: 0
    }
  };
}

function buildAvailableEnvironments(cwd: string | undefined, shell: string | undefined): EnvironmentDescriptor[] {
  return [
    { type: "workspace", label: "Workspace", cwd, shell, capabilities: [...DEFAULT_RUNTIME_CAPABILITIES] },
    { type: "sandbox", label: "Sandbox", cwd, shell, capabilities: ["protocol-validation"] },
    { type: "host", label: "Host", cwd, shell, capabilities: ["protocol-validation"] },
    { type: "remote", label: "Remote", capabilities: ["protocol-validation"] }
  ];
}

function buildToolDefinitions(): ToolDefinition[] {
  return LOCAL_TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    allowedClients: [...tool.allowedClients],
    scopes: [...tool.scopes],
    requiredCapabilities: [...tool.requiredCapabilities]
  }));
}

function normalizeEnvironmentType(environmentType: string): EnvironmentDescriptor["type"] {
  return VALID_ENVIRONMENT_TYPES.includes(environmentType as EnvironmentDescriptor["type"])
    ? (environmentType as EnvironmentDescriptor["type"])
    : "workspace";
}

function resolveShellPath(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return process.env.ComSpec ?? "unknown";
  }

  return process.env.SHELL ?? process.env.ComSpec ?? "unknown";
}
