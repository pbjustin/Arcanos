/**
 * Workers OpenAI Adapter
 *
 * Canonical OpenAI construction boundary for worker runtime.
 * All worker OpenAI access should route through this adapter.
 */

import OpenAI from 'openai';
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

interface WorkerLegacyUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

function normalizeWorkerMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
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
    .filter((value) => value.length > 0)
    .join('\n');
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

function extractWorkerOutputText(response: OpenAIResponse): string {
  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string' && outputText.trim().length > 0) {
    return outputText.trim();
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
        return typedContentItem.text.trim();
      }
    }
  }
  return '';
}

function convertWorkerResponseToChatCompletion(response: OpenAIResponse, requestedModel: string): ChatCompletion {
  const usage = (response.usage ?? {}) as WorkerLegacyUsageShape;
  const promptTokens = Number.isFinite(usage.input_tokens) ? Number(usage.input_tokens) : 0;
  const completionTokens = Number.isFinite(usage.output_tokens) ? Number(usage.output_tokens) : 0;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? Number(usage.total_tokens)
    : promptTokens + completionTokens;
  const createdAt = (response as { created_at?: unknown }).created_at;

  return {
    id: response.id || `worker_legacy_${Date.now()}`,
    object: 'chat.completion',
    created: typeof createdAt === 'number' ? Math.floor(createdAt) : Math.floor(Date.now() / 1000),
    model: response.model || requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: extractWorkerOutputText(response),
          refusal: null
        },
        finish_reason: 'stop',
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    }
  };
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
  const OpenAIClient = OpenAI;
  const client = new OpenAIClient({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    ...(config.baseURL ? { baseURL: config.baseURL } : {})
  });

  return {
    responses: {
      create: async (
        params: ResponseCreateParamsNonStreaming,
        options?: WorkerOpenAIRequestOptions
      ): Promise<OpenAIResponse> => {
        //audit Assumption: worker OpenAI requests should default to Responses API; risk: endpoint drift between runtime surfaces; invariant: worker adapter exposes responses boundary; handling: delegate to SDK responses.create.
        return client.responses.create(params, options);
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
          const response = await client.responses.create(responsePayload, options);
          return convertWorkerResponseToChatCompletion(response, String(nonStreamingParams.model || config.defaultChatModel));
        }
      }
    },
    embeddings: {
      create: async (params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> => {
        return client.embeddings.create(params);
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
