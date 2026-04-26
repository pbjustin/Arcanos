import type {
  ControlPlaneAllowlistView,
  ControlPlaneCommandPlan,
  ControlPlaneOperationSpec,
  ControlPlaneProvider,
  ControlPlaneRequest,
} from './types.js';

const CONTROL_PLANE_COMMAND_TIMEOUT_MS = 20_000;
const CONTROL_PLANE_COMMAND_MAX_BUFFER_BYTES = 512 * 1024;
const SAFE_INSPECT_TARGETS = new Set(['self-heal', 'runtime', 'health', 'mcp', 'agents']);

function executableName(baseName: string): string {
  return process.platform === 'win32' ? `${baseName}.cmd` : baseName;
}

function commandPlan(executable: string, args: string[], timeoutMs = CONTROL_PLANE_COMMAND_TIMEOUT_MS): ControlPlaneCommandPlan {
  return {
    executable,
    args,
    displayCommand: [executable, ...args].join(' '),
    timeoutMs,
    maxBufferBytes: CONTROL_PLANE_COMMAND_MAX_BUFFER_BYTES,
  };
}

function requireSafeInspectTarget(request: ControlPlaneRequest): string {
  const candidate =
    typeof request.params.subject === 'string'
      ? request.params.subject.trim()
      : request.target.resource.trim();
  if (!SAFE_INSPECT_TARGETS.has(candidate)) {
    throw new Error(`arcanos.inspect target "${candidate}" is not allowlisted.`);
  }
  return candidate;
}

function resolveMcpToolName(request: ControlPlaneRequest): string {
  const toolName = typeof request.params.toolName === 'string'
    ? request.params.toolName.trim()
    : request.target.resource.trim();
  if (!ALLOWED_MCP_READ_TOOLS.has(toolName)) {
    throw new Error(`MCP tool "${toolName}" is not allowlisted for control-plane invocation.`);
  }
  return toolName;
}

function resolveMcpToolArguments(request: ControlPlaneRequest): Record<string, unknown> {
  const toolArguments = request.params.toolArguments;
  if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
    return {};
  }
  return toolArguments as Record<string, unknown>;
}

export const ALLOWED_MCP_READ_TOOLS = new Set([
  'jobs.status',
  'jobs.result',
  'plans.list',
  'plans.get',
  'dag.capabilities',
  'dag.run.latest',
  'dag.run.get',
  'dag.run.wait',
  'dag.run.trace',
  'dag.run.tree',
  'dag.run.node',
  'dag.run.events',
  'dag.run.metrics',
  'dag.run.errors',
  'dag.run.lineage',
  'dag.run.verification',
  'memory.load',
  'memory.list',
  'modules.list',
  'ops.health_report',
  'agents.list',
  'rag.query',
]);

export const CONTROL_PLANE_OPERATION_ALLOWLIST: readonly ControlPlaneOperationSpec[] = Object.freeze([
  {
    operation: 'railway.status',
    provider: 'railway-cli',
    description: 'Read Railway project/service status.',
    kind: 'command',
    requiredScopes: ['railway:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('railway'), ['status']),
  },
  {
    operation: 'railway.logs',
    provider: 'railway-cli',
    description: 'Read Railway logs.',
    kind: 'command',
    requiredScopes: ['railway:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('railway'), ['logs']),
  },
  {
    operation: 'railway.whoami',
    provider: 'railway-cli',
    description: 'Read Railway authenticated identity.',
    kind: 'command',
    requiredScopes: ['railway:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('railway'), ['whoami']),
  },
  {
    operation: 'railway.service',
    provider: 'railway-cli',
    description: 'Read Railway service selection.',
    kind: 'command',
    requiredScopes: ['railway:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('railway'), ['service']),
  },
  {
    operation: 'railway.environment',
    provider: 'railway-cli',
    description: 'Read Railway environment selection.',
    kind: 'command',
    requiredScopes: ['railway:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('railway'), ['environment']),
  },
  {
    operation: 'arcanos.status',
    provider: 'arcanos-cli',
    description: 'Read ARCANOS CLI status.',
    kind: 'command',
    requiredScopes: ['arcanos:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('arcanos'), ['status']),
  },
  {
    operation: 'arcanos.inspect',
    provider: 'arcanos-cli',
    description: 'Inspect an allowlisted ARCANOS runtime surface.',
    kind: 'command',
    requiredScopes: ['arcanos:read'],
    readOnly: true,
    buildCommand: (request: ControlPlaneRequest) => commandPlan(executableName('arcanos'), ['inspect', requireSafeInspectTarget(request)]),
  },
  {
    operation: 'arcanos.health',
    provider: 'arcanos-cli',
    description: 'Read ARCANOS CLI health.',
    kind: 'command',
    requiredScopes: ['arcanos:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('arcanos'), ['health']),
  },
  {
    operation: 'arcanos.logs',
    provider: 'arcanos-cli',
    description: 'Read ARCANOS CLI logs.',
    kind: 'command',
    requiredScopes: ['arcanos:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('arcanos'), ['logs']),
  },
  {
    operation: 'arcanos.agents.list',
    provider: 'arcanos-cli',
    description: 'List ARCANOS agents.',
    kind: 'command',
    requiredScopes: ['arcanos:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('arcanos'), ['agents', 'list']),
  },
  {
    operation: 'arcanos.mcp.list-tools',
    provider: 'arcanos-cli',
    description: 'List ARCANOS MCP tools through the CLI.',
    kind: 'command',
    requiredScopes: ['arcanos:read'],
    readOnly: true,
    buildCommand: () => commandPlan(executableName('arcanos'), ['mcp', 'list-tools']),
  },
  {
    operation: 'git.status',
    provider: 'local-command',
    description: 'Read local repository status.',
    kind: 'command',
    requiredScopes: ['repo:read'],
    readOnly: true,
    buildCommand: () => commandPlan('git', ['status', '--short', '--branch']),
  },
  {
    operation: 'git.status',
    provider: 'codex-ide',
    description: 'Read local repository status from a Codex IDE session.',
    kind: 'command',
    requiredScopes: ['repo:read'],
    readOnly: true,
    buildCommand: () => commandPlan('git', ['status', '--short', '--branch']),
  },
  {
    operation: 'git.diff',
    provider: 'local-command',
    description: 'Read local repository diff.',
    kind: 'command',
    requiredScopes: ['repo:read'],
    readOnly: true,
    buildCommand: () => commandPlan('git', ['diff', '--no-color', '--no-ext-diff']),
  },
  {
    operation: 'git.diff',
    provider: 'codex-ide',
    description: 'Read local repository diff from a Codex IDE session.',
    kind: 'command',
    requiredScopes: ['repo:read'],
    readOnly: true,
    buildCommand: () => commandPlan('git', ['diff', '--no-color', '--no-ext-diff']),
  },
  {
    operation: 'npm.test',
    provider: 'local-command',
    description: 'Run repository tests.',
    kind: 'command',
    requiredScopes: ['repo:verify'],
    readOnly: false,
    buildCommand: () => commandPlan(executableName('npm'), ['test'], 120_000),
  },
  {
    operation: 'npm.test',
    provider: 'codex-ide',
    description: 'Run repository tests from a Codex IDE session.',
    kind: 'command',
    requiredScopes: ['repo:verify'],
    readOnly: false,
    buildCommand: () => commandPlan(executableName('npm'), ['test'], 120_000),
  },
  {
    operation: 'npm.run.lint',
    provider: 'local-command',
    description: 'Run repository lint checks.',
    kind: 'command',
    requiredScopes: ['repo:verify'],
    readOnly: false,
    buildCommand: () => commandPlan(executableName('npm'), ['run', 'lint'], 120_000),
  },
  {
    operation: 'npm.run.lint',
    provider: 'codex-ide',
    description: 'Run repository lint checks from a Codex IDE session.',
    kind: 'command',
    requiredScopes: ['repo:verify'],
    readOnly: false,
    buildCommand: () => commandPlan(executableName('npm'), ['run', 'lint'], 120_000),
  },
  {
    operation: 'npm.run.build',
    provider: 'local-command',
    description: 'Run repository build checks.',
    kind: 'command',
    requiredScopes: ['repo:verify'],
    readOnly: false,
    approvalRequired: true,
    buildCommand: () => commandPlan(executableName('npm'), ['run', 'build'], 180_000),
  },
  {
    operation: 'npm.run.build',
    provider: 'codex-ide',
    description: 'Run repository build checks from a Codex IDE session.',
    kind: 'command',
    requiredScopes: ['repo:verify'],
    readOnly: false,
    approvalRequired: true,
    buildCommand: () => commandPlan(executableName('npm'), ['run', 'build'], 180_000),
  },
  {
    operation: 'mcp.list-tools',
    provider: 'arcanos-mcp',
    description: 'List ARCANOS MCP tools through the backend MCP registry.',
    kind: 'mcp-list-tools',
    requiredScopes: ['mcp:read'],
    readOnly: true,
  },
  {
    operation: 'mcp.invoke',
    provider: 'arcanos-mcp',
    description: 'Invoke an allowlisted read-only ARCANOS MCP tool.',
    kind: 'mcp-invoke',
    requiredScopes: ['mcp:invoke'],
    readOnly: true,
    resolveToolName: resolveMcpToolName,
    buildToolArguments: resolveMcpToolArguments,
  },
  {
    operation: 'backend.health',
    provider: 'backend-api',
    description: 'Read backend health diagnostics.',
    kind: 'backend-health',
    requiredScopes: ['backend:read'],
    readOnly: true,
  },
  {
    operation: 'backend.mcp.list-tools',
    provider: 'backend-api',
    description: 'List backend MCP tools through the control-plane API.',
    kind: 'mcp-list-tools',
    requiredScopes: ['backend:read'],
    readOnly: true,
  },
]);

export function getControlPlaneOperationSpec(
  provider: ControlPlaneProvider,
  operation: string
): ControlPlaneOperationSpec | undefined {
  return CONTROL_PLANE_OPERATION_ALLOWLIST.find(
    (entry) => entry.provider === provider && entry.operation === operation
  );
}

export function listControlPlaneAllowlist(): ControlPlaneAllowlistView[] {
  return CONTROL_PLANE_OPERATION_ALLOWLIST.map((entry) => ({
    operation: entry.operation,
    provider: entry.provider,
    description: entry.description,
    kind: entry.kind,
    requiredScopes: [...entry.requiredScopes],
    readOnly: entry.readOnly,
    approvalRequired: Boolean(entry.approvalRequired),
  }));
}
