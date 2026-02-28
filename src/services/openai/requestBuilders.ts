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
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInput
} from 'openai/resources/responses/responses';
import type { ChatCompletionMessageParam, ChatCompletionResponseFormat, ImageSize } from './types.js';
import { ARCANOS_ROUTING_MESSAGE } from './unifiedClient.js';
import { getTokenParameter } from "@shared/tokenParameterHelper.js";
import { buildSystemPromptMessages } from "@shared/messageBuilderUtils.js";
import { DEFAULT_IMAGE_SIZE, IMAGE_GENERATION_MODEL, ROUTING_MAX_TOKENS } from './config.js';
import { OPENAI_COMPLETION_DEFAULTS } from "./constants.js";

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
  /** MIME type for image (default: image/png) */
  mimeType?: string;
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

interface LegacyUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') {
          return '';
        }
        const typedPart = part as Record<string, unknown>;
        if (typedPart.type === 'text' && typeof typedPart.text === 'string') {
          return typedPart.text;
        }
        if (typedPart.type === 'input_text' && typeof typedPart.text === 'string') {
          return typedPart.text;
        }
        return '';
      })
      .filter((part) => part.length > 0)
      .join('\n');
  }

  return '';
}

function extractUsage(usage: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const typedUsage = (usage ?? {}) as LegacyUsageShape;
  const promptTokens = Number.isFinite(typedUsage.input_tokens) ? Number(typedUsage.input_tokens) : 0;
  const completionTokens = Number.isFinite(typedUsage.output_tokens) ? Number(typedUsage.output_tokens) : 0;
  const totalTokens = Number.isFinite(typedUsage.total_tokens)
    ? Number(typedUsage.total_tokens)
    : promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

/**
 * Build a Responses API payload from chat-style params.
 *
 * Purpose:
 * - Canonicalize runtime request construction on Responses API.
 * Inputs/Outputs:
 * - Input: chat-oriented params used across legacy call sites.
 * - Output: OpenAI Responses non-streaming payload.
 * Edge cases:
 * - Empty/unsupported message parts are normalized to text.
 */
export function buildResponsesRequest(
  params: ChatParams
): ResponseCreateParamsNonStreaming {
  const {
    prompt,
    systemPrompt,
    model,
    maxTokens = ROUTING_MAX_TOKENS,
    temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE,
    top_p = OPENAI_COMPLETION_DEFAULTS.TOP_P,
    messages,
    includeRoutingMessage = true,
    responseFormat,
    user
  } = params;

  let preparedMessages: ChatCompletionMessageParam[] =
    messages && messages.length > 0 ? [...messages] : buildSystemPromptMessages(prompt, systemPrompt);

  //audit Assumption: routing guard message must be prepended exactly once; risk: missing routing behavior or duplicate instructions; invariant: one routing system message present when enabled; handling: detect then prepend if absent.
  if (includeRoutingMessage) {
    const hasRoutingMessage = preparedMessages.some(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes(ARCANOS_ROUTING_MESSAGE)
    );
    if (!hasRoutingMessage) {
      preparedMessages = [{ role: 'system', content: ARCANOS_ROUTING_MESSAGE }, ...preparedMessages];
    }
  }

  const instructionText = preparedMessages
    .filter((message) => message.role === 'system')
    .map((message) => normalizeMessageContent(message.content))
    .filter((value) => value.length > 0)
    .join('\n\n');

  const responseInput = preparedMessages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const contentText = normalizeMessageContent(message.content);
      return {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'input_text', text: contentText.length > 0 ? contentText : prompt }]
      };
    });

  const tokenParameters = getTokenParameter(model || 'gpt-4.1-mini', maxTokens);
  const maxOutputTokens = tokenParameters.max_completion_tokens || tokenParameters.max_tokens || maxTokens;

  const payload: ResponseCreateParamsNonStreaming = {
    model: model || 'gpt-4.1-mini',
    input: (responseInput.length > 0
      ? responseInput
      : [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]) as unknown as ResponseInput,
    temperature,
    top_p,
    max_output_tokens: maxOutputTokens
  };

  if (instructionText.length > 0) {
    payload.instructions = instructionText;
  }

  //audit Assumption: legacy callers may still request structured JSON; risk: behavior drift when ignored; invariant: format hints forwarded when recognizable; handling: map supported response_format types to Responses text.format.
  if (responseFormat && typeof responseFormat === 'object' && 'type' in responseFormat) {
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

  if (user) {
    payload.metadata = { user };
  }

  return payload;
}

/**
 * Build a Responses API payload for vision analysis.
 *
 * @param params - Vision request parameters.
 * @returns Responses API payload.
 */
export function buildVisionResponsesRequest(
  params: VisionParams
): ResponseCreateParamsNonStreaming {
  const {
    prompt,
    imageBase64,
    mimeType = 'image/png',
    model = 'gpt-4o',
    maxTokens = ROUTING_MAX_TOKENS,
    temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE
  } = params;

  return {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          {
            type: 'input_image',
            image_url: `data:${mimeType};base64,${imageBase64}`
          }
        ]
      }
    ] as unknown as ResponseInput,
    temperature,
    max_output_tokens: maxTokens
  };
}

/**
 * Extract text content from a Responses API response.
 *
 * @param response - Responses API response payload.
 * @param fallback - Fallback text when no output text is present.
 * @returns Normalized output text.
 */
export function extractResponseOutputText(response: OpenAIResponse, fallback = ''): string {
  const typedOutputText = (response as { output_text?: unknown }).output_text;
  if (typeof typedOutputText === 'string' && typedOutputText.trim().length > 0) {
    return typedOutputText.trim();
  }

  const outputItems = Array.isArray(response.output) ? response.output : [];
  for (const outputItem of outputItems) {
    if (!outputItem || typeof outputItem !== 'object') {
      continue;
    }
    const typedOutputItem = outputItem as unknown as Record<string, unknown>;
    const contentItems = Array.isArray(typedOutputItem.content) ? typedOutputItem.content : [];
    for (const contentItem of contentItems) {
      if (!contentItem || typeof contentItem !== 'object') {
        continue;
      }
      const typedContentItem = contentItem as Record<string, unknown>;
      if (typedContentItem.type === 'output_text' && typeof typedContentItem.text === 'string') {
        const normalizedText = typedContentItem.text.trim();
        if (normalizedText.length > 0) {
          return normalizedText;
        }
      }
    }
  }

  return fallback;
}

/**
 * Convert a Responses API response into a legacy ChatCompletion shape.
 *
 * Purpose:
 * - Preserve compatibility with existing consumers while migrating internals.
 * Inputs/Outputs:
 * - Input: Responses API response + requested model.
 * - Output: ChatCompletion-compatible object.
 * Edge cases:
 * - Missing usage metadata falls back to zero-valued token counts.
 */
export function convertResponseToLegacyChatCompletion(
  response: OpenAIResponse,
  requestedModel: string
): OpenAI.Chat.Completions.ChatCompletion {
  const outputText = extractResponseOutputText(response, '');
  const usage = extractUsage(response.usage);
  const createdSource = (response as { created_at?: unknown }).created_at;
  const created = typeof createdSource === 'number'
    ? Math.floor(createdSource)
    : Math.floor(Date.now() / 1000);

  return {
    id: response.id || `legacy_${Date.now()}`,
    object: 'chat.completion',
    created,
    model: response.model || requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: outputText,
          refusal: null
        },
        finish_reason: 'stop',
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens
    }
  };
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
    mimeType = 'image/png',
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
            url: `data:${mimeType};base64,${imageBase64}`,
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
): OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming {
  const {
    audioFile,
    filename,
    model = 'whisper-1',
    language,
    responseFormat = 'json',
    temperature
  } = params;

  const requestParams: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming = {
    file: audioFile as File,
    model,
    response_format: responseFormat,
    stream: false
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
): OpenAI.Images.ImageGenerateParamsNonStreaming {
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
    response_format: responseFormat,
    stream: false
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
  buildResponsesRequest,
  buildVisionRequest,
  buildVisionResponsesRequest,
  buildTranscriptionRequest,
  buildImageRequest,
  buildEmbeddingRequest,
  extractResponseOutputText,
  convertResponseToLegacyChatCompletion
};
