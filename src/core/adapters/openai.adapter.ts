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
import type { Response as OpenAIResponse, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

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

export interface OpenAIResponsesRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * OpenAI adapter interface
 * Provides type-safe access to OpenAI functionality
 */
export interface OpenAIAdapter {
  /**
   * Canonical Responses API surface.
   */
  responses: {
    create: (
      params: any,
      options?: OpenAIResponsesRequestOptions
    ) => Promise<any>;
    parse: (
      params: Record<string, unknown>,
      options?: OpenAIResponsesRequestOptions
    ) => Promise<any>;
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

interface LegacyUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

function normalizeMessageContent(content: unknown): string {
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
      if (typedPart.type === 'output_text' && typeof typedPart.text === 'string') {
        return typedPart.text;
      }
      return '';
    })
    .filter((value) => value.length > 0)
    .join('\n');
}

function extractResponseText(response: OpenAIResponse): string {
  const directOutputText = (response as { output_text?: unknown }).output_text;
  if (typeof directOutputText === 'string' && directOutputText.trim().length > 0) {
    return directOutputText.trim();
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
        const normalized = typedContentItem.text.trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }
    }
  }

  return '';
}

function normalizeUsage(usage: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const typedUsage = (usage ?? {}) as LegacyUsageShape;
  const promptTokens = Number.isFinite(typedUsage.input_tokens) ? Number(typedUsage.input_tokens) : 0;
  const completionTokens = Number.isFinite(typedUsage.output_tokens) ? Number(typedUsage.output_tokens) : 0;
  const totalTokens = Number.isFinite(typedUsage.total_tokens)
    ? Number(typedUsage.total_tokens)
    : promptTokens + completionTokens;

  return { promptTokens, completionTokens, totalTokens };
}

function buildResponsesRequestFromChatParams(
  params: ChatCompletionCreateParams
): ResponseCreateParamsNonStreaming {
  const typedMessages = Array.isArray(params.messages) ? params.messages : [];
  const instructionParts: string[] = [];
  const inputItems: Array<{ role: 'assistant' | 'user'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }> = [];

  for (const message of typedMessages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const typedMessage = message as { role?: unknown; content?: unknown };
    const role = String(typedMessage.role ?? '');
    const text = normalizeMessageContent(typedMessage.content);

    //audit Assumption: system/developer messages belong in instructions; risk: policy prompts leaking into user content; invariant: non-user policy text isolated; handling: aggregate into instructions.
    if (role === 'system' || role === 'developer') {
      if (text.length > 0) {
        instructionParts.push(text);
      }
      continue;
    }

    const mappedRole: 'assistant' | 'user' = role === 'assistant' ? 'assistant' : 'user';
    const contentType: 'input_text' | 'output_text' = mappedRole === 'assistant' ? 'output_text' : 'input_text';
    inputItems.push({
      role: mappedRole,
      content: [{ type: contentType, text: text.length > 0 ? text : ' ' }]
    });
  }

  const maxOutputTokens = (() => {
    const withMaxCompletion = params as ChatCompletionCreateParams & { max_completion_tokens?: unknown };
    if (typeof withMaxCompletion.max_completion_tokens === 'number') {
      return withMaxCompletion.max_completion_tokens;
    }
    const withMaxTokens = params as ChatCompletionCreateParams & { max_tokens?: unknown };
    if (typeof withMaxTokens.max_tokens === 'number') {
      return withMaxTokens.max_tokens;
    }
    return undefined;
  })();

  const payload: ResponseCreateParamsNonStreaming = {
    model: params.model,
    input: (inputItems.length > 0
      ? inputItems
      : [{ role: 'user', content: [{ type: 'input_text', text: ' ' }] }]) as never
  };

  if (instructionParts.length > 0) {
    payload.instructions = instructionParts.join('\n\n');
  }
  if (typeof params.temperature === 'number') {
    payload.temperature = params.temperature;
  }
  if (typeof params.top_p === 'number') {
    payload.top_p = params.top_p;
  }
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens)) {
    payload.max_output_tokens = maxOutputTokens;
  }
  if (typeof params.user === 'string' && params.user.trim().length > 0) {
    payload.metadata = { user: params.user };
  }

  const responseFormat = (params as ChatCompletionCreateParams & { response_format?: unknown }).response_format;
  //audit Assumption: only JSON object/schema format hints are safely portable to Responses API; risk: unsupported format passthrough causing runtime 400; invariant: map recognized formats only; handling: ignore unknown formats.
  if (responseFormat && typeof responseFormat === 'object' && 'type' in responseFormat) {
    const responseType = String((responseFormat as { type?: unknown }).type ?? '').toLowerCase();
    if (responseType === 'json_object') {
      payload.text = { format: { type: 'json_object' } };
    }
    if (responseType === 'json_schema') {
      const jsonSchema = (responseFormat as { json_schema?: unknown }).json_schema;
      payload.text = {
        format: {
          type: 'json_schema',
          ...(jsonSchema && typeof jsonSchema === 'object' ? { json_schema: jsonSchema } : {})
        } as never
      };
    }
  }

  return payload;
}

function convertResponseToLegacyChatCompletion(
  response: OpenAIResponse,
  requestedModel: string
): ChatCompletion {
  const usage = normalizeUsage(response.usage);
  const outputText = extractResponseText(response);
  const createdAt = (response as { created_at?: unknown }).created_at;
  const created = typeof createdAt === 'number' ? Math.floor(createdAt) : Math.floor(Date.now() / 1000);

  return {
    id: response.id || `legacy_${Date.now()}`,
    object: 'chat.completion',
    created,
    model: response.model || requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: outputText,
          refusal: null
        },
        finish_reason: 'stop',
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens
    }
  };
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

  const originalChatCreate = client.chat.completions.create.bind(client.chat.completions);

  const responsesBackedChatCreate = async (
    params: ChatCompletionCreateParams,
    options?: OpenAIAdapterRequestOptions
  ): Promise<ChatCompletion> => {
    const streamRequested = (params as ChatCompletionCreateParams & { stream?: unknown }).stream === true;
    //audit Assumption: streaming remains temporarily on chat endpoint for compatibility; risk: partial dual-surface behavior; invariant: non-stream routes through Responses; handling: preserve native stream path only when explicitly requested.
    if (streamRequested) {
      const streamingResult = await originalChatCreate(params, options);
      return streamingResult as unknown as ChatCompletion;
    }

    const nonStreamingParams = { ...params, stream: false } as ChatCompletionCreateParams & { stream: false };
    const responsePayload = buildResponsesRequestFromChatParams(nonStreamingParams);
    //audit Assumption: legacy chat callers must route through Responses API internally; risk: mixed API surfaces diverge; invariant: one canonical execution path for non-stream chat; handling: convert chat params to responses payload and backfill legacy shape.
    const response = await client.responses.create(responsePayload, options);
    return convertResponseToLegacyChatCompletion(response, String(nonStreamingParams.model || 'gpt-4.1-mini'));
  };

  const mutableClient = client as unknown as {
    chat: {
      completions: {
        create: typeof originalChatCreate;
      };
    };
  };
  //audit Assumption: some legacy call sites still use raw client.chat.completions.create; risk: bypassing adapter migration path; invariant: raw client non-stream chat is responses-backed; handling: patch client method at construction boundary.
  mutableClient.chat.completions.create = responsesBackedChatCreate as unknown as typeof originalChatCreate;

  return {
    responses: {
      create: async (
        params: any,
        options?: OpenAIResponsesRequestOptions
      ): Promise<any> => {
        const hasLegacyMessages =
          params &&
          typeof params === 'object' &&
          Array.isArray((params as { messages?: unknown }).messages);

        //audit Assumption: some call sites still pass chat-completions-shaped payloads to responses surface; risk: runtime schema mismatch on responses.create; invariant: adapter accepts both legacy and responses payloads during migration; handling: normalize legacy messages payloads through responses mapper then backfill legacy chat shape.
        if (hasLegacyMessages) {
          const nonStreamingParams = {
            ...(params as ChatCompletionCreateParams),
            stream: false
          } as ChatCompletionCreateParams & { stream: false };
          const responsePayload = buildResponsesRequestFromChatParams(nonStreamingParams);
          const response = await client.responses.create(responsePayload, options);
          return convertResponseToLegacyChatCompletion(response, String(nonStreamingParams.model || 'gpt-4.1-mini'));
        }

        //audit Assumption: canonical responses payloads should pass through unchanged; risk: accidental mutation of advanced params; invariant: direct responses API path remains available; handling: forward params/options directly.
        return client.responses.create(params as ResponseCreateParamsNonStreaming, options);
      },
      parse: async (
        params: Record<string, unknown>,
        options?: OpenAIResponsesRequestOptions
      ): Promise<any> => {
        //audit Assumption: parse may use evolving schema shape; risk: over-constrained types break compile on SDK updates; invariant: parse call remains available; handling: permissive typed pass-through.
        return await client.responses.parse(params as never, options);
      }
    },
    chat: {
      completions: {
        create: responsesBackedChatCreate
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

