export function resolveMaxTokensFromTokenParameters(
  tokenParameters: Record<string, unknown>,
  fallbackValue: number
): number {
  const maxTokensValue = tokenParameters.max_tokens;
  if (typeof maxTokensValue === 'number' && Number.isFinite(maxTokensValue) && maxTokensValue > 0) {
    return Math.floor(maxTokensValue);
  }

  const maxCompletionTokensValue = tokenParameters.max_completion_tokens;
  if (
    typeof maxCompletionTokensValue === 'number' &&
    Number.isFinite(maxCompletionTokensValue) &&
    maxCompletionTokensValue > 0
  ) {
    return Math.floor(maxCompletionTokensValue);
  }

  return fallbackValue;
}
