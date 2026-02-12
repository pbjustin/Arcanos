/**
 * OpenAI Adapter
 * 
 * Primary adapter boundary for application OpenAI SDK usage.
 * Route/service call sites should use this adapter instead of instantiating SDK clients directly.
 * 
 * Rules:
 * - Route/service OpenAI SDK calls must go through this adapter
 * - Adapter receives config via arguments (no process.env access)
 * - Modern SDK usage only (no legacy ChatCompletion.create)
 * - Single client factory pattern
 */

import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParams } from 'openai/resources/chat/completions.js';
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from 'openai/resources/embeddings.js';
import type { Transcription, TranscriptionCreateParamsNonStreaming } from 'openai/resources/audio/transcriptions.js';
import type { ImageGenerateParamsNonStreaming, ImagesResponse } from 'openai/resources/images.js';

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
  /** Max retries for transient errors */
  maxRetries?: number;
  /** Default model for completions */
  defaultModel?: string;
}

/**
 * Supported per-request options for adapter methods.
 * Limited to runtime-safe fields consumed by callers today.
 */
export interface OpenAIAdapterRequestOptions {
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Extra request headers */
  headers?: Record<string, string>;
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
      create: (
        params: ChatCompletionCreateParams,
        options?: OpenAIAdapterRequestOptions
      ) => Promise<ChatCompletion>;
    };
  };

  /**
   * Create embeddings
   */
  embeddings: {
    create: (params: EmbeddingCreateParams) => Promise<CreateEmbeddingResponse>;
  };

  /**
   * Generate images
   */
  images: {
    generate: (
      params: ImageGenerateParamsNonStreaming,
      options?: OpenAIAdapterRequestOptions
    ) => Promise<ImagesResponse>;
  };

  /**
   * Create audio transcription
   */
  audio: {
    transcriptions: {
      create: (params: TranscriptionCreateParamsNonStreaming) => Promise<Transcription>;
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
  //audit Assumption: API key must be provided to initialize SDK client; risk: silent mock usage; invariant: non-empty apiKey; handling: throw early.
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('OpenAI API key is required');
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeout || 60000,
    maxRetries: config.maxRetries,
    ...(config.baseURL ? { baseURL: config.baseURL } : {})
  });

  return {
    chat: {
      completions: {
        create: async (
          params: ChatCompletionCreateParams,
          options?: OpenAIAdapterRequestOptions
        ): Promise<ChatCompletion> => {
          // Ensure stream is false for non-streaming completions
          const nonStreamingParams = { ...params, stream: false } as ChatCompletionCreateParams & { stream: false };
          //audit Assumption: request-level signal/headers may be provided by callers; risk: dropped cancellation/tracing; invariant: options forwarded; handling: pass through to SDK.
          const result = await client.chat.completions.create(nonStreamingParams, options);
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
    images: {
      generate: async (
        params: ImageGenerateParamsNonStreaming,
        options?: OpenAIAdapterRequestOptions
      ): Promise<ImagesResponse> => {
        //audit Assumption: image generation should support trace/cancel request options; risk: untracked long-running calls; invariant: options forwarded; handling: pass through to SDK.
        return client.images.generate(params, options);
      }
    },
    audio: {
      transcriptions: {
        create: async (params: TranscriptionCreateParamsNonStreaming): Promise<Transcription> => {
          return client.audio.transcriptions.create(params);
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

/**
 * Whether the OpenAI adapter singleton is initialized (without throwing).
 * Used by health/readiness so "AI core" reflects the same client used for requests.
 */
export function isOpenAIAdapterInitialized(): boolean {
  return adapterInstance !== null;
}

/**
 * Escape hatch for advanced APIs that are not adapter-modeled yet.
 * Prefer adapter methods for regular chat/image/embed/audio flows.
 */
export function getClient(): OpenAI {
  //audit Assumption: escape hatch should only be used after adapter init; risk: runtime null usage; invariant: initialized adapter required; handling: delegate to getOpenAIAdapter() throw path.
  return getOpenAIAdapter().getClient();
}
