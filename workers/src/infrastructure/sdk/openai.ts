/**
 * Workers OpenAI Adapter
 *
 * Canonical OpenAI construction boundary for worker runtime.
 * All worker OpenAI access should route through this adapter.
 */

import type OpenAI from 'openai';
import { createOpenAIClient } from '@arcanos/openai/client';
import { retryWithBackoff } from '@arcanos/openai/retry';
import { extractTextFromContentParts } from '@arcanos/openai/responseParsing';
import {
  attachOpenAIResponsesMetadataToChatCompletion,
  normalizeOpenAIResponseForLegacyChat
} from '@arcanos/openai/responses';
import type { ChatCompletion, ChatCompletionCreateParams } from 'openai/resources/chat/completions.js';
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from 'openai/resources/embeddings.js';
import type { Response as OpenAIResponse, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { resolveWorkerOpenAIConfig } from './openaiConfig.js';

/**
 * Worker adapter request options.
 */
export interface WorkerOpenAIRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Worker adapter contract for OpenAI usage.
 */
export interface WorkerOpenAIAdapter {
  responses: {
    create: (
      params: ResponseCreateParamsNonStreaming,
      options?: WorkerOpenAIRequestOptions
    ) => Promise<OpenAIResponse>;
  };
  chat: {
    completions: {
      create: (
        params: ChatCompletionCreateParams,
        options?: WorkerOpenAIRequestOptions
      ) => Promise<ChatCompletion>;
    };
  };
  embeddings: {
    create: (params: EmbeddingCreateParams) => Promise<CreateEmbeddingResponse>;
  };
  getClient: () => OpenAI;
  getDefaults: () => { chatModel: string; embeddingModel: string };
}

function normalizeWorkerMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return extractTextFromContentParts(content, { includeOutputText: false });
}

function buildWorkerResponsesPayload(params: ChatCompletionCreateParams): ResponseCreateParamsNonStreaming {
  const typedMessages = Array.isArray(params.messages) ? params.messages : [];
  const instructions: string[] = [];
  const inputItems: Array<{ role: 'assistant' | 'user'; content: Array<{ type: 'input_text'; text: string }> }> = [];

  for (const message of typedMessages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const typedMessage = message as { role?: unknown; content?: unknown };
    const role = String(typedMessage.role ?? '');
    const text = normalizeWorkerMessageContent(typedMessage.content);

    //audit Assumption: system/developer messages should map to responses instructions; risk: policy drift in user input; invariant: instructions remain separate; handling: aggregate instruction text.
    if (role === 'system' || role === 'developer') {
      if (text.length > 0) {
        instructions.push(text);
      }
      continue;
    }

    inputItems.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'input_text', text: text.length > 0 ? text : ' ' }]
    });
  }

  const withCompletionTokens = params as ChatCompletionCreateParams & { max_completion_tokens?: unknown };
  const withMaxTokens = params as ChatCompletionCreateParams & { max_tokens?: unknown };
  const maxOutputTokens = typeof withCompletionTokens.max_completion_tokens === 'number'
    ? withCompletionTokens.max_completion_tokens
    : typeof withMaxTokens.max_tokens === 'number'
      ? withMaxTokens.max_tokens
      : undefined;

  const payload: ResponseCreateParamsNonStreaming = {
    model: params.model,
    input: (inputItems.length > 0
      ? inputItems
      : [{ role: 'user', content: [{ type: 'input_text', text: ' ' }] }]) as never
  };

  if (instructions.length > 0) {
    payload.instructions = instructions.join('\n\n');
  }
  if (typeof params.temperature === 'number') {
    payload.temperature = params.temperature;
  }
  if (typeof params.top_p === 'number') {
    payload.top_p = params.top_p;
  }
  if (typeof maxOutputTokens === 'number') {
    payload.max_output_tokens = maxOutputTokens;
  }
  if (typeof params.user === 'string' && params.user.trim().length > 0) {
    payload.metadata = { user: params.user };
  }

  return payload;
}

function convertWorkerResponseToChatCompletion(response: OpenAIResponse, requestedModel: string): ChatCompletion {
  const semantics = normalizeOpenAIResponseForLegacyChat(response);
  const createdAt = (response as { created_at?: unknown }).created_at;

  const legacyResponse: ChatCompletion = {
    id: response.id || `worker_legacy_${Date.now()}`,
    object: 'chat.completion',
    created: typeof createdAt === 'number' ? Math.floor(createdAt) : Math.floor(Date.now() / 1000),
    model: response.model || requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: semantics.content,
          refusal: semantics.refusal,
          ...(semantics.toolCalls.length > 0
            ? { tool_calls: semantics.toolCalls }
            : {})
        },
        finish_reason: semantics.finishReason,
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: semantics.usage.promptTokens,
      completion_tokens: semantics.usage.completionTokens,
      total_tokens: semantics.usage.totalTokens
    }
  };

  return attachOpenAIResponsesMetadataToChatCompletion(
    legacyResponse,
    response,
    semantics.finishReason,
    semantics
  );
}

let workerAdapterInstance: WorkerOpenAIAdapter | null = null;

/**
 * Create a worker OpenAI adapter instance.
 *
 * @returns Worker OpenAI adapter.
 */
export function createWorkerOpenAIAdapter(): WorkerOpenAIAdapter {
  const config = resolveWorkerOpenAIConfig();

  //audit Assumption: worker adapter requires a non-empty API key; risk: repeated runtime failures on requests; invariant: initialization blocked without key; handling: throw explicit error.
  if (!config.apiKey) {
    throw new Error('Missing OpenAI API key. Please set OPENAI_API_KEY for worker runtime.');
  }

  //audit Assumption: constructor remains centralized in this module only; risk: accidental duplicate factories; invariant: single worker construction boundary; handling: use localized constructor alias.
  const client = createOpenAIClient({ apiKey: config.apiKey, baseURL: config.baseURL, timeoutMs: config.timeoutMs });
  // NOTE: maxRetries handled by shared retryWithBackoff wrapper where needed.

  return {
    responses: {
      create: async (
        params: ResponseCreateParamsNonStreaming,
        options?: WorkerOpenAIRequestOptions
      ): Promise<OpenAIResponse> => {
        //audit Assumption: worker OpenAI requests should default to Responses API; risk: endpoint drift between runtime surfaces; invariant: worker adapter exposes responses boundary; handling: delegate to SDK responses.create.
        return retryWithBackoff(() => client.responses.create(params, options), { signal: options?.signal });
      }
    },
    chat: {
      completions: {
        create: async (
          params: ChatCompletionCreateParams,
          options?: WorkerOpenAIRequestOptions
        ): Promise<ChatCompletion> => {
          const nonStreamingParams = { ...params, stream: false } as ChatCompletionCreateParams & { stream: false };
          const responsePayload = buildWorkerResponsesPayload(nonStreamingParams);
          //audit Assumption: legacy worker chat callers must execute via Responses API to avoid dual-surface drift; risk: inconsistent behavior between handlers; invariant: single execution surface; handling: translate chat payload, then convert response to legacy chat shape.
          const response = await retryWithBackoff(() => client.responses.create(responsePayload, options), { signal: options?.signal });
          return convertWorkerResponseToChatCompletion(response, String(nonStreamingParams.model || config.defaultChatModel));
        }
      }
    },
    embeddings: {
      create: async (params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> => {
        return retryWithBackoff(() => client.embeddings.create(params));
      }
    },
    getClient: () => client,
    getDefaults: () => ({
      chatModel: config.defaultChatModel,
      embeddingModel: config.defaultEmbeddingModel
    })
  };
}

/**
 * Get or create singleton worker OpenAI adapter.
 *
 * @returns Worker OpenAI adapter singleton.
 */
export function getWorkerOpenAIAdapter(): WorkerOpenAIAdapter {
  if (!workerAdapterInstance) {
    workerAdapterInstance = createWorkerOpenAIAdapter();
  }
  return workerAdapterInstance;
}

/**
 * Reset worker OpenAI adapter singleton.
 */
export function resetWorkerOpenAIAdapter(): void {
  workerAdapterInstance = null;
}

/**
 * Whether worker OpenAI adapter singleton is initialized.
 *
 * @returns True when initialized.
 */
export function isWorkerOpenAIAdapterInitialized(): boolean {
  return workerAdapterInstance !== null;
}

export default {
  createWorkerOpenAIAdapter,
  getWorkerOpenAIAdapter,
  resetWorkerOpenAIAdapter,
  isWorkerOpenAIAdapterInitialized
};
