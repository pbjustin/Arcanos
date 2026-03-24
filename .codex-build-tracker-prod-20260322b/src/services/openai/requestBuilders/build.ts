import type { ChatCompletionMessageParam, ChatCompletionResponseFormat, ImageSize } from '../types.js';
import { buildSystemPromptMessages } from '@shared/messageBuilderUtils.js';
import { DEFAULT_IMAGE_SIZE, IMAGE_GENERATION_MODEL, ROUTING_MAX_TOKENS } from '../config.js';
import { OPENAI_COMPLETION_DEFAULTS } from '../constants.js';

import type { ChatParams, VisionParams, TranscriptionParams, ImageParams, EmbeddingParams } from './types.js';

export interface ResponsesRequestDraft {
  kind: 'responses.chat';
  prompt: string;
  systemPrompt?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  top_p: number;
  includeRoutingMessage: boolean;
  responseFormat?: ChatCompletionResponseFormat;
  user?: string;
  preparedMessages: ChatCompletionMessageParam[];
}

export interface VisionResponsesDraft {
  kind: 'responses.vision';
  prompt: string;
  imageBase64: string;
  mimeType: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface ChatCompletionDraft {
  kind: 'chat.completions';
  prompt: string;
  systemPrompt?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  includeRoutingMessage: boolean;
  responseFormat?: ChatCompletionResponseFormat;
  user?: string;
  preparedMessages: ChatCompletionMessageParam[];
}

export interface VisionChatCompletionDraft {
  kind: 'chat.completions.vision';
  prompt: string;
  imageBase64: string;
  mimeType: string;
  detail: 'low' | 'high' | 'auto';
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface TranscriptionDraft {
  kind: 'audio.transcriptions';
  audioFile: File | Blob | Buffer;
  filename: string;
  model: string;
  language?: string;
  responseFormat: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
}

export interface ImageDraft {
  kind: 'images.generate';
  prompt: string;
  size: ImageSize;
  model: string;
  quality: 'standard' | 'hd';
  n: number;
  responseFormat: 'url' | 'b64_json';
}

export interface EmbeddingDraft {
  kind: 'embeddings';
  input: string | string[];
  model: string;
  user?: string;
}

export function buildResponsesDraft(params: ChatParams): ResponsesRequestDraft {
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

  const preparedMessages: ChatCompletionMessageParam[] =
    messages && messages.length > 0 ? [...messages] : buildSystemPromptMessages(prompt, systemPrompt);

  return {
    kind: 'responses.chat',
    prompt,
    systemPrompt,
    model: model || 'gpt-4.1-mini',
    maxTokens,
    temperature,
    top_p,
    includeRoutingMessage,
    responseFormat,
    user,
    preparedMessages
  };
}

export function buildVisionResponsesDraft(params: VisionParams): VisionResponsesDraft {
  const {
    prompt,
    imageBase64,
    mimeType = 'image/png',
    model = 'gpt-4o',
    maxTokens = ROUTING_MAX_TOKENS,
    temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE
  } = params;

  return {
    kind: 'responses.vision',
    prompt,
    imageBase64,
    mimeType,
    model,
    maxTokens,
    temperature
  };
}

export function buildChatCompletionDraft(params: ChatParams): ChatCompletionDraft {
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

  const preparedMessages: ChatCompletionMessageParam[] =
    messages && messages.length > 0 ? [...messages] : buildSystemPromptMessages(prompt, systemPrompt);

  return {
    kind: 'chat.completions',
    prompt,
    systemPrompt,
    model: model || 'gpt-4o-mini',
    maxTokens,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    includeRoutingMessage,
    responseFormat,
    user,
    preparedMessages
  };
}

export function buildVisionChatCompletionDraft(params: VisionParams): VisionChatCompletionDraft {
  const {
    prompt,
    imageBase64,
    mimeType = 'image/png',
    model = 'gpt-4o',
    maxTokens = ROUTING_MAX_TOKENS,
    temperature = OPENAI_COMPLETION_DEFAULTS.TEMPERATURE,
    detail = 'auto'
  } = params;

  return {
    kind: 'chat.completions.vision',
    prompt,
    imageBase64,
    mimeType,
    detail,
    model,
    maxTokens,
    temperature
  };
}

export function buildTranscriptionDraft(params: TranscriptionParams): TranscriptionDraft {
  const {
    audioFile,
    filename,
    model = 'whisper-1',
    language,
    responseFormat = 'json',
    temperature
  } = params;

  return {
    kind: 'audio.transcriptions',
    audioFile,
    filename,
    model,
    language,
    responseFormat,
    temperature
  };
}

export function buildImageDraft(params: ImageParams): ImageDraft {
  const {
    prompt,
    size = DEFAULT_IMAGE_SIZE,
    model = IMAGE_GENERATION_MODEL,
    quality = 'standard',
    n = 1,
    responseFormat = 'b64_json'
  } = params;

  return {
    kind: 'images.generate',
    prompt,
    size,
    model,
    quality,
    n,
    responseFormat
  };
}

export function buildEmbeddingDraft(params: EmbeddingParams): EmbeddingDraft {
  const { input, model, user } = params;
  return {
    kind: 'embeddings',
    input,
    model,
    user
  };
}
