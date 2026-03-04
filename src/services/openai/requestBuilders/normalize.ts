import type { ChatCompletionMessageParam } from '../types.js';
import type { ResponseInput } from 'openai/resources/responses/responses';

import { getRoutingMessage } from '@arcanos/openai/unifiedClient';
import { getTokenParameter } from '@shared/tokenParameterHelper.js';
import { extractTextFromContentParts } from '@arcanos/openai/responseParsing';

import type {
  ResponsesRequestDraft,
  VisionResponsesDraft,
  ChatCompletionDraft,
  VisionChatCompletionDraft,
  TranscriptionDraft,
  ImageDraft,
  EmbeddingDraft
} from './build.js';

export interface NormalizedResponsesRequest {
  model: string;
  temperature: number;
  top_p: number;
  maxOutputTokens: number;
  instructionText: string;
  input: ResponseInput;
  responseFormat?: unknown;
  user?: string;
}

export interface NormalizedVisionResponsesRequest {
  model: string;
  temperature: number;
  maxOutputTokens: number;
  input: ResponseInput;
}

export interface NormalizedChatCompletionRequest {
  model: string;
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  tokenParams: Record<string, unknown>;
  preparedMessages: ChatCompletionMessageParam[];
  responseFormat?: unknown;
  user?: string;
}

export interface NormalizedVisionChatCompletionRequest {
  model: string;
  temperature: number;
  tokenParams: Record<string, unknown>;
  messages: ChatCompletionMessageParam[];
}

export type NormalizedTranscriptionRequest = TranscriptionDraft;
export type NormalizedImageRequest = ImageDraft;
export type NormalizedEmbeddingRequest = EmbeddingDraft;

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return extractTextFromContentParts(content, { includeOutputText: false });
}

function ensureRoutingMessage(messages: ChatCompletionMessageParam[], enabled: boolean): ChatCompletionMessageParam[] {
  if (!enabled) return messages;
  const routingText = getRoutingMessage();
  const hasRoutingMessage = messages.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(routingText)
  );
  if (hasRoutingMessage) return messages;
  return [{ role: 'system', content: routingText }, ...messages];
}

export function normalizeResponsesDraft(draft: ResponsesRequestDraft): NormalizedResponsesRequest {
  const routedMessages = ensureRoutingMessage(draft.preparedMessages, draft.includeRoutingMessage);

  const developerText = routedMessages
    .filter((message) => message.role === 'system')
    .map((message) => normalizeMessageContent(message.content))
    .filter((value) => value.length > 0)
    .join('\n\n');

  const responseInput = routedMessages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const contentText = normalizeMessageContent(message.content);
      const mappedRole = message.role === 'assistant' ? 'assistant' : 'user';
      const contentType = mappedRole === 'assistant' ? 'output_text' : 'input_text';
      return {
        role: mappedRole,
        content: [{ type: contentType, text: contentText.length > 0 ? contentText : draft.prompt }]
      };
    });

  const tokenParameters = getTokenParameter(draft.model || 'gpt-4.1-mini', draft.maxTokens);
  const maxOutputTokens = (tokenParameters as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens
    || (tokenParameters as { max_tokens?: number }).max_tokens
    || draft.maxTokens;

  const baseInput = (responseInput.length > 0
    ? responseInput
    : [{ role: 'user', content: [{ type: 'input_text', text: draft.prompt }] }]) as unknown as ResponseInput;

  // Use a developer role message for system/instructions so we can preserve "developer" semantics in Responses.
  // This is the recommended pattern for reasoning models; system content is carried as a developer instruction.
  const input = (developerText && developerText.length > 0
    ? ([{ role: 'developer', content: [{ type: 'input_text', text: developerText }] }, ...(baseInput as any[])] as any)
    : baseInput) as unknown as ResponseInput;

  return {
    model: draft.model || 'gpt-4.1-mini',
    temperature: draft.temperature,
    top_p: draft.top_p,
    maxOutputTokens,
    instructionText: '',
    input,
    responseFormat: draft.responseFormat,
    user: draft.user
  };
}

export function normalizeVisionResponsesDraft(draft: VisionResponsesDraft): NormalizedVisionResponsesRequest {
  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: draft.prompt },
        {
          type: 'input_image',
          image_url: `data:${draft.mimeType};base64,${draft.imageBase64}`
        }
      ]
    }
  ] as unknown as ResponseInput;

  return {
    model: draft.model,
    temperature: draft.temperature,
    maxOutputTokens: draft.maxTokens,
    input
  };
}

export function normalizeChatCompletionDraft(draft: ChatCompletionDraft): NormalizedChatCompletionRequest {
  const routedMessages = ensureRoutingMessage(draft.preparedMessages, draft.includeRoutingMessage);
  const tokenParams = getTokenParameter(draft.model || 'gpt-4o-mini', draft.maxTokens) as unknown as Record<string, unknown>;

  return {
    model: draft.model || 'gpt-4o-mini',
    temperature: draft.temperature,
    top_p: draft.top_p,
    frequency_penalty: draft.frequency_penalty,
    presence_penalty: draft.presence_penalty,
    tokenParams,
    preparedMessages: routedMessages,
    responseFormat: draft.responseFormat,
    user: draft.user
  };
}

export function normalizeVisionChatCompletionDraft(draft: VisionChatCompletionDraft): NormalizedVisionChatCompletionRequest {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: draft.prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${draft.mimeType};base64,${draft.imageBase64}`,
            detail: draft.detail
          }
        }
      ]
    }
  ];

  const tokenParams = getTokenParameter(draft.model, draft.maxTokens) as unknown as Record<string, unknown>;

  return {
    model: draft.model,
    temperature: draft.temperature,
    tokenParams,
    messages
  };
}

export function normalizeTranscriptionDraft(draft: TranscriptionDraft): NormalizedTranscriptionRequest {
  return draft;
}

export function normalizeImageDraft(draft: ImageDraft): NormalizedImageRequest {
  return draft;
}

export function normalizeEmbeddingDraft(draft: EmbeddingDraft): NormalizedEmbeddingRequest {
  return draft;
}
