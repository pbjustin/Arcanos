import {
  type CapabilityRegistry,
  type DispatchRegistryAction
} from './types.js';

export type ModuleCapabilitySummary = {
  id: string;
  description?: string | null;
  route?: string | null;
  actions: string[];
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
  }
];

function normalizeActionKey(action: string): string {
  return action.trim().toLowerCase();
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
    module.actions.map<DispatchRegistryAction>((action) => ({
      action: buildModuleCapabilityActionId(module.id, action),
      description: module.description ?? `Run ${action} on ${module.id}.`,
      requiredScope: 'capabilities.run',
      risk: 'privileged',
      requiresConfirmation: true,
      runner: {
        kind: 'gpt-access-capability',
        capabilityId: module.id,
        capabilityAction: action
      }
    }))
  );

  return createCapabilityRegistry([
    ...DEFAULT_GPT_ACCESS_ACTIONS,
    ...moduleActions
  ]);
}
