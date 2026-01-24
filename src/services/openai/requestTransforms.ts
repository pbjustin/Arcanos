import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { REASONING_SYSTEM_PROMPT, REASONING_TEMPERATURE, REASONING_TOKEN_LIMIT, buildReasoningPrompt } from '../../config/reasoningTemplates.js';
import { RESILIENCE_CONSTANTS } from './resilience.js';
import type { ChatCompletionCreateParams } from './types.js';

/**
 * Transform GPT-5 request payload to use correct token parameter names
 * @confidence 0.95 - GPT-5 API may use different parameter names
 */
type GPT5RequestPayload = ChatCompletionCreateParams & {
  max_output_tokens?: number;
};

export function prepareGPT5Request(payload: ChatCompletionCreateParams): ChatCompletionCreateParams {
  //audit Assumption: GPT-5 models need max_output_tokens; Handling: translate
  if (payload.model && typeof payload.model === 'string' && payload.model.includes('gpt-5')) {
    const gpt5Payload: GPT5RequestPayload = { ...payload };
    if (payload.max_tokens) {
      gpt5Payload.max_output_tokens = payload.max_tokens;
      delete gpt5Payload.max_tokens;
    }
    if (payload.max_completion_tokens) {
      gpt5Payload.max_output_tokens = payload.max_completion_tokens;
      delete gpt5Payload.max_completion_tokens;
    }
    //audit Assumption: missing token limit should use resilience default
    if (!gpt5Payload.max_output_tokens) {
      gpt5Payload.max_output_tokens = RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS;
    }
    return gpt5Payload;
  }
  return payload;
}

export function buildReasoningRequestPayload(
  model: string,
  originalPrompt: string,
  arcanosResult: string,
  context?: string
): ChatCompletionCreateParams {
  const tokenParams = getTokenParameter(model, REASONING_TOKEN_LIMIT);

  //audit Assumption: reasoning prompt requires system + user messages
  return prepareGPT5Request({
    model,
    messages: [
      { role: 'system' as const, content: REASONING_SYSTEM_PROMPT },
      { role: 'user' as const, content: buildReasoningPrompt(originalPrompt, arcanosResult, context) }
    ],
    ...tokenParams,
    temperature: REASONING_TEMPERATURE
  });
}
