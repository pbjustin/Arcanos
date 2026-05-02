import type OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming
} from 'openai/resources/responses/responses';

import {
  normalizeUsage as normalizeOpenAIUsage,
  extractResponseOutputText as extractResponseText
} from '@arcanos/openai/responseParsing';
import { shouldStoreOpenAIResponses } from '@config/openaiStore.js';
import {
  attachOpenAIResponsesMetadataToChatCompletion,
  resolveOpenAIResponsesLegacyFinishReason,
  type OpenAIResponsesLegacyChatCompletion
} from '@core/adapters/openaiResponsesMetadata.js';

import type {
  NormalizedResponsesRequest,
  NormalizedVisionResponsesRequest,
  NormalizedChatCompletionRequest,
  NormalizedVisionChatCompletionRequest,
  NormalizedTranscriptionRequest,
  NormalizedImageRequest,
  NormalizedEmbeddingRequest
} from './normalize.js';


function isReasoningModel(model: string): boolean {
  // Heuristic: OpenAI reasoning models commonly start with 'o' (e.g., o1, o3).
  return typeof model === 'string' && /^o\d/i.test(model.trim());
}

function extractUsage(usage: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } {
  return normalizeOpenAIUsage(usage);
}

export type {
  OpenAIResponsesLegacyChatCompletion,
  OpenAIResponsesProviderMetadata
} from '@core/adapters/openaiResponsesMetadata.js';

export function convertNormalizedResponsesToRequest(
  normalized: NormalizedResponsesRequest
): ResponseCreateParamsNonStreaming {
  const payload: ResponseCreateParamsNonStreaming = {
    model: normalized.model,
    store: shouldStoreOpenAIResponses(),
    input: normalized.input,
    temperature: normalized.temperature,
    top_p: normalized.top_p,
    max_output_tokens: normalized.maxOutputTokens
  };

  if (normalized.instructionText && normalized.instructionText.length > 0) {
    payload.instructions = normalized.instructionText;
  }

  // Map legacy response_format to Responses API text.format when recognizable
  const responseFormat = normalized.responseFormat;
  if (responseFormat && typeof responseFormat === 'object' && 'type' in (responseFormat as object)) {
    const responseType = String((responseFormat as { type?: unknown }).type || '').toLowerCase();
    if (responseType === 'json_object') {
      payload.text = { format: { type: 'json_object' } };
    } else if (responseType === 'json_schema') {
      const jsonSchema = (responseFormat as { json_schema?: unknown }).json_schema;
      payload.text = {
        format: {
          type: 'json_schema',
          ...(jsonSchema && typeof jsonSchema === 'object' ? { json_schema: jsonSchema } : {})
        } as never
      };
    }
  }

  if (normalized.user) {
    payload.metadata = { user: normalized.user };
  }

  // Best practice for stateless reasoning: request encrypted reasoning items when using reasoning models.
  if (isReasoningModel(normalized.model)) {
    payload.include = ['reasoning.encrypted_content'];
  }

  return payload;
}

export function convertNormalizedVisionResponsesToRequest(
  normalized: NormalizedVisionResponsesRequest
): ResponseCreateParamsNonStreaming {
  return {
    model: normalized.model,
    input: normalized.input,
    store: false,
    temperature: normalized.temperature,
    max_output_tokens: normalized.maxOutputTokens
  };
}

export function convertNormalizedChatCompletionToRequest(
  normalized: NormalizedChatCompletionRequest
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const requestPayload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: normalized.model,
    messages: normalized.preparedMessages,
    stream: false,
    temperature: normalized.temperature,
    top_p: normalized.top_p,
    frequency_penalty: normalized.frequency_penalty,
    presence_penalty: normalized.presence_penalty,
    ...(normalized.tokenParams as object)
  };

  // Preserve historical behavior: attach response format via text.format
  if (normalized.responseFormat) {
    (requestPayload as unknown as Record<string, unknown>).text = { format: normalized.responseFormat as unknown };
  }

  if (normalized.user) {
    requestPayload.user = normalized.user;
  }

  return requestPayload;
}

export function convertNormalizedVisionChatCompletionToRequest(
  normalized: NormalizedVisionChatCompletionRequest
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model: normalized.model,
    messages: normalized.messages,
    stream: false,
    temperature: normalized.temperature,
    ...(normalized.tokenParams as object)
  };
}

export function convertNormalizedTranscriptionToRequest(
  normalized: NormalizedTranscriptionRequest
): OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming {
  const requestParams: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming = {
    file: normalized.audioFile as File,
    model: normalized.model,
    response_format: normalized.responseFormat,
    stream: false
  };

  if (normalized.language) {
    requestParams.language = normalized.language;
  }

  if (normalized.temperature !== undefined) {
    requestParams.temperature = normalized.temperature;
  }

  return requestParams;
}

export function convertNormalizedImageToRequest(
  normalized: NormalizedImageRequest
): OpenAI.Images.ImageGenerateParamsNonStreaming {
  return {
    model: normalized.model,
    prompt: normalized.prompt,
    size: normalized.size,
    quality: normalized.quality,
    n: normalized.n,
    response_format: normalized.responseFormat,
    stream: false
  };
}

export function convertNormalizedEmbeddingToRequest(
  normalized: NormalizedEmbeddingRequest
): OpenAI.Embeddings.EmbeddingCreateParams {
  const requestParams: OpenAI.Embeddings.EmbeddingCreateParams = {
    model: normalized.model,
    input: normalized.input
  };

  if (normalized.user) {
    requestParams.user = normalized.user;
  }

  return requestParams;
}

/**
 * Extract text content from a Responses API response.
 *
 * @param response - Responses API response payload.
 * @param fallback - Fallback text when no output text is present.
 * @returns Normalized output text.
 */
export function extractResponseOutputText(response: unknown, fallback = ''): string {
  return extractResponseText(response, fallback);
}

/**
 * Convert a Responses API response into a legacy ChatCompletion shape.
 */
export function convertResponseToLegacyChatCompletion(
  response: OpenAIResponse,
  requestedModel: string
): OpenAIResponsesLegacyChatCompletion {
  const outputText = extractResponseOutputText(response, '');
  const usage = extractUsage((response as unknown as { usage?: unknown }).usage);
  const createdSource = (response as { created_at?: unknown }).created_at;
  const created = typeof createdSource === 'number'
    ? Math.floor(createdSource)
    : Math.floor(Date.now() / 1000);
  const finishReason = resolveOpenAIResponsesLegacyFinishReason(response);

  const legacyResponse: OpenAI.Chat.Completions.ChatCompletion = {
    id: response.id || `legacy_${Date.now()}`,
    object: 'chat.completion',
    created,
    model: (response as unknown as { model?: string }).model || requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: outputText,
          refusal: null
        },
        finish_reason: finishReason,
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens
    }
  };

  return attachOpenAIResponsesMetadataToChatCompletion(legacyResponse, response, finishReason);
}
