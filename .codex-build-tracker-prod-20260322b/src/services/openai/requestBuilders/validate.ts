import type OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

import { OPENAI_COMPLETION_DEFAULTS } from '../constants.js';

/**
 * Validation stage for request builders.
 *
 * This is intentionally conservative: it only normalizes obvious non-finite values
 * to avoid behavior changes in callers that pass edge-case configuration.
 */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateResponsesRequest(payload: ResponseCreateParamsNonStreaming): ResponseCreateParamsNonStreaming {
  if (!isFiniteNumber(payload.temperature)) {
    payload.temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE;
  }
  if (!isFiniteNumber(payload.top_p)) {
    payload.top_p = OPENAI_COMPLETION_DEFAULTS.TOP_P;
  }
  if (!isFiniteNumber(payload.max_output_tokens)) {
    delete (payload as unknown as { max_output_tokens?: unknown }).max_output_tokens;
  }
  return payload;
}

export function validateChatCompletionRequest(
  payload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  if (!isFiniteNumber(payload.temperature)) {
    payload.temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE;
  }
  if (!isFiniteNumber(payload.top_p)) {
    payload.top_p = OPENAI_COMPLETION_DEFAULTS.TOP_P;
  }
  payload.stream = false;
  return payload;
}

export function validateTranscriptionRequest<T>(payload: T): T {
  return payload;
}

export function validateImageRequest<T>(payload: T): T {
  return payload;
}

export function validateEmbeddingRequest<T>(payload: T): T {
  return payload;
}
