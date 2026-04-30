export const GPT_PUBLIC_DIRECT_CONTROL_ACTIONS: readonly [] = [];

export const GPT_BLOCKED_DIRECT_CONTROL_ACTIONS = [
  'diagnostics',
  'system_state',
  'runtime.inspect',
  'workers.status',
  'queue.inspect',
  'self_heal.status',
] as const;

export const GPT_DIRECT_CONTROL_ACTIONS = [
  ...GPT_PUBLIC_DIRECT_CONTROL_ACTIONS,
  ...GPT_BLOCKED_DIRECT_CONTROL_ACTIONS,
] as const;

export type GptDirectControlAction = (typeof GPT_DIRECT_CONTROL_ACTIONS)[number];

const GPT_DIRECT_CONTROL_ACTION_ALIASES: Record<string, GptDirectControlAction> = {
  diagnostics: 'diagnostics',
  system_state: 'system_state',
  'runtime.inspect': 'runtime.inspect',
  'workers.status': 'workers.status',
  'queue.inspect': 'queue.inspect',
  'self_heal.status': 'self_heal.status',
  'self-heal.status': 'self_heal.status',
};

const GPT_RESERVED_CONTROL_PREFIXES = ['runtime.', 'workers.', 'queue.', 'self_heal.', 'self-heal.'];

function normalizeAction(action: string | null | undefined): string | null {
  return typeof action === 'string' && action.trim().length > 0
    ? action.trim().toLowerCase()
    : null;
}

export function normalizeGptDirectControlAction(
  action: string | null | undefined
): GptDirectControlAction | null {
  const normalizedAction = normalizeAction(action);
  return normalizedAction ? GPT_DIRECT_CONTROL_ACTION_ALIASES[normalizedAction] ?? null : null;
}

export function isReservedGptControlNamespace(action: string | null | undefined): boolean {
  const normalizedAction = normalizeAction(action);
  return normalizedAction
    ? GPT_RESERVED_CONTROL_PREFIXES.some((prefix) => normalizedAction.startsWith(prefix))
    : false;
}
