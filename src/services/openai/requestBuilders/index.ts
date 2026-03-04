/**
 * Standardized Request Builder Patterns
 *
 * Provides reusable request builders for all OpenAI API operations:
 * - Chat completions (with ARCANOS routing message)
 * - Vision requests
 * - Audio transcription
 * - Image generation
 * - Embeddings
 *
 * Features:
 * - Railway-native patterns (stateless, deterministic)
 * - Consistent request structure
 * - Type-safe builders
 * - ARCANOS routing message injection
 * - Audit trail for all requests
 *
 * @module requestBuilders
 */

import type OpenAI from 'openai';
import type {
  ResponseCreateParamsNonStreaming
} from 'openai/resources/responses/responses';

import type { ChatParams, VisionParams, TranscriptionParams, ImageParams, EmbeddingParams } from './types.js';

import {
  buildResponsesDraft,
  buildVisionResponsesDraft,
  buildChatCompletionDraft,
  buildVisionChatCompletionDraft,
  buildTranscriptionDraft,
  buildImageDraft,
  buildEmbeddingDraft
} from './build.js';

import {
  normalizeResponsesDraft,
  normalizeVisionResponsesDraft,
  normalizeChatCompletionDraft,
  normalizeVisionChatCompletionDraft,
  normalizeTranscriptionDraft,
  normalizeImageDraft,
  normalizeEmbeddingDraft
} from './normalize.js';

import {
  convertNormalizedResponsesToRequest,
  convertNormalizedVisionResponsesToRequest,
  convertNormalizedChatCompletionToRequest,
  convertNormalizedVisionChatCompletionToRequest,
  convertNormalizedTranscriptionToRequest,
  convertNormalizedImageToRequest,
  convertNormalizedEmbeddingToRequest,
  extractResponseOutputText,
  convertResponseToLegacyChatCompletion
} from './convert.js';

import {
  validateResponsesRequest,
  validateChatCompletionRequest,
  validateTranscriptionRequest,
  validateImageRequest,
  validateEmbeddingRequest
} from './validate.js';

export type { ChatParams, VisionParams, TranscriptionParams, ImageParams, EmbeddingParams };

/**
 * Build a Responses API payload from chat-style params.
 */
export function buildResponsesRequest(params: ChatParams): ResponseCreateParamsNonStreaming {
  const draft = buildResponsesDraft(params);
  const normalized = normalizeResponsesDraft(draft);
  const converted = convertNormalizedResponsesToRequest(normalized);
  return validateResponsesRequest(converted);
}

/**
 * Build a Responses API payload for vision analysis.
 */
export function buildVisionResponsesRequest(params: VisionParams): ResponseCreateParamsNonStreaming {
  const draft = buildVisionResponsesDraft(params);
  const normalized = normalizeVisionResponsesDraft(draft);
  const converted = convertNormalizedVisionResponsesToRequest(normalized);
  return validateResponsesRequest(converted);
}

/**
 * Extract text content from a Responses API response.
 */
export { extractResponseOutputText };

/**
 * Convert a Responses API response into a legacy ChatCompletion shape.
 */
export { convertResponseToLegacyChatCompletion };

/**
 * Builds a chat completion request with ARCANOS routing message
 */
export function buildChatCompletionRequest(
  params: ChatParams
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const draft = buildChatCompletionDraft(params);
  const normalized = normalizeChatCompletionDraft(draft);
  const converted = convertNormalizedChatCompletionToRequest(normalized);
  return validateChatCompletionRequest(converted);
}

/**
 * Builds a vision request for image analysis
 */
export function buildVisionRequest(
  params: VisionParams
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const draft = buildVisionChatCompletionDraft(params);
  const normalized = normalizeVisionChatCompletionDraft(draft);
  const converted = convertNormalizedVisionChatCompletionToRequest(normalized);
  return validateChatCompletionRequest(converted);
}

/**
 * Builds a transcription request for audio processing
 */
export function buildTranscriptionRequest(
  params: TranscriptionParams
): OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming {
  const draft = buildTranscriptionDraft(params);
  const normalized = normalizeTranscriptionDraft(draft);
  const converted = convertNormalizedTranscriptionToRequest(normalized);
  return validateTranscriptionRequest(converted);
}

/**
 * Builds an image generation request
 */
export function buildImageRequest(
  params: ImageParams
): OpenAI.Images.ImageGenerateParamsNonStreaming {
  const draft = buildImageDraft(params);
  const normalized = normalizeImageDraft(draft);
  const converted = convertNormalizedImageToRequest(normalized);
  return validateImageRequest(converted);
}

/**
 * Builds an embedding request
 */
export function buildEmbeddingRequest(
  params: EmbeddingParams
): OpenAI.Embeddings.EmbeddingCreateParams {
  const draft = buildEmbeddingDraft(params);
  const normalized = normalizeEmbeddingDraft(draft);
  const converted = convertNormalizedEmbeddingToRequest(normalized);
  return validateEmbeddingRequest(converted);
}

/**
 * Default export for convenience
 */
export default {
  buildChatCompletionRequest,
  buildResponsesRequest,
  buildVisionRequest,
  buildVisionResponsesRequest,
  buildTranscriptionRequest,
  buildImageRequest,
  buildEmbeddingRequest,
  extractResponseOutputText,
  convertResponseToLegacyChatCompletion
};
