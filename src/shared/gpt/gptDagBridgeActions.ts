export const GPT_DAG_BRIDGE_ACTIONS = [
  'dag.capabilities',
  'dag.dispatch',
  'dag.status',
  'dag.trace',
] as const;

export type GptDagBridgeAction = (typeof GPT_DAG_BRIDGE_ACTIONS)[number];

const GPT_DAG_BRIDGE_ACTION_SET = new Set<string>(GPT_DAG_BRIDGE_ACTIONS);

export function normalizeGptDagAction(action: string | null | undefined): string | null {
  return typeof action === 'string' && action.trim().length > 0
    ? action.trim().toLowerCase()
    : null;
}

export function isGptDagAction(action: string | null | undefined): boolean {
  return normalizeGptDagAction(action)?.startsWith('dag.') ?? false;
}

export function isGptDagBridgeAction(
  action: string | null | undefined
): action is GptDagBridgeAction {
  const normalizedAction = normalizeGptDagAction(action);
  return normalizedAction ? GPT_DAG_BRIDGE_ACTION_SET.has(normalizedAction) : false;
}

export function normalizeGptDagBridgeAction(
  action: string | null | undefined
): GptDagBridgeAction | null {
  const normalizedAction = normalizeGptDagAction(action);
  return isGptDagBridgeAction(normalizedAction) ? normalizedAction : null;
}
