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

type LegacyChatMessage = {
  role?: unknown;
  content?: unknown;
};

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const partRecord = part as Record<string, unknown>;
    const type = typeof partRecord.type === 'string' ? partRecord.type : '';
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = partRecord.text;
      if (typeof text === 'string' && text.length > 0) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('\n');
}

function normalizeInputContentParts(
  role: 'assistant' | 'user',
  content: unknown
): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';

  if (typeof content === 'string') {
    return [{ type: textType, text: content.length > 0 ? content : ' ' }];
  }

  if (!Array.isArray(content)) {
    return [{ type: textType, text: ' ' }];
  }

  const normalizedParts: Array<Record<string, unknown>> = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const partRecord = part as Record<string, unknown>;
    const type = typeof partRecord.type === 'string' ? partRecord.type : '';

    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = partRecord.text;
      if (typeof text === 'string') {
        normalizedParts.push({
          type: textType,
          text: text.length > 0 ? text : ' '
        });
      }
      continue;
    }

    if ((type === 'image_url' || type === 'input_image') && role === 'user') {
      if (type === 'image_url') {
        const imageUrl = partRecord.image_url;
        if (imageUrl && typeof imageUrl === 'object') {
          const imageUrlRecord = imageUrl as Record<string, unknown>;
          const url = typeof imageUrlRecord.url === 'string' ? imageUrlRecord.url : undefined;
          if (url) {
            normalizedParts.push({
              type: 'input_image',
              image_url: url,
              ...(typeof imageUrlRecord.detail === 'string' ? { detail: imageUrlRecord.detail } : {})
            });
          }
        } else if (typeof imageUrl === 'string') {
          normalizedParts.push({ type: 'input_image', image_url: imageUrl });
        }
        continue;
      }

      normalizedParts.push(partRecord);
    }
  }

  if (normalizedParts.length === 0) {
    return [{ type: textType, text: ' ' }];
  }

  return normalizedParts;
}

function collectInstructionFragments(messages: LegacyChatMessage[]): string[] {
  const fragments: string[] = [];

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : '';
    if (role !== 'system' && role !== 'developer') {
      continue;
    }

    const text = extractTextFromContent(message.content).trim();
    if (text.length > 0) {
      fragments.push(text);
    }
  }

  return fragments;
}

function normalizeInputItems(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  return input.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const record = item as Record<string, unknown>;
    const mappedRole: 'assistant' | 'user' = record.role === 'assistant' ? 'assistant' : 'user';
    const normalizedContent = normalizeInputContentParts(mappedRole, record.content);

    return {
      ...record,
      role: mappedRole,
      content: normalizedContent
    };
  });
}

export function normalizeResponsesCreateParams(params: any): any {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const record = params as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...record };
  const legacyMessages = Array.isArray(record.messages) ? (record.messages as LegacyChatMessage[]) : null;

  if (legacyMessages) {
    const inputItems: Array<Record<string, unknown>> = [];

    for (const message of legacyMessages) {
      const role = typeof message.role === 'string' ? message.role : 'user';
      if (role === 'system' || role === 'developer') {
        continue;
      }

      const mappedRole: 'assistant' | 'user' = role === 'assistant' ? 'assistant' : 'user';
      inputItems.push({
        role: mappedRole,
        content: normalizeInputContentParts(mappedRole, message.content)
      });
    }

    normalized.input = inputItems;
    delete normalized.messages;

    const instructionFragments = collectInstructionFragments(legacyMessages);
    const existingInstructions =
      typeof record.instructions === 'string' && record.instructions.trim().length > 0
        ? [record.instructions.trim()]
        : [];
    const mergedInstructions = [...existingInstructions, ...instructionFragments];
    if (mergedInstructions.length > 0) {
      normalized.instructions = mergedInstructions.join('\n\n');
    }
  }

  normalized.input = normalizeInputItems(normalized.input);

  if (
    normalized.max_output_tokens === undefined &&
    typeof normalized.max_tokens === 'number'
  ) {
    normalized.max_output_tokens = normalized.max_tokens;
    delete normalized.max_tokens;
  }

  if (
    normalized.max_output_tokens === undefined &&
    typeof normalized.max_completion_tokens === 'number'
  ) {
    normalized.max_output_tokens = normalized.max_completion_tokens;
    delete normalized.max_completion_tokens;
  }

  const MIN_TOKENS = 16;
  if (typeof normalized.max_output_tokens === 'number') {
    normalized.max_output_tokens = Math.max(MIN_TOKENS, Math.floor(normalized.max_output_tokens));
  }

  if (typeof (normalized as any).max_completion_tokens === 'number') {
    (normalized as any).max_completion_tokens = Math.max(
      MIN_TOKENS,
      Math.floor((normalized as any).max_completion_tokens)
    );
  }

  return normalized;
}

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
  responses: {
    create: (params: any, options?: OpenAIAdapterRequestOptions) => Promise<any>;
  };
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
    responses: {
      create: async (params: any, options?: OpenAIAdapterRequestOptions): Promise<any> => {
        const normalizedParams = normalizeResponsesCreateParams(params);
        return client.responses.create(normalizedParams as any, options as any);
      }
    },
    chat: {
      completions: {
        create: async (
          params: ChatCompletionCreateParams,
          options?: OpenAIAdapterRequestOptions
        ): Promise<ChatCompletion> => {
          // Ensure stream is false for non-streaming completions
          const nonStreamingParams = { ...params, stream: false } as ChatCompletionCreateParams & { stream: false };
          //audit Assumption: request-level signal/headers may be provided by callers; risk: dropped cancellation/tracing; invariant: options forwarded; handling: pass through to SDK.
          const normalizedParams = normalizeResponsesCreateParams(nonStreamingParams);
          const result = await (client.responses as any).create(normalizedParams as any, options as any);
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

