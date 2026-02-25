/**
 * Workers OpenAI Adapter
 *
 * Canonical OpenAI construction boundary for worker runtime.
 * All worker OpenAI access should route through this adapter.
 */

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from 'openai/resources/chat/completions.js';
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from 'openai/resources/embeddings.js';
import { resolveWorkerOpenAIConfig } from './openaiConfig.js';

/**
 * Worker adapter request options.
 */
export interface WorkerOpenAIRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

type WorkerResponsesCreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type WorkerResponsesCreateResult = OpenAI.Responses.Response;

/**
 * Worker adapter contract for OpenAI usage.
 */
export interface WorkerOpenAIAdapter {
  responses: {
    create: (
      params: WorkerResponsesCreateParams,
      options?: WorkerOpenAIRequestOptions
    ) => Promise<WorkerResponsesCreateResult>;
  };
  chat: {
    completions: {
      create: (
        params: ChatCompletionCreateParamsNonStreaming,
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
        params: WorkerResponsesCreateParams,
        options?: WorkerOpenAIRequestOptions
      ): Promise<WorkerResponsesCreateResult> => {
        return client.responses.create(params, options);
      }
    },
    chat: {
      completions: {
        create: async (
          params: ChatCompletionCreateParamsNonStreaming,
          options?: WorkerOpenAIRequestOptions
        ): Promise<ChatCompletion> => {
          return client.chat.completions.create(params, options);
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
