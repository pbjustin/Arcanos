import type { ControlPlaneProvider } from '@services/controlPlane/types.js';

export const GPT_ACCESS_OPERATOR_COMMAND_IDS = [
  'runtime.inspect',
  'workers.status',
  'queue.inspect',
  'diagnostics',
  'git.status',
  'git.diff',
  'railway.status',
  'railway.logs',
  'arcanos.health',
  'arcanos.status',
  'arcanos.mcp.list-tools'
] as const;

export type GptAccessOperatorCommandId = (typeof GPT_ACCESS_OPERATOR_COMMAND_IDS)[number];

export const GPT_ACCESS_OPERATOR_NO_ARGS_SCHEMA = Object.freeze({
  type: 'object',
  description: 'This command accepts no arguments.',
  maxProperties: 0,
  additionalProperties: false
} as const);

export interface GptAccessOperatorAllowedArgs {
  policy: 'no-args';
  schema: typeof GPT_ACCESS_OPERATOR_NO_ARGS_SCHEMA;
}

export type GptAccessOperatorAdapter = ControlPlaneProvider | 'gpt-access-internal';

export interface GptAccessOperatorCommandSpec {
  commandId: string;
  adapter: GptAccessOperatorAdapter;
  operation?: string;
  tool?: string;
  handler?: string;
  readOnly: boolean;
  description: string;
  allowedArgs: GptAccessOperatorAllowedArgs;
  timeoutMs: number;
  maxOutputBytes: number;
  targetResource?: string;
  requiredControlPlaneScope?: string | string[];
}

const NO_ARGS: GptAccessOperatorAllowedArgs = Object.freeze({
  policy: 'no-args',
  schema: GPT_ACCESS_OPERATOR_NO_ARGS_SCHEMA
});

function internalSpec(input: {
  commandId: GptAccessOperatorCommandId;
  handler: string;
  description: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): GptAccessOperatorCommandSpec {
  return Object.freeze({
    commandId: input.commandId,
    adapter: 'gpt-access-internal',
    tool: input.commandId,
    handler: input.handler,
    readOnly: true,
    description: input.description,
    allowedArgs: NO_ARGS,
    timeoutMs: input.timeoutMs ?? 5_000,
    maxOutputBytes: input.maxOutputBytes ?? 32_768
  });
}

function controlPlaneSpec(input: {
  commandId: GptAccessOperatorCommandId;
  adapter: ControlPlaneProvider;
  operation: string;
  targetResource: string;
  requiredControlPlaneScope: string | string[];
  description: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): GptAccessOperatorCommandSpec {
  return Object.freeze({
    commandId: input.commandId,
    adapter: input.adapter,
    operation: input.operation,
    handler: 'executeControlPlaneOperation',
    readOnly: true,
    description: input.description,
    allowedArgs: NO_ARGS,
    timeoutMs: input.timeoutMs ?? 20_000,
    maxOutputBytes: input.maxOutputBytes ?? 32_768,
    targetResource: input.targetResource,
    requiredControlPlaneScope: input.requiredControlPlaneScope
  });
}

const COMMAND_SPECS: readonly GptAccessOperatorCommandSpec[] = Object.freeze([
  internalSpec({
    commandId: 'runtime.inspect',
    handler: 'runtimeDiagnosticsService.getHealthSnapshot',
    description: 'Inspect the sanitized ARCANOS runtime health snapshot.'
  }),
  internalSpec({
    commandId: 'workers.status',
    handler: 'getWorkerControlStatus',
    description: 'Read the current ARCANOS worker control status.'
  }),
  internalSpec({
    commandId: 'queue.inspect',
    handler: 'getJobQueueSummary',
    description: 'Read the current durable job queue summary.'
  }),
  internalSpec({
    commandId: 'diagnostics',
    handler: 'gptAccessOperatorDiagnostics',
    description: 'Collect a compact read-only runtime, worker, queue, and self-heal diagnostic bundle.',
    timeoutMs: 10_000,
    maxOutputBytes: 65_536
  }),
  controlPlaneSpec({
    commandId: 'git.status',
    adapter: 'local-command',
    operation: 'git.status',
    targetResource: 'repository',
    requiredControlPlaneScope: 'repo:read',
    description: 'Read local repository status through the control-plane allowlist.'
  }),
  controlPlaneSpec({
    commandId: 'git.diff',
    adapter: 'local-command',
    operation: 'git.diff',
    targetResource: 'repository',
    requiredControlPlaneScope: 'repo:read',
    description: 'Read local repository diff through the control-plane allowlist.',
    maxOutputBytes: 65_536
  }),
  controlPlaneSpec({
    commandId: 'railway.status',
    adapter: 'railway-cli',
    operation: 'railway.status',
    targetResource: 'railway-project',
    requiredControlPlaneScope: 'railway:read',
    description: 'Read Railway project and service status through the control-plane allowlist.',
    timeoutMs: 15_000,
    maxOutputBytes: 16_384
  }),
  controlPlaneSpec({
    commandId: 'railway.logs',
    adapter: 'railway-cli',
    operation: 'railway.logs',
    targetResource: 'railway-logs',
    requiredControlPlaneScope: 'railway:read',
    description: 'Read bounded Railway logs through the control-plane allowlist.',
    timeoutMs: 15_000,
    maxOutputBytes: 16_384
  }),
  controlPlaneSpec({
    commandId: 'arcanos.health',
    adapter: 'arcanos-cli',
    operation: 'arcanos.health',
    targetResource: 'arcanos-backend',
    requiredControlPlaneScope: 'arcanos:read',
    description: 'Read ARCANOS health through the control-plane allowlist.'
  }),
  controlPlaneSpec({
    commandId: 'arcanos.status',
    adapter: 'arcanos-cli',
    operation: 'arcanos.status',
    targetResource: 'arcanos-backend',
    requiredControlPlaneScope: 'arcanos:read',
    description: 'Read ARCANOS status through the control-plane allowlist.'
  }),
  controlPlaneSpec({
    commandId: 'arcanos.mcp.list-tools',
    adapter: 'arcanos-cli',
    operation: 'arcanos.mcp.list-tools',
    targetResource: 'arcanos-mcp-tools',
    requiredControlPlaneScope: 'arcanos:read',
    description: 'List ARCANOS MCP tools through the control-plane allowlist.'
  })
]);

export const GPT_ACCESS_OPERATOR_COMMAND_REGISTRY: ReadonlyMap<string, GptAccessOperatorCommandSpec> =
  Object.freeze(new Map(COMMAND_SPECS.map((spec) => [spec.commandId, spec])));

export function getGptAccessOperatorCommandSpec(
  commandId: string,
  registry: ReadonlyMap<string, GptAccessOperatorCommandSpec> = GPT_ACCESS_OPERATOR_COMMAND_REGISTRY
): GptAccessOperatorCommandSpec | undefined {
  return registry.get(commandId);
}

export function listGptAccessOperatorCommandSpecs(): readonly GptAccessOperatorCommandSpec[] {
  return [...GPT_ACCESS_OPERATOR_COMMAND_REGISTRY.values()];
}
