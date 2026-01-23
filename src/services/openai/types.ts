import OpenAI from 'openai';

export type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCompletionResponseFormat =
  OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
export type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;

export type ImageSize =
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | '1792x1024'
  | '1024x1792'
  | 'auto';

export interface CallOpenAIOptions {
  systemPrompt?: string;
  messages?: ChatCompletionMessageParam[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  responseFormat?: ChatCompletionResponseFormat;
  user?: string;
  metadata?: Record<string, unknown>;
}

/**
 * OpenAI ChatCompletion response wrapper with typed response
 * @confidence 1.0 - Full type safety from OpenAI SDK
 */
export interface CallOpenAICacheEntry {
  response: ChatCompletion;
  output: string;
  model: string;
}

export interface CallOpenAIResult extends CallOpenAICacheEntry {
  cached?: boolean;
}
