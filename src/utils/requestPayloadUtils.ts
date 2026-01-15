/**
 * Request Payload Builder Utilities
 * Provides reusable functions for constructing OpenAI request payloads
 */

import type { ChatCompletionMessageParam, ChatCompletionResponseFormat } from '../services/openai/types.js';

/**
 * Build standardized completion request payload
 * Consolidates repeated request payload construction pattern
 */
export const buildCompletionRequestPayload = (
  model: string,
  messages: ChatCompletionMessageParam[],
  tokenParams: { max_tokens?: number; max_completion_tokens?: number },
  options: {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    responseFormat?: ChatCompletionResponseFormat;
    user?: string;
  } = {}
): Record<string, any> => {
  const payload: Record<string, any> = {
    model,
    messages,
    ...tokenParams
  };

  // Add optional parameters only if defined
  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options.top_p !== undefined) {
    payload.top_p = options.top_p;
  }
  if (options.frequency_penalty !== undefined) {
    payload.frequency_penalty = options.frequency_penalty;
  }
  if (options.presence_penalty !== undefined) {
    payload.presence_penalty = options.presence_penalty;
  }
  if (options.responseFormat !== undefined) {
    payload.response_format = options.responseFormat;
  }
  if (options.user !== undefined) {
    payload.user = options.user;
  }

  return payload;
};
