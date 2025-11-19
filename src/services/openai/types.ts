import OpenAI from 'openai';

export type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCompletionResponseFormat =
  OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];

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

export interface CallOpenAICacheEntry {
  response: any;
  output: string;
  model: string;
}

export interface CallOpenAIResult extends CallOpenAICacheEntry {
  cached?: boolean;
}
