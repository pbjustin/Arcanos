export const TRINITY_REASONING_MAX_OUTPUT_TOKENS_DEFAULT = 8_000;
export const TRINITY_REASONING_MAX_OUTPUT_TOKENS_MINIMUM = 16;

export type TrinityRequestedReasoningEffort = 'none' | 'low' | 'medium';
export type TrinityProviderReasoningEffort =
  | TrinityRequestedReasoningEffort
  | 'minimal';

export interface TrinityReasoningProviderPolicy {
  maxOutputTokens: number;
  reasoningEffort: TrinityProviderReasoningEffort;
}

export function supportsDisabledReasoningEffort(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return /^gpt-5\.1(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalizedModel)
    || /^gpt-5\.6(?:$|-\d{4}-\d{2}-\d{2}$|-(?:sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?$)/.test(normalizedModel);
}

export function normalizeTrinityReasoningEffort(
  model: string,
  effort: TrinityRequestedReasoningEffort
): TrinityProviderReasoningEffort {
  if (effort !== 'none') return effort;

  const normalizedModel = model.trim().toLowerCase();
  // Original GPT-5 accepts `minimal` but not disabled reasoning; preserve the selected model.
  return /^gpt-5(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalizedModel)
    ? 'minimal'
    : effort;
}

export function resolveTrinityReasoningMaxOutputTokens(
  configuredValue: string | undefined
): number {
  const normalizedValue = configuredValue?.trim() ?? '';
  if (!/^[0-9]+$/.test(normalizedValue)) {
    return TRINITY_REASONING_MAX_OUTPUT_TOKENS_DEFAULT;
  }

  const configuredMaxOutputTokens = Number(normalizedValue);
  if (
    !Number.isSafeInteger(configuredMaxOutputTokens)
    || configuredMaxOutputTokens <= 0
  ) {
    return TRINITY_REASONING_MAX_OUTPUT_TOKENS_DEFAULT;
  }

  return Math.min(
    TRINITY_REASONING_MAX_OUTPUT_TOKENS_DEFAULT,
    Math.max(
      TRINITY_REASONING_MAX_OUTPUT_TOKENS_MINIMUM,
      configuredMaxOutputTokens
    )
  );
}

export function resolveTrinityReasoningProviderPolicy({
  model,
  requestedEffort,
  configuredMaxOutputTokens,
}: {
  model: string;
  requestedEffort: TrinityRequestedReasoningEffort;
  configuredMaxOutputTokens: string | undefined;
}): TrinityReasoningProviderPolicy {
  return {
    maxOutputTokens: resolveTrinityReasoningMaxOutputTokens(
      configuredMaxOutputTokens
    ),
    reasoningEffort: normalizeTrinityReasoningEffort(
      model,
      requestedEffort
    ),
  };
}
