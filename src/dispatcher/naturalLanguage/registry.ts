import {
  type CapabilityRegistry,
  type DispatchRegistryAction
} from './types.js';

export type ModuleCapabilitySummary = {
  id: string;
  description?: string | null;
  route?: string | null;
  actions: string[];
  actionMetadata?: Record<string, {
    description?: string;
    risk?: unknown;
    requiresConfirmation?: unknown;
  }>;
};

const DEFAULT_GPT_ACCESS_ACTIONS: DispatchRegistryAction[] = [
  {
    action: 'workers.status',
    description: 'Read worker and queue-observed status through GPT Access MCP control.',
    requiredScope: 'mcp.approved_readonly',
    risk: 'readonly',
    runner: {
      kind: 'gpt-access-mcp',
      tool: 'workers.status'
    }
  },
  {
    action: 'queue.inspect',
    description: 'Inspect the durable GPT/job queue through GPT Access MCP control.',
    requiredScope: 'mcp.approved_readonly',
    risk: 'readonly',
    runner: {
      kind: 'gpt-access-mcp',
      tool: 'queue.inspect'
    }
  },
  {
    action: 'runtime.inspect',
    description: 'Read runtime health through GPT Access MCP control.',
    requiredScope: 'mcp.approved_readonly',
    risk: 'readonly',
    runner: {
      kind: 'gpt-access-mcp',
      tool: 'runtime.inspect'
    }
  },
  {
    action: 'diagnostics.run',
    description: 'Run approved deep diagnostics through GPT Access.',
    payload: {
      includeDb: true,
      includeWorkers: true,
      includeLogs: true,
      includeQueue: true
    },
    requiredScope: 'diagnostics.read',
    risk: 'readonly',
    runner: {
      kind: 'gpt-access-diagnostics'
    }
  },
  {
    action: 'workers.recover',
    description: 'Recover stale or stalled async queue worker jobs through GPT Access worker recovery.',
    payload: {
      workerIds: []
    },
    requiredScope: 'workers.recover',
    risk: 'privileged',
    requiresConfirmation: true,
    runner: {
      kind: 'gpt-access-worker-recovery',
      mode: 'recover'
    }
  },
  {
    action: 'workers.recycle',
    description: 'Recycle stalled async queue worker ownership by requeueing recoverable stale jobs through GPT Access worker recovery.',
    payload: {
      workerIds: []
    },
    requiredScope: 'workers.recover',
    risk: 'privileged',
    requiresConfirmation: true,
    runner: {
      kind: 'gpt-access-worker-recovery',
      mode: 'recycle'
    }
  }
];

function normalizeActionKey(action: string): string {
  return action.trim().toLowerCase();
}

function resolveModuleActionPolicy(
  module: ModuleCapabilitySummary,
  action: string
): Pick<DispatchRegistryAction, 'description' | 'risk' | 'requiresConfirmation'> {
  const candidate = module.actionMetadata?.[action];
  if (
    !candidate
    || (
      candidate.risk !== 'readonly'
      && candidate.risk !== 'privileged'
      && candidate.risk !== 'destructive'
    )
    || (
      candidate.requiresConfirmation !== undefined
      && typeof candidate.requiresConfirmation !== 'boolean'
    )
  ) {
    return {
      description: module.description ?? `Run ${action} on ${module.id}.`,
      risk: 'privileged',
      requiresConfirmation: true
    };
  }

  return {
    description:
      typeof candidate.description === 'string' && candidate.description.trim().length > 0
        ? candidate.description.trim()
        : module.description ?? `Run ${action} on ${module.id}.`,
    risk: candidate.risk,
    requiresConfirmation:
      candidate.risk === 'readonly'
        ? candidate.requiresConfirmation === true
        : true
  };
}

export function buildModuleCapabilityActionId(capabilityId: string, action: string): string {
  return `${capabilityId}.${action}`;
}

export class StaticCapabilityRegistry implements CapabilityRegistry {
  private readonly actionsByKey: Map<string, DispatchRegistryAction>;

  constructor(actions: readonly DispatchRegistryAction[]) {
    this.actionsByKey = new Map(
      actions.map((action) => [normalizeActionKey(action.action), action])
    );
  }

  getAction(action: string): DispatchRegistryAction | null {
    return this.actionsByKey.get(normalizeActionKey(action)) ?? null;
  }

  hasAction(action: string): boolean {
    return this.actionsByKey.has(normalizeActionKey(action));
  }

  listActions(): readonly DispatchRegistryAction[] {
    return Array.from(this.actionsByKey.values());
  }
}

export function createCapabilityRegistry(
  actions: readonly DispatchRegistryAction[]
): CapabilityRegistry {
  return new StaticCapabilityRegistry(actions);
}

export function createGptAccessDispatchRegistry(
  modules: readonly ModuleCapabilitySummary[] = []
): CapabilityRegistry {
  const moduleActions = modules.flatMap((module) =>
    module.actions.map<DispatchRegistryAction>((action) => {
      const policy = resolveModuleActionPolicy(module, action);
      return {
        action: buildModuleCapabilityActionId(module.id, action),
        description: policy.description,
        requiredScope: 'capabilities.run',
        risk: policy.risk,
        requiresConfirmation: policy.requiresConfirmation,
        runner: {
          kind: 'gpt-access-capability',
          capabilityId: module.id,
          capabilityAction: action
        }
      };
    })
  );

  return createCapabilityRegistry([
    ...DEFAULT_GPT_ACCESS_ACTIONS,
    ...moduleActions
  ]);
}
