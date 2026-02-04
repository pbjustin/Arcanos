import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { REASONING_SYSTEM_PROMPT, REASONING_TEMPERATURE, REASONING_TOKEN_LIMIT, buildReasoningPrompt } from '../../config/reasoningTemplates.js';
import type { ChatCompletionCreateParams } from './types.js';

/**
 * Prepare GPT-5 request payload. OpenAI API uses max_tokens or max_completion_tokens,
 * not max_output_tokens; we pass through token params unchanged.
 */
export function prepareGPT5Request(payload: ChatCompletionCreateParams): ChatCompletionCreateParams {
  //audit Assumption: OpenAI API accepts max_tokens / max_completion_tokens only; risk: max_output_tokens rejected; invariant: no max_output_tokens; strategy: return payload as-is.
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
