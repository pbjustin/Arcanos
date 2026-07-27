/**
 * Backend compatibility facade for portable OpenAI Responses semantics.
 *
 * New cross-runtime behavior belongs in @arcanos/openai/responses.
 */
export {
  OpenAIResponseLegacyConversionError,
  attachOpenAIResponsesMetadataToChatCompletion,
  buildOpenAIResponsesProviderMetadata,
  normalizeOpenAIResponseForLegacyChat,
  normalizeOpenAIResponseSemantics,
  resolveOpenAIResponsesLegacyFinishReason
} from '@arcanos/openai/responses';

export type {
  LegacyConvertibleOpenAIResponseSemantics,
  NormalizedOpenAIResponseSemantics,
  OpenAIResponseLegacyConversionFailureReason,
  OpenAIResponsesLegacyChatCompletion,
  OpenAIResponsesLegacyFinishReason,
  OpenAIResponsesLifecycle,
  OpenAIResponsesProviderMetadata
} from '@arcanos/openai/responses';
