/**
 * OpenAI Adapter
 * 
 * Single adapter boundary for all OpenAI SDK usage.
 * This is the ONLY module that should import 'openai' package.
 * 
 * Rules:
 * - All OpenAI SDK calls must go through this adapter
 * - Adapter receives config via arguments (no process.env access)
 * - Modern SDK usage only (no legacy ChatCompletion.create)
 * - Single client factory pattern
 */

import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParams } from 'openai/resources/chat/completions.js';
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from 'openai/resources/embeddings.js';
import type { Transcription, TranscriptionCreateParams } from 'openai/resources/audio/transcriptions.js';
import type { FileObject } from 'openai/resources/files.js';

/**
 * OpenAI adapter configuration
 * All values must be provided (no env access inside adapter)
 */
export interface OpenAIAdapterConfig {
  /** OpenAI API key (required) */
  apiKey: string;
  /** Base URL (optional, for custom endpoints) */
  baseURL?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Default model for completions */
  defaultModel?: string;
}

/**
 * OpenAI adapter interface
 * Provides type-safe access to OpenAI functionality
 */
export interface OpenAIAdapter {
  /**
   * Create a chat completion
   */
  chat: {
    completions: {
      create: (params: ChatCompletionCreateParams) => Promise<ChatCompletion>;
    };
  };

  /**
   * Create embeddings
   */
  embeddings: {
    create: (params: EmbeddingCreateParams) => Promise<CreateEmbeddingResponse>;
  };

  /**
   * Create audio transcription
   */
  audio: {
    transcriptions: {
      create: (params: {
        file: FileObject | File | Blob | Uint8Array | ArrayBuffer;
        model: string;
        language?: string;
        prompt?: string;
        response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
        temperature?: number;
      }) => Promise<Transcription>;
    };
  };

  /**
   * Get the underlying OpenAI client (for advanced usage)
   * Use sparingly - prefer adapter methods
   */
  getClient: () => OpenAI;
}

/**
 * Creates the OpenAI adapter instance
 * 
 * This is the single factory for OpenAI client creation.
 * All OpenAI SDK usage must go through this adapter.
 * 
 * @param config - Adapter configuration (must include apiKey)
 * @returns OpenAI adapter instance
 * @throws Error if apiKey is missing
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): OpenAIAdapter {
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('OpenAI API key is required');
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeout || 60000,
    ...(config.baseURL ? { baseURL: config.baseURL } : {})
  });

  return {
    chat: {
      completions: {
        create: async (params: ChatCompletionCreateParams): Promise<ChatCompletion> => {
          // Ensure stream is false for non-streaming completions
          const nonStreamingParams = { ...params, stream: false } as ChatCompletionCreateParams & { stream: false };
          const result = await client.chat.completions.create(nonStreamingParams);
          // Type assertion needed because SDK can return Stream | ChatCompletion
          return result as ChatCompletion;
        }
      }
    },
    embeddings: {
      create: async (params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> => {
        return client.embeddings.create(params);
      }
    },
    audio: {
      transcriptions: {
        create: async (params: TranscriptionCreateParams): Promise<Transcription> => {
          // Ensure stream is false for non-streaming transcription
          const nonStreamingParams = { ...params, stream: false } as TranscriptionCreateParams & { stream: false };
          return client.audio.transcriptions.create(nonStreamingParams);
        }
      }
    },
    getClient: () => client
  };
}

/**
 * Singleton adapter instance
 * Created once at application startup and injected into services
 */
let adapterInstance: OpenAIAdapter | null = null;

/**
 * Gets or creates the singleton adapter instance
 * 
 * @param config - Adapter configuration (only used on first call)
 * @returns Singleton adapter instance
 */
export function getOpenAIAdapter(config?: OpenAIAdapterConfig): OpenAIAdapter {
  if (!adapterInstance) {
    if (!config) {
      throw new Error('OpenAI adapter config required for first initialization');
    }
    adapterInstance = createOpenAIAdapter(config);
  }
  return adapterInstance;
}

/**
 * Resets the singleton adapter instance
 * Useful for testing or re-initialization
 */
export function resetOpenAIAdapter(): void {
  adapterInstance = null;
}
