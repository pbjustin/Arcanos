export const TRINITY_REASONING_MAX_OUTPUT_TOKENS_DEFAULT = 8_000;
export const TRINITY_REASONING_MAX_OUTPUT_TOKENS_MINIMUM = 16;

export type TrinityRequestedReasoningEffort = 'none' | 'low' | 'medium';
export type TrinityProviderReasoningEffort =
  | TrinityRequestedReasoningEffort
  | 'minimal';

// API capabilities and the pinned SDK request surface are intentionally separate:
// OpenAI 6.25.0 cannot type `max`, and no lane introduced here sends it.
export type OpenAIModelReasoningEffort =
  | TrinityProviderReasoningEffort
  | 'high'
  | 'xhigh';
export type OpenAIModelApiReasoningEffort = OpenAIModelReasoningEffort | 'max';

export interface OpenAIModelCapabilities {
  family: 'gpt-5' | 'gpt-5.1' | 'gpt-5.6' | 'gpt-6-luna' | 'gpt-6.1-sol' | 'unknown';
  supportsDisabledReasoning: boolean;
  allowedReasoningEfforts: readonly OpenAIModelApiReasoningEffort[];
  structuredReasoning: 'supported' | 'unverified';
  defaultReasoningEffort: OpenAIModelReasoningEffort | undefined;
  normalizeReasoningRequests: boolean;
  outputTokenPolicy: {
    responsesParameter: 'max_output_tokens';
    chatParameter: 'max_completion_tokens' | undefined;
    minimum: number;
    trinityReasoningMaximum: number;
  };
}

const COMMON_OUTPUT_TOKEN_POLICY = {
  responsesParameter: 'max_output_tokens' as const,
  chatParameter: 'max_completion_tokens' as const,
  minimum: TRINITY_REASONING_MAX_OUTPUT_TOKENS_MINIMUM,
  trinityReasoningMaximum: TRINITY_REASONING_MAX_OUTPUT_TOKENS_DEFAULT,
};
const GPT_5_CAPABILITIES: OpenAIModelCapabilities = {
  family: 'gpt-5', supportsDisabledReasoning: false,
  allowedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  structuredReasoning: 'supported', defaultReasoningEffort: 'medium',
  normalizeReasoningRequests: false, outputTokenPolicy: COMMON_OUTPUT_TOKEN_POLICY,
};
const GPT_51_CAPABILITIES: OpenAIModelCapabilities = {
  ...GPT_5_CAPABILITIES, family: 'gpt-5.1', supportsDisabledReasoning: true,
  allowedReasoningEfforts: ['none', 'low', 'medium', 'high'],
  defaultReasoningEffort: 'none',
};
const GPT_56_CAPABILITIES: OpenAIModelCapabilities = {
  ...GPT_51_CAPABILITIES, family: 'gpt-5.6', defaultReasoningEffort: 'medium',
  allowedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};
// Verified against https://developers.openai.com/api/docs/guides/latest-model.
// Only reviewed IDs (and date snapshots) receive GPT-6 request normalization.
const GPT_6_LUNA_CAPABILITIES: OpenAIModelCapabilities = {
  ...GPT_56_CAPABILITIES, family: 'gpt-6-luna', normalizeReasoningRequests: true,
};
const GPT_61_SOL_CAPABILITIES: OpenAIModelCapabilities = {
  ...GPT_6_LUNA_CAPABILITIES, family: 'gpt-6.1-sol', supportsDisabledReasoning: false,
  allowedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const MODEL_CAPABILITIES: Readonly<Record<string, OpenAIModelCapabilities>> = {
  'gpt-5': GPT_5_CAPABILITIES,
  'gpt-5.1': GPT_51_CAPABILITIES,
  'gpt-5.6': GPT_56_CAPABILITIES,
  'gpt-5.6-sol': GPT_56_CAPABILITIES,
  'gpt-5.6-terra': GPT_56_CAPABILITIES,
  'gpt-5.6-luna': GPT_56_CAPABILITIES,
  'gpt-6-luna': GPT_6_LUNA_CAPABILITIES,
  'gpt-6.1-sol': GPT_61_SOL_CAPABILITIES,
};
const UNKNOWN_MODEL_CAPABILITIES: OpenAIModelCapabilities = {
  family: 'unknown', supportsDisabledReasoning: false, allowedReasoningEfforts: [],
  structuredReasoning: 'unverified', defaultReasoningEffort: undefined,
  normalizeReasoningRequests: false,
  outputTokenPolicy: { ...COMMON_OUTPUT_TOKEN_POLICY, chatParameter: undefined },
};

export function resolveOpenAIModelCapabilities(model: string): OpenAIModelCapabilities {
  const modelId = model.trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return Object.hasOwn(MODEL_CAPABILITIES, modelId)
    ? MODEL_CAPABILITIES[modelId]
    : UNKNOWN_MODEL_CAPABILITIES;
}

export function normalizeOpenAIModelReasoningEffort(
  model: string,
  effort: OpenAIModelReasoningEffort
): OpenAIModelReasoningEffort {
  const capabilities = resolveOpenAIModelCapabilities(model);
  if (capabilities.normalizeReasoningRequests) {
    // GPT-6 has no `minimal`; Sol also has no `none`. Use the documented low
    // migration setting, preserving the model and the caller's output/time caps.
    if (effort === 'minimal' || (effort === 'none' && !capabilities.supportsDisabledReasoning)) {
      return 'low';
    }
    if (effort === ('max' as string)) {
      throw new RangeError('Reasoning effort max requires an OpenAI SDK update.');
    }
    if (!capabilities.allowedReasoningEfforts.includes(effort)) {
      throw new RangeError('Unsupported reasoning effort for the selected model.');
    }
  }
  return capabilities.family === 'gpt-5' && effort === 'none' ? 'minimal' : effort;
}

export interface TrinityReasoningProviderPolicy {
  maxOutputTokens: number;
  reasoningEffort: TrinityProviderReasoningEffort;
}

export function supportsDisabledReasoningEffort(model: string): boolean {
  return resolveOpenAIModelCapabilities(model).supportsDisabledReasoning;
}

export function normalizeTrinityReasoningEffort(
  model: string,
  effort: TrinityRequestedReasoningEffort
): TrinityProviderReasoningEffort {
  return normalizeOpenAIModelReasoningEffort(model, effort) as TrinityProviderReasoningEffort;
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
