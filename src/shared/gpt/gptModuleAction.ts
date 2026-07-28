/** Select the explicit or implicit action that a GPT module can execute. */
export function pickGptModuleAction(
  availableActions: readonly string[],
  requestedAction?: string,
  defaultAction?: string | null
): string | null {
  if (requestedAction) {
    return availableActions.includes(requestedAction) ? requestedAction : null;
  }
  if (defaultAction && availableActions.includes(defaultAction)) {
    return defaultAction;
  }
  if (availableActions.includes('query')) {
    return 'query';
  }
  if (availableActions.includes('run')) {
    return 'run';
  }
  return availableActions.length === 1
    ? availableActions[0] ?? null
    : null;
}

/**
 * Canonicalize legacy requested actions onto actions exposed by one module.
 */
export function resolveGptModuleRequestedActionAlias(
  requestedAction: string | undefined,
  availableActions: readonly string[]
): string | undefined {
  if (typeof requestedAction !== 'string') {
    return undefined;
  }

  const trimmedRequestedAction = requestedAction.trim();
  if (trimmedRequestedAction.length === 0) {
    return undefined;
  }

  const normalizedRequestedAction = trimmedRequestedAction.toLowerCase();
  const directMatch = availableActions.find(
    (actionName) => actionName.toLowerCase() === normalizedRequestedAction
  );
  if (directMatch) {
    return directMatch;
  }

  if (
    (normalizedRequestedAction === 'ask' || normalizedRequestedAction === 'chat')
    && availableActions.includes('query')
  ) {
    return 'query';
  }

  return trimmedRequestedAction;
}
