import type {
  ContextInspectRequestPayload,
  ContextInspectResponseData,
  EnvironmentDescriptor,
  ExecResumeRequestPayload,
  ExecResumeResponseData,
  ExecStartRequestPayload,
  ExecStartResponseData,
  ExecStatusRequestPayload,
  ExecStatusResponseData,
  ImplementedProtocolCommandId,
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

/**
 * Creates a local dispatcher for scaffolded protocol-visible commands.
 * Inputs: dependency providers for time, cwd, and platform information.
 * Outputs: async dispatcher that returns protocol responses in-process.
 * Edge cases: unsupported commands return a protocol error response instead of throwing so transports stay deterministic.
 */
export function createLocalProtocolDispatcher(dependencies: LocalDispatcherDependencies): ProtocolCommandDispatcher {
  const executionStates = new Map<string, ExecStartResponseData["state"]>();

  return {
    async dispatch(request) {
      const startedAt = dependencies.now().toISOString();

      //audit assumption: only scaffolded commands should resolve locally. failure risk: callers may attempt unsupported commands before the daemon exists. invariant: unsupported commands produce protocol errors instead of partial state changes. handling: return an explicit unsupported-command response.
      try {
        switch (request.command as ImplementedProtocolCommandId) {
          case "context.inspect":
            return createSuccessResponse(
              request,
              handleContextInspect(request, dependencies, startedAt),
              dependencies
            );
          case "tool.registry":
            return createSuccessResponse(
              request,
              handleToolRegistry(request, dependencies),
              dependencies
            );
          case "exec.start":
            return createSuccessResponse(
              request,
              handleExecStart(request, dependencies, startedAt, executionStates),
              dependencies
            );
          case "exec.resume":
            return createSuccessResponse(
              request,
              handleExecResume(request, dependencies, executionStates),
              dependencies
            );
          case "exec.status":
            return createSuccessResponse(
              request,
              handleExecStatus(request, executionStates),
              dependencies
            );
          default:
            return createErrorResponse(
              request,
              "unsupported_command",
              `Command "${request.command}" is not implemented in the local CLI dispatcher.`,
              dependencies
            );
        }
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
  const currentEnvironment: EnvironmentDescriptor = {
    type: normalizeEnvironmentType(environmentType),
    label: `${environmentType} environment`,
    cwd: request.context?.cwd ?? dependencies.cwd(),
    shell: request.context?.shell ?? process.env.ComSpec ?? "unknown",
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
    responseData.availableEnvironments = buildAvailableEnvironments(currentEnvironment.cwd, currentEnvironment.shell);
  }

  return responseData;
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
      shell: request.context?.shell ?? payload.task.context?.shell ?? process.env.ComSpec ?? "unknown",
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
  return [
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
      id: "tool.registry",
      description: "List declarative tool contracts exposed through the protocol.",
      inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.registry.request.schema.json",
      outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.registry.response.schema.json",
      approvalRequired: false,
      allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
      scopes: ["tools:read"],
      requiredCapabilities: ["protocol-validation"],
      preferredEnvironmentType: "workspace"
    },
    {
      id: "tool.describe",
      description: "Describe a registered protocol-visible tool and its shared schemas.",
      inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.describe.request.schema.json",
      outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.describe.response.schema.json",
      approvalRequired: false,
      allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
      scopes: ["tools:read"],
      requiredCapabilities: ["protocol-validation"],
      preferredEnvironmentType: "workspace"
    },
    {
      id: "tool.invoke",
      description: "Invoke a daemon tool using shared input and output schemas.",
      inputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.invoke.request.schema.json",
      outputSchemaId: "https://schemas.arcanos.dev/protocol/v1/commands/tool.invoke.response.schema.json",
      approvalRequired: false,
      allowedClients: [...DEFAULT_ALLOWED_CLIENTS],
      scopes: ["tools:invoke"],
      requiredCapabilities: ["protocol-validation"],
      preferredEnvironmentType: "remote"
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
    }
  ];
}

function normalizeEnvironmentType(environmentType: string): EnvironmentDescriptor["type"] {
  return VALID_ENVIRONMENT_TYPES.includes(environmentType as EnvironmentDescriptor["type"])
    ? (environmentType as EnvironmentDescriptor["type"])
    : "workspace";
}
