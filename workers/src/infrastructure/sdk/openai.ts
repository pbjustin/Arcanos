/**
 * Workers OpenAI Adapter
 *
 * Canonical OpenAI construction boundary for worker runtime.
 * All worker OpenAI access should route through this adapter.
 */

import OpenAI from 'openai';
import { resolveWorkerOpenAIConfig } from './openaiConfig.js';

export type WorkerResponsesCreateParams =
  OpenAI.Responses.ResponseCreateParamsNonStreaming & { stream?: false };
export type WorkerResponsesCreateOptions = Parameters<OpenAI['responses']['create']>[1];
export type WorkerResponsesCreateResult = OpenAI.Responses.Response;

export type WorkerChatCompletionsCreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export type WorkerChatCompletionsCreateOptions =
  Parameters<OpenAI['chat']['completions']['create']>[1];
export type WorkerChatCompletionsCreateResult = OpenAI.Chat.Completions.ChatCompletion;

export type WorkerEmbeddingsCreateParams = Parameters<OpenAI['embeddings']['create']>[0];
export type WorkerEmbeddingsCreateResult = Awaited<ReturnType<OpenAI['embeddings']['create']>>;

/**
 * Worker adapter contract for OpenAI usage.
 */
export interface WorkerOpenAIAdapter {
  responses: {
    create: (
      params: WorkerResponsesCreateParams,
      options?: WorkerResponsesCreateOptions
    ) => Promise<WorkerResponsesCreateResult>;
  };
  chat: {
    completions: {
      create: (
        params: WorkerChatCompletionsCreateParams,
        options?: WorkerChatCompletionsCreateOptions
      ) => Promise<WorkerChatCompletionsCreateResult>;
    };
  };
  embeddings: {
    create: (params: WorkerEmbeddingsCreateParams) => Promise<WorkerEmbeddingsCreateResult>;
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
        options?: WorkerResponsesCreateOptions
      ): Promise<WorkerResponsesCreateResult> => {
        return client.responses.create(params, options);
      }
    },
    chat: {
      completions: {
        create: async (
          params: WorkerChatCompletionsCreateParams,
          options?: WorkerChatCompletionsCreateOptions
        ): Promise<WorkerChatCompletionsCreateResult> => {
          return client.chat.completions.create(params, options);
        }
      }
    },
    embeddings: {
      create: async (params: WorkerEmbeddingsCreateParams): Promise<WorkerEmbeddingsCreateResult> => {
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
