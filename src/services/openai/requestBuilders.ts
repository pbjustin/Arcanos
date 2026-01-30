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
import type { ChatCompletionMessageParam, ChatCompletionResponseFormat, ImageSize } from './types.js';
import { ARCANOS_ROUTING_MESSAGE } from './unifiedClient.js';
import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { buildSystemPromptMessages } from '../../utils/messageBuilderUtils.js';
import { DEFAULT_IMAGE_SIZE, IMAGE_GENERATION_MODEL, ROUTING_MAX_TOKENS } from './config.js';
import { OPENAI_COMPLETION_DEFAULTS } from './constants.js';

/**
 * Chat completion request parameters
 */
export interface ChatParams {
  /** User prompt/message */
  prompt: string;
  /** System prompt (optional, ARCANOS routing message will be prepended) */
  systemPrompt?: string;
  /** Model to use (defaults to configured default model) */
  model?: string;
  /** Maximum tokens for completion */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Top-p sampling */
  top_p?: number;
  /** Frequency penalty */
  frequency_penalty?: number;
  /** Presence penalty */
  presence_penalty?: number;
  /** Response format */
  responseFormat?: ChatCompletionResponseFormat;
  /** User identifier */
  user?: string;
  /** Conversation history */
  messages?: ChatCompletionMessageParam[];
  /** Whether to include ARCANOS routing message (default: true) */
  includeRoutingMessage?: boolean;
}

/**
 * Vision request parameters
 */
export interface VisionParams {
  /** User prompt describing the image */
  prompt: string;
  /** Base64-encoded image data */
  imageBase64: string;
  /** Model to use (defaults to vision model) */
  model?: string;
  /** Maximum tokens for completion */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Image detail level */
  detail?: 'low' | 'high' | 'auto';
}

/**
 * Transcription request parameters
 */
export interface TranscriptionParams {
  /** Audio file data */
  audioFile: File | Blob | Buffer;
  /** Filename for the audio file */
  filename: string;
  /** Model to use (defaults to transcription model) */
  model?: string;
  /** Language code (optional) */
  language?: string;
  /** Response format */
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  /** Temperature */
  temperature?: number;
}

/**
 * Image generation request parameters
 */
export interface ImageParams {
  /** Text prompt describing the desired image */
  prompt: string;
  /** Image size */
  size?: ImageSize;
  /** Model to use (defaults to image generation model) */
  model?: string;
  /** Quality setting */
  quality?: 'standard' | 'hd';
  /** Number of images to generate */
  n?: number;
  /** Response format */
  responseFormat?: 'url' | 'b64_json';
}

/**
 * Embedding request parameters
 */
export interface EmbeddingParams {
  /** Text to embed */
  input: string | string[];
  /** Model to use */
  model: string;
  /** User identifier */
  user?: string;
}

/**
 * Builds a chat completion request with ARCANOS routing message
 * 
 * Automatically prepends ARCANOS routing message to ensure proper
 * model routing and behavior. This is the standard way to create
 * chat completion requests in the codebase.
 * 
 * @param params - Chat completion parameters
 * @returns OpenAI chat completion request parameters
 */
export function buildChatCompletionRequest(
  params: ChatParams
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const {
    prompt,
    systemPrompt,
    model,
    maxTokens = ROUTING_MAX_TOKENS,
    temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE,
    top_p = OPENAI_COMPLETION_DEFAULTS.TOP_P,
    frequency_penalty = OPENAI_COMPLETION_DEFAULTS.FREQUENCY_PENALTY,
    presence_penalty = OPENAI_COMPLETION_DEFAULTS.PRESENCE_PENALTY,
    responseFormat,
    user,
    messages,
    includeRoutingMessage = true
  } = params;

  // Build messages array
  let preparedMessages: ChatCompletionMessageParam[];

  if (messages && messages.length > 0) {
    preparedMessages = [...messages];
  } else {
    preparedMessages = buildSystemPromptMessages(prompt, systemPrompt);
  }

  // Prepend ARCANOS routing message if requested
  if (includeRoutingMessage) {
    const hasRoutingMessage = preparedMessages.some(
      msg => msg.role === 'system' && 
      typeof msg.content === 'string' && 
      msg.content.includes(ARCANOS_ROUTING_MESSAGE)
    );

    if (!hasRoutingMessage) {
      preparedMessages = [
        { role: 'system', content: ARCANOS_ROUTING_MESSAGE },
        ...preparedMessages
      ];
    }
  }

  // Get token parameters for the model
  const tokenParams = getTokenParameter(model || 'gpt-4o-mini', maxTokens);

  // Build request payload
  const requestPayload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: model || 'gpt-4o-mini',
    messages: preparedMessages,
    stream: false,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    ...tokenParams
  };

  if (responseFormat) {
    requestPayload.response_format = responseFormat;
  }

  if (user) {
    requestPayload.user = user;
  }

  return requestPayload;
}

/**
 * Builds a vision request for image analysis
 * 
 * Creates a properly formatted vision request with image data
 * and user prompt.
 * 
 * @param params - Vision request parameters
 * @returns OpenAI chat completion request parameters for vision
 */
export function buildVisionRequest(
  params: VisionParams
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const {
    prompt,
    imageBase64,
    model = 'gpt-4o',
    maxTokens = ROUTING_MAX_TOKENS,
    temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE,
    detail = 'auto'
  } = params;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${imageBase64}`,
            detail
          }
        }
      ]
    }
  ];

  const tokenParams = getTokenParameter(model, maxTokens);

  return {
    model,
    messages,
    stream: false,
    temperature,
    ...tokenParams
  };
}

/**
 * Builds a transcription request for audio processing
 * 
 * Creates a properly formatted transcription request with audio file.
 * 
 * @param params - Transcription request parameters
 * @returns OpenAI transcription request parameters
 */
export function buildTranscriptionRequest(
  params: TranscriptionParams
): OpenAI.Audio.Transcriptions.TranscriptionCreateParams {
  const {
    audioFile,
    filename,
    model = 'whisper-1',
    language,
    responseFormat = 'json',
    temperature
  } = params;

  const requestParams: OpenAI.Audio.Transcriptions.TranscriptionCreateParams = {
    file: audioFile as File,
    model,
    response_format: responseFormat
  };

  if (language) {
    requestParams.language = language;
  }

  if (temperature !== undefined) {
    requestParams.temperature = temperature;
  }

  return requestParams;
}

/**
 * Builds an image generation request
 * 
 * Creates a properly formatted image generation request.
 * 
 * @param params - Image generation parameters
 * @returns OpenAI image generation request parameters
 */
export function buildImageRequest(
  params: ImageParams
): OpenAI.Images.ImageGenerateParams {
  const {
    prompt,
    size = DEFAULT_IMAGE_SIZE,
    model = IMAGE_GENERATION_MODEL,
    quality = 'standard',
    n = 1,
    responseFormat = 'b64_json'
  } = params;

  return {
    model,
    prompt,
    size,
    quality,
    n,
    response_format: responseFormat
  };
}

/**
 * Builds an embedding request
 * 
 * Creates a properly formatted embedding request.
 * 
 * @param params - Embedding parameters
 * @returns OpenAI embedding request parameters
 */
export function buildEmbeddingRequest(
  params: EmbeddingParams
): OpenAI.Embeddings.EmbeddingCreateParams {
  const { input, model, user } = params;

  const requestParams: OpenAI.Embeddings.EmbeddingCreateParams = {
    model,
    input
  };

  if (user) {
    requestParams.user = user;
  }

  return requestParams;
}

/**
 * Default export for convenience
 */
export default {
  buildChatCompletionRequest,
  buildVisionRequest,
  buildTranscriptionRequest,
  buildImageRequest,
  buildEmbeddingRequest
};
