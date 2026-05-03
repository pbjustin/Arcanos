import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { logExecution } from '@core/db/repositories/executionLogRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { generateRequestId } from '@shared/idGenerator.js';
import { redactSensitive, redactString } from '@shared/redaction.js';
import { arcanosMcpService } from '@services/arcanosMcp.js';

import { assertValidControlPlaneResponse } from './schemas.js';
import { verifyControlPlaneRoute } from './routeVerification.js';
import type {
  ControlPlaneAdapter,
  ControlPlaneApprovalMetadata,
  ControlPlaneCommandPreview,
  ControlPlaneMcpClient,
  ControlPlanePhase,
  ControlPlaneProcessResult,
  ControlPlaneProcessRunner,
  ControlPlaneRequestPayload,
  ControlPlaneServiceResponse as ControlPlaneResponse,
  ControlPlaneResult,
  ControlPlaneTrinityPlanner
} from './types.js';

type OperationKind = 'process' | 'mcp';

interface ControlPlaneOperationDefinition {
  adapter: ControlPlaneAdapter;
  operation: string;
  description: string;
  kind: OperationKind;
  allowedPhases: ControlPlanePhase[];
  requiresApproval: boolean;
  scopes: string[];
  buildProcessCommand?: (
    input: Record<string, unknown>,
    cwd: string,
    repositoryRoot: string
  ) => ControlPlaneCommandPreview;
}

export interface ControlPlaneServiceDependencies {
  processRunner?: ControlPlaneProcessRunner;
  mcpClient?: ControlPlaneMcpClient;
  trinityPlanner?: ControlPlaneTrinityPlanner;
  repositoryRoot?: string;
  now?: () => Date;
  auditLogger?: typeof logExecution;
}

interface OperationResolution {
  definition: ControlPlaneOperationDefinition;
  command?: ControlPlaneCommandPreview;
}

const execFileAsync = promisify(execFile);
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_OUTPUT_CHARS = 20_000;
const READ_ONLY_MCP_TOOLS = new Set([
  'agents.get',
  'agents.list',
  'dag.capabilities',
  'dag.run.errors',
  'dag.run.events',
  'dag.run.get',
  'dag.run.latest',
  'dag.run.lineage',
  'dag.run.metrics',
  'dag.run.node',
  'dag.run.trace',
  'dag.run.tree',
  'dag.run.verification',
  'jobs.result',
  'jobs.status',
  'memory.list',
  'memory.load',
  'modules.list',
  'ops.control_plane_capabilities',
  'ops.health_report',
  'plans.get',
  'plans.list',
  'plans.results',
  'rag.query'
]);
const MUTATING_MCP_TOOLS = new Set([
  'agents.heartbeat',
  'agents.register',
  'dag.run.cancel',
  'dag.run.create',
  'memory.save',
  'modules.invoke',
  'plans.approve',
  'plans.create',
  'rag.ingest_content',
  'rag.ingest_url',
  'research.run'
]);
const CONTROL_PLANE_MCP_TOOLS = new Set([
  ...READ_ONLY_MCP_TOOLS,
  ...MUTATING_MCP_TOOLS
]);

const operationDefinitions: ControlPlaneOperationDefinition[] = [
  {
    adapter: 'railway-cli',
    operation: 'status',
    description: 'Read Railway CLI project status.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['railway:read'],
    buildProcessCommand: (_input, cwd) => ({
      executable: resolveRailwayExecutable(),
      args: ['status'],
      cwd
    })
  },
  {
    adapter: 'railway-cli',
    operation: 'whoami',
    description: 'Read the authenticated Railway CLI identity.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['railway:read'],
    buildProcessCommand: (_input, cwd) => ({
      executable: resolveRailwayExecutable(),
      args: ['whoami'],
      cwd
    })
  },
  {
    adapter: 'railway-cli',
    operation: 'logs',
    description: 'Read recent Railway CLI logs.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['railway:read'],
    buildProcessCommand: (_input, cwd) => ({
      executable: resolveRailwayExecutable(),
      args: ['logs'],
      cwd
    })
  },
  {
    adapter: 'railway-cli',
    operation: 'deploy',
    description: 'Deploy the current project through `railway up --detach`.',
    kind: 'process',
    allowedPhases: ['plan', 'mutate'],
    requiresApproval: true,
    scopes: ['railway:deploy'],
    buildProcessCommand: (_input, cwd) => ({
      executable: resolveRailwayExecutable(),
      args: ['up', '--detach'],
      cwd
    })
  },
  {
    adapter: 'arcanos-cli',
    operation: 'status',
    description: 'Read ARCANOS CLI backend status.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['arcanos:read'],
    buildProcessCommand: (_input, cwd, repositoryRoot) => buildArcanosCliCommand(['status', '--json'], cwd, repositoryRoot)
  },
  {
    adapter: 'arcanos-cli',
    operation: 'workers',
    description: 'Read ARCANOS worker status through the CLI.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['arcanos:read'],
    buildProcessCommand: (_input, cwd, repositoryRoot) => buildArcanosCliCommand(['workers', '--json'], cwd, repositoryRoot)
  },
  {
    adapter: 'arcanos-cli',
    operation: 'logs.recent',
    description: 'Read recent ARCANOS logs through the CLI.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['arcanos:read'],
    buildProcessCommand: (_input, cwd, repositoryRoot) => buildArcanosCliCommand(['logs', '--recent', '--json'], cwd, repositoryRoot)
  },
  {
    adapter: 'arcanos-cli',
    operation: 'inspect.self_heal',
    description: 'Inspect ARCANOS self-heal state through the CLI.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['arcanos:read'],
    buildProcessCommand: (_input, cwd, repositoryRoot) => buildArcanosCliCommand(['inspect', 'self-heal', '--json'], cwd, repositoryRoot)
  },
  {
    adapter: 'arcanos-cli',
    operation: 'doctor.implementation',
    description: 'Run the ARCANOS implementation doctor through the CLI.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['arcanos:read', 'repo:read'],
    buildProcessCommand: (_input, cwd, repositoryRoot) => buildArcanosCliCommand(['doctor', 'implementation', '--json'], cwd, repositoryRoot)
  },
  {
    adapter: 'arcanos-cli',
    operation: 'protocol.capabilities',
    description: 'Read ARCANOS protocol daemon capabilities through the CLI local transport.',
    kind: 'process',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['arcanos:read', 'protocol:read'],
    buildProcessCommand: (_input, cwd, repositoryRoot) => buildArcanosCliCommand([
      'protocol',
      'daemon.capabilities',
      '--payload-json',
      '{}',
      '--transport',
      'local'
    ], cwd, repositoryRoot)
  },
  {
    adapter: 'arcanos-mcp',
    operation: 'listTools',
    description: 'List tools exposed by the in-process ARCANOS MCP server.',
    kind: 'mcp',
    allowedPhases: ['plan', 'execute'],
    requiresApproval: false,
    scopes: ['mcp:read']
  },
  {
    adapter: 'arcanos-mcp',
    operation: 'invokeTool',
    description: 'Invoke one allowlisted ARCANOS MCP server tool.',
    kind: 'mcp',
    allowedPhases: ['plan', 'execute', 'mutate'],
    requiresApproval: false,
    scopes: ['mcp:invoke']
  }
];

const operationDefinitionsByKey = new Map(
  operationDefinitions.map((definition) => [
    buildOperationKey(definition.adapter, definition.operation),
    definition
  ])
);

const defaultProcessRunner: ControlPlaneProcessRunner = {
  async run(executable, args, options) {
    try {
      const result = await execFileAsync(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: 2 * 1024 * 1024
      });

      return {
        exitCode: 0,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? '')
      };
    } catch (error) {
      const processError = error as {
        code?: number | string;
        signal?: string | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      const stderr = String(processError.stderr ?? '');
      return {
        exitCode: typeof processError.code === 'number' ? processError.code : 1,
        signal: processError.signal ?? null,
        stdout: String(processError.stdout ?? ''),
        stderr: stderr.trim().length > 0 ? stderr : resolveErrorMessage(error)
      };
    }
  }
};

const defaultMcpClient: ControlPlaneMcpClient = {
  listTools: (options) => arcanosMcpService.listTools(options),
  invokeTool: (options) => arcanosMcpService.invokeTool(options)
};

function buildOperationKey(adapter: ControlPlaneAdapter, operation: string): string {
  return `${adapter}:${operation}`;
}

function resolveRailwayExecutable(): string {
  return process.env.RAILWAY_CLI_BIN?.trim() || 'railway';
}

function buildArcanosCliCommand(args: string[], cwd: string, repositoryRoot: string): ControlPlaneCommandPreview {
  const configuredCli = process.env.ARCANOS_CLI_BIN?.trim();
  if (configuredCli) {
    return {
      executable: configuredCli,
      args,
      cwd
    };
  }

  const distEntrypoint = path.join(repositoryRoot, 'packages', 'cli', 'dist', 'index.js');
  if (fs.existsSync(distEntrypoint)) {
    return {
      executable: process.execPath,
      args: [distEntrypoint, ...args],
      cwd
    };
  }

  return {
    executable: 'arcanos',
    args,
    cwd
  };
}

function resolveRepositoryRoot(configuredRoot?: string): string {
  return path.resolve(configuredRoot ?? process.cwd());
}

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRequestCwd(request: ControlPlaneRequestPayload, repositoryRoot: string): string {
  const requestedCwdRaw = request.context?.cwd;
  const requestedCwd = requestedCwdRaw
    ? path.resolve(path.isAbsolute(requestedCwdRaw) ? requestedCwdRaw : path.join(repositoryRoot, requestedCwdRaw))
    : repositoryRoot;

  if (!isPathInsideOrEqual(repositoryRoot, requestedCwd)) {
    throw buildControlPlaneError(
      'CWD_OUTSIDE_WORKSPACE',
      'Control-plane cwd must stay inside the active workspace.',
      {
        repositoryRoot,
        requestedCwd
      }
    );
  }

  return requestedCwd;
}

function buildLeastPrivilegeEnv(adapter: ControlPlaneAdapter, repositoryRoot: string): NodeJS.ProcessEnv {
  const commonKeys = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'ComSpec',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP'
  ];
  const adapterKeys = adapter === 'railway-cli'
    ? [
        'RAILWAY_TOKEN',
        'RAILWAY_API_TOKEN',
        'RAILWAY_PROJECT_ID',
        'RAILWAY_ENVIRONMENT_ID',
        'RAILWAY_SERVICE_ID',
        'RAILWAY_ENVIRONMENT'
      ]
    : [
        'ARCANOS_BACKEND_URL',
        'ARCANOS_REPOSITORY_ROOT',
        'ARCANOS_WORKSPACE_ROOT',
        'ARCANOS_PYTHON_RUNTIME_DIR',
        'RAILWAY_PUBLIC_DOMAIN',
        'PYTHON'
      ];
  const allowedEnv: NodeJS.ProcessEnv = {};

  for (const key of [...commonKeys, ...adapterKeys]) {
    if (process.env[key] !== undefined) {
      allowedEnv[key] = process.env[key];
    }
  }

  if (adapter === 'railway-cli' && allowedEnv.RAILWAY_TOKEN === undefined && allowedEnv.RAILWAY_API_TOKEN !== undefined) {
    allowedEnv.RAILWAY_TOKEN = allowedEnv.RAILWAY_API_TOKEN;
  }
  if (adapter === 'arcanos-cli' && allowedEnv.ARCANOS_BACKEND_URL === undefined && allowedEnv.RAILWAY_PUBLIC_DOMAIN !== undefined) {
    const domain = allowedEnv.RAILWAY_PUBLIC_DOMAIN.trim();
    if (domain.length > 0) {
      allowedEnv.ARCANOS_BACKEND_URL = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
    }
  }

  allowedEnv.ARCANOS_REPOSITORY_ROOT = allowedEnv.ARCANOS_REPOSITORY_ROOT ?? repositoryRoot;
  allowedEnv.ARCANOS_WORKSPACE_ROOT = allowedEnv.ARCANOS_WORKSPACE_ROOT ?? repositoryRoot;

  return allowedEnv;
}

function sanitizeTextOutput(value: string): string {
  const truncated = value.slice(0, MAX_CAPTURED_OUTPUT_CHARS);
  return redactString(truncated);
}

function getApprovalRequirement(
  request: ControlPlaneRequestPayload,
  definition: ControlPlaneOperationDefinition,
  mcpToolRequiresApproval: boolean
): ControlPlaneApprovalMetadata {
  const required =
    request.phase !== 'plan'
    && (request.phase === 'mutate' || definition.requiresApproval || mcpToolRequiresApproval);
  if (!required) {
    return {
      required: false,
      satisfied: true,
      gate: 'none'
    };
  }

  const approval = request.approval;
  const satisfied = approval?.approved === true
    && typeof approval.approvedBy === 'string'
    && approval.approvedBy.trim().length > 0
    && typeof approval.reason === 'string'
    && approval.reason.trim().length > 0;

  return {
    required,
    satisfied,
    gate: 'control-plane-approval',
    reason: satisfied
      ? approval?.reason
      : 'Mutating or approval-gated control-plane operations require approval.approved, approval.approvedBy, and approval.reason.'
  };
}

function buildControlPlaneError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): Error & { code: string; details?: Record<string, unknown> } {
  const error = new Error(message) as Error & {
    code: string;
    details?: Record<string, unknown>;
  };
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function isControlPlaneError(error: unknown): error is Error & { code: string; details?: Record<string, unknown> } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

function resolveOperationDefinition(request: ControlPlaneRequestPayload): ControlPlaneOperationDefinition {
  const definition = operationDefinitionsByKey.get(buildOperationKey(request.adapter, request.operation));
  if (!definition) {
    throw buildControlPlaneError('UNSUPPORTED_CONTROL_PLANE_OPERATION', 'Control-plane operation is not allowlisted.', {
      adapter: request.adapter,
      operation: request.operation,
      supportedOperations: operationDefinitions
        .filter((candidate) => candidate.adapter === request.adapter)
        .map((candidate) => candidate.operation)
        .sort()
    });
  }

  if (!definition.allowedPhases.includes(request.phase)) {
    throw buildControlPlaneError('CONTROL_PLANE_PHASE_NOT_ALLOWED', 'Operation is not allowed in the requested phase.', {
      adapter: request.adapter,
      operation: request.operation,
      phase: request.phase,
      allowedPhases: definition.allowedPhases
    });
  }

  return definition;
}

function resolveOperation(request: ControlPlaneRequestPayload, cwd: string, repositoryRoot: string): OperationResolution {
  const definition = resolveOperationDefinition(request);

  return {
    definition,
    command: definition.buildProcessCommand?.(request.input ?? {}, cwd, repositoryRoot)
  };
}

function readMcpToolName(input: Record<string, unknown>): string {
  const toolName = input.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    throw buildControlPlaneError('MCP_TOOL_NAME_REQUIRED', 'MCP invokeTool requires input.toolName.');
  }

  return toolName.trim();
}

function resolveMcpToolApproval(input: Record<string, unknown>): boolean {
  const toolName = readMcpToolName(input);
  if (READ_ONLY_MCP_TOOLS.has(toolName)) {
    return false;
  }
  if (MUTATING_MCP_TOOLS.has(toolName)) {
    return true;
  }

  throw buildControlPlaneError('MCP_TOOL_NOT_ALLOWLISTED', 'MCP tool is not allowlisted for control-plane invocation.', {
    toolName,
    readOnlyTools: Array.from(READ_ONLY_MCP_TOOLS).sort(),
    mutatingTools: Array.from(MUTATING_MCP_TOOLS).sort()
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function filterMcpToolList(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.tools)) {
    return data;
  }

  return {
    ...data,
    tools: data.tools.filter((tool) => (
      isRecord(tool)
      && typeof tool.name === 'string'
      && CONTROL_PLANE_MCP_TOOLS.has(tool.name)
    ))
  };
}

async function invokeMcpOperation(
  request: ControlPlaneRequestPayload & { requestId: string },
  mcpClient: ControlPlaneMcpClient
): Promise<ControlPlaneResult> {
  if (request.operation === 'listTools') {
    const data = await mcpClient.listTools({
      sessionId: request.context?.sessionId
    });
    return {
      status: 'completed',
      adapter: request.adapter,
      operation: request.operation,
      data: redactSensitive(filterMcpToolList(data))
    };
  }

  const input = request.input ?? {};
  const toolName = readMcpToolName(input);
  const toolArguments = input.toolArguments;
  const data = await mcpClient.invokeTool({
    toolName,
    toolArguments: typeof toolArguments === 'object' && toolArguments !== null && !Array.isArray(toolArguments)
      ? toolArguments as Record<string, unknown>
      : {},
    sessionId: request.context?.sessionId
  });

  return {
    status: 'completed',
    adapter: request.adapter,
    operation: request.operation,
    data: redactSensitive(data)
  };
}

async function invokeProcessOperation(
  request: ControlPlaneRequestPayload & { requestId: string },
  command: ControlPlaneCommandPreview,
  processRunner: ControlPlaneProcessRunner,
  repositoryRoot: string
): Promise<ControlPlaneResult> {
  const processResult: ControlPlaneProcessResult = await processRunner.run(
    command.executable,
    command.args,
    {
      cwd: command.cwd,
      env: buildLeastPrivilegeEnv(request.adapter, repositoryRoot),
      timeoutMs: DEFAULT_PROCESS_TIMEOUT_MS
    }
  );

  return {
    status: 'completed',
    adapter: request.adapter,
    operation: request.operation,
    command,
    exitCode: processResult.exitCode,
    ...(processResult.signal !== undefined ? { signal: processResult.signal } : {}),
    stdout: sanitizeTextOutput(processResult.stdout),
    stderr: sanitizeTextOutput(processResult.stderr)
  };
}

function buildPlannedResult(
  request: ControlPlaneRequestPayload,
  command: ControlPlaneCommandPreview | undefined
): ControlPlaneResult {
  return {
    status: 'planned',
    adapter: request.adapter,
    operation: request.operation,
    ...(command ? { command } : {}),
    data: {
      willExecute: request.phase !== 'plan',
      inputKeys: Object.keys(request.input ?? {}).sort()
    }
  };
}

async function emitControlPlaneAudit(
  event: string,
  level: 'info' | 'warn' | 'error',
  metadata: Record<string, unknown>,
  auditLogger: typeof logExecution
): Promise<boolean> {
  try {
    await auditLogger('control-plane', level, event, redactSensitive(metadata) as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

function getResponseStatusFromProcessResult(result: ControlPlaneResult): boolean {
  if (result.signal !== undefined && result.signal !== null && result.signal !== '') {
    return false;
  }
  return result.exitCode === undefined || result.exitCode === 0;
}

function buildFailureResponse(params: {
  request: ControlPlaneRequestPayload & { requestId: string };
  error: unknown;
  approval: ControlPlaneApprovalMetadata;
  auditId: string;
  auditLogged: boolean;
  routeMetadata?: ControlPlaneResponse['route'];
}): ControlPlaneResponse {
  const route = params.routeMetadata ?? verifyControlPlaneRoute({
    request: params.request,
    trinityUnavailable: true,
    trinityError: 'Control-plane request failed before route metadata could be collected.'
  });
  const code = isControlPlaneError(params.error) ? params.error.code : 'CONTROL_PLANE_FAILED';
  const details = isControlPlaneError(params.error) ? params.error.details : undefined;

  return assertValidControlPlaneResponse({
    ok: false,
    requestId: params.request.requestId,
    phase: params.request.phase,
    adapter: params.request.adapter,
    operation: params.request.operation,
    route,
    approval: params.approval,
    audit: {
      auditId: params.auditId,
      logged: params.auditLogged
    },
    error: {
      code,
      message: redactString(resolveErrorMessage(params.error)),
      ...(details ? { details: redactSensitive(details) as Record<string, unknown> } : {})
    }
  });
}

export function getControlPlaneCapabilities(): {
  operations: Array<Omit<ControlPlaneOperationDefinition, 'buildProcessCommand'>>;
  mcpTools: {
    readOnly: string[];
    mutating: string[];
  };
  routeStatuses: string[];
} {
  return {
    operations: operationDefinitions
      .map(({ buildProcessCommand: _buildProcessCommand, ...definition }) => definition)
      .sort((left, right) => buildOperationKey(left.adapter, left.operation)
        .localeCompare(buildOperationKey(right.adapter, right.operation))),
    mcpTools: {
      readOnly: Array.from(READ_ONLY_MCP_TOOLS).sort(),
      mutating: Array.from(MUTATING_MCP_TOOLS).sort()
    },
    routeStatuses: [
      'TRINITY_CONFIRMED',
      'TRINITY_UNAVAILABLE',
      'TRINITY_REQUESTED_BUT_NOT_CONFIRMED',
      'DIRECT_FAST_PATH',
      'UNKNOWN_ROUTE'
    ]
  };
}

export function requiresControlPlaneApproval(payload: ControlPlaneRequestPayload): boolean {
  try {
    const definition = resolveOperationDefinition(payload);
    const mcpToolRequiresApproval =
      payload.adapter === 'arcanos-mcp' && payload.operation === 'invokeTool'
        ? resolveMcpToolApproval(payload.input ?? {})
        : false;
    return getApprovalRequirement(payload, definition, mcpToolRequiresApproval).required;
  } catch {
    return false;
  }
}

export async function executeControlPlaneRequest(
  payload: ControlPlaneRequestPayload,
  dependencies: ControlPlaneServiceDependencies = {}
): Promise<ControlPlaneResponse> {
  const request: ControlPlaneRequestPayload & { requestId: string } = {
    ...payload,
    requestId: payload.requestId?.trim() || generateRequestId('control')
  };
  const now = dependencies.now ?? (() => new Date());
  const repositoryRoot = resolveRepositoryRoot(dependencies.repositoryRoot);
  const processRunner = dependencies.processRunner ?? defaultProcessRunner;
  const mcpClient = dependencies.mcpClient ?? defaultMcpClient;
  const auditLogger = dependencies.auditLogger ?? logExecution;
  const auditId = generateRequestId('control_audit');
  let auditLogged = false;
  let approval: ControlPlaneApprovalMetadata = {
    required: false,
    satisfied: true,
    gate: 'none'
  };

  try {
    const cwd = resolveRequestCwd(request, repositoryRoot);
    const resolution = resolveOperation(request, cwd, repositoryRoot);
    const mcpToolRequiresApproval =
      request.adapter === 'arcanos-mcp' && request.operation === 'invokeTool'
        ? resolveMcpToolApproval(request.input ?? {})
        : false;
    approval = getApprovalRequirement(request, resolution.definition, mcpToolRequiresApproval);

    auditLogged = await emitControlPlaneAudit('control_plane.request.start', 'info', {
      auditId,
      requestId: request.requestId,
      adapter: request.adapter,
      operation: request.operation,
      phase: request.phase,
      approvalRequired: approval.required,
      inputKeys: Object.keys(request.input ?? {}).sort(),
      cwd
    }, auditLogger);

    const route = verifyControlPlaneRoute({
      request,
      now
    });

    if (!approval.satisfied) {
      const response = buildFailureResponse({
        request,
        error: buildControlPlaneError('CONTROL_PLANE_APPROVAL_REQUIRED', approval.reason ?? 'Approval required.'),
        approval,
        auditId,
        auditLogged,
        routeMetadata: route
      });
      await emitControlPlaneAudit('control_plane.request.blocked', 'warn', {
        auditId,
        requestId: request.requestId,
        adapter: request.adapter,
        operation: request.operation,
        phase: request.phase,
        routeStatus: route.status,
        reason: response.error?.message
      }, auditLogger);
      return response;
    }

    const result = request.phase === 'plan'
      ? buildPlannedResult(request, resolution.command)
      : resolution.definition.kind === 'mcp'
        ? await invokeMcpOperation(request, mcpClient)
        : await invokeProcessOperation(request, resolution.command as ControlPlaneCommandPreview, processRunner, repositoryRoot);
    const ok = getResponseStatusFromProcessResult(result);
    const response = assertValidControlPlaneResponse({
      ok,
      requestId: request.requestId,
      phase: request.phase,
      adapter: request.adapter,
      operation: request.operation,
      route,
      approval,
      audit: {
        auditId,
        logged: auditLogged
      },
      result,
      ...(ok
        ? {}
        : {
            error: {
              code: 'CONTROL_PLANE_ADAPTER_FAILED',
              message: 'Control-plane adapter command exited unsuccessfully.',
              details: {
                exitCode: result.exitCode ?? null,
                ...(result.signal !== undefined ? { signal: result.signal } : {})
              }
            }
          })
    });

    await emitControlPlaneAudit(ok ? 'control_plane.request.completed' : 'control_plane.request.failed', ok ? 'info' : 'warn', {
      auditId,
      requestId: request.requestId,
      adapter: request.adapter,
      operation: request.operation,
      phase: request.phase,
      routeStatus: route.status,
      ok,
      exitCode: result.exitCode ?? null
    }, auditLogger);

    return response;
  } catch (error) {
    auditLogged = auditLogged || await emitControlPlaneAudit('control_plane.request.failed', 'error', {
      auditId,
      requestId: request.requestId,
      adapter: request.adapter,
      operation: request.operation,
      phase: request.phase,
      error: resolveErrorMessage(error)
    }, auditLogger);

    return buildFailureResponse({
      request,
      error,
      approval,
      auditId,
      auditLogged
    });
  }
}
