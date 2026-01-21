import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { REASONING_SYSTEM_PROMPT, REASONING_TEMPERATURE, REASONING_TOKEN_LIMIT, buildReasoningPrompt } from '../../config/reasoningTemplates.js';
import { RESILIENCE_CONSTANTS } from './resilience.js';

export function prepareGPT5Request(payload: any): any {
  if (payload.model && typeof payload.model === 'string' && payload.model.includes('gpt-5')) {
    if (payload.max_tokens) {
      payload.max_output_tokens = payload.max_tokens;
      delete payload.max_tokens;
    }
    if (payload.max_completion_tokens) {
      payload.max_output_tokens = payload.max_completion_tokens;
      delete payload.max_completion_tokens;
    }
    if (!payload.max_output_tokens) {
      payload.max_output_tokens = RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS;
    }
  }
  return payload;
}

export function buildReasoningRequestPayload(
  model: string,
  originalPrompt: string,
  arcanosResult: string,
  context?: string
) {
  const tokenParams = getTokenParameter(model, REASONING_TOKEN_LIMIT);

  return prepareGPT5Request({
    model,
    input: [
      { role: 'system' as const, content: REASONING_SYSTEM_PROMPT },
      { role: 'user' as const, content: buildReasoningPrompt(originalPrompt, arcanosResult, context) }
    ],
    text: { verbosity: 'medium' as const },
    reasoning: { effort: 'low' as const },
    ...tokenParams,
    temperature: REASONING_TEMPERATURE
  });
}
