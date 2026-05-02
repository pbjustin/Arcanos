import {
  extractResponseOutputText,
  extractTextFromContentParts,
  normalizeUsage as normalizeOpenAIUsage
} from '@arcanos/openai/responseParsing';
import {
  createSafeResponsesParse,
  type OpenAIResponsesClientLike,
} from '@arcanos/openai';
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
import {
  attachOpenAIResponsesMetadataToChatCompletion,
  resolveOpenAIResponsesLegacyFinishReason,
  type OpenAIResponsesLegacyChatCompletion
} from './openaiResponsesMetadata.js';
import { recordDependencyCall } from '@platform/observability/appMetrics.js';
import {
  assertAiBudgetAllowsCall,
  recordAiOperationResult,
} from '@services/openai/aiExecutionContext.js';

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

async function instrumentOpenAIOperation<T>(input: {
  operation: string;
  model?: string | null;
  callback: () => Promise<T>;
  extractUsage?: (result: T) => unknown;
}
): Promise<T> {
  assertAiBudgetAllowsCall(input.operation, input.model);
  const startedAtMs = Date.now();
  try {
    const result = await input.callback();
    const normalizedUsage = normalizeUsage(
      typeof input.extractUsage === 'function'
        ? input.extractUsage(result)
        : (result as { usage?: unknown } | null)?.usage
    );
    recordDependencyCall({
      dependency: 'openai',
      operation: input.operation,
      outcome: 'ok',
      durationMs: Date.now() - startedAtMs,
    });
    recordAiOperationResult({
      operation: input.operation,
      model: input.model,
      outcome: 'ok',
      durationMs: Date.now() - startedAtMs,
      usage: {
        promptTokens: normalizedUsage.promptTokens,
        completionTokens: normalizedUsage.completionTokens,
        totalTokens: normalizedUsage.totalTokens,
      }
    });
    return result;
  } catch (error) {
    recordDependencyCall({
      dependency: 'openai',
      operation: input.operation,
      outcome: 'error',
      durationMs: Date.now() - startedAtMs,
      error,
    });
    recordAiOperationResult({
      operation: input.operation,
      model: input.model,
      outcome: 'error',
      durationMs: Date.now() - startedAtMs,
    });
    throw error;
  }
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

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return extractTextFromContentParts(content, { includeOutputText: false });
}

function extractResponseText(response: unknown): string {
  return extractResponseOutputText(response, '');
}

function normalizeUsage(usage: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } {
  return normalizeOpenAIUsage(usage);
}


const MIN_RESPONSE_TOKENS = 16;

export class OpenAIRequestValidationError extends Error {
  readonly code = 'OPENAI_REQUEST_VALIDATION_ERROR';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'OpenAIRequestValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function assertValidResponsesCreateParams(params: unknown): asserts params is Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new OpenAIRequestValidationError('OpenAI Responses request must be an object.');
  }

  const record = params as Record<string, unknown>;
  const model = record.model;
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new OpenAIRequestValidationError('OpenAI Responses request requires a non-empty model.');
  }

  const input = record.input;
  const messages = record.messages;
  const prompt = record.prompt;
  const previousResponseId = record.previous_response_id;
  const hasInput =
    (typeof input === 'string' && input.trim().length > 0) ||
    (Array.isArray(input) && input.length > 0);
  const hasLegacyMessages = Array.isArray(messages) && messages.length > 0;
  const hasPromptTemplate = Boolean(prompt && typeof prompt === 'object' && !Array.isArray(prompt));
  const hasPreviousResponseId =
    typeof previousResponseId === 'string' && previousResponseId.trim().length > 0;

  if (!hasInput && !hasLegacyMessages && !hasPromptTemplate && !hasPreviousResponseId) {
    throw new OpenAIRequestValidationError(
      'OpenAI Responses request requires input, messages, prompt, or previous_response_id.'
    );
  }

  const maxOutputTokens = record.max_output_tokens;
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== 'number' || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0)
  ) {
    throw new OpenAIRequestValidationError('OpenAI Responses request max_output_tokens must be a positive number.');
  }
}

export function normalizeResponsesCreateParams(
  params: ResponseCreateParamsNonStreaming
): ResponseCreateParamsNonStreaming {
  const normalized = { ...params } as ResponseCreateParamsNonStreaming & { max_completion_tokens?: number };

  if (typeof normalized.max_output_tokens === 'number') {
    normalized.max_output_tokens = Math.max(MIN_RESPONSE_TOKENS, Math.floor(normalized.max_output_tokens));
  }

  const withMaxCompletionTokens = normalized as { max_completion_tokens?: number };
  if (typeof withMaxCompletionTokens.max_completion_tokens === 'number') {
    withMaxCompletionTokens.max_completion_tokens = Math.max(
      MIN_RESPONSE_TOKENS,
      Math.floor(withMaxCompletionTokens.max_completion_tokens)
    );
  }

  return normalized;
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
): OpenAIResponsesLegacyChatCompletion {
  const usage = normalizeUsage(response.usage);
  const outputText = extractResponseText(response);
  const createdAt = (response as { created_at?: unknown }).created_at;
  const created = typeof createdAt === 'number' ? Math.floor(createdAt) : Math.floor(Date.now() / 1000);
  const finishReason = resolveOpenAIResponsesLegacyFinishReason(response);

  const legacyResponse: ChatCompletion = {
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
        finish_reason: finishReason,
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens
    }
  };

  return attachOpenAIResponsesMetadataToChatCompletion(legacyResponse, response, finishReason);
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

  const originalResponsesCreate = client.responses.create.bind(client.responses);
  const originalChatCreate = client.chat.completions.create.bind(client.chat.completions);
  const originalEmbeddingsCreate = client.embeddings.create.bind(client.embeddings);
  const originalImagesGenerate = client.images.generate.bind(client.images);
  const originalAudioTranscriptionsCreate =
    client.audio.transcriptions.create.bind(client.audio.transcriptions);

  const responsesBackedChatCreate = async (
    params: ChatCompletionCreateParams,
    options?: OpenAIAdapterRequestOptions
  ): Promise<ChatCompletion> => {
    const streamRequested = (params as ChatCompletionCreateParams & { stream?: unknown }).stream === true;
    //audit Assumption: streaming remains temporarily on chat endpoint for compatibility; risk: partial dual-surface behavior; invariant: non-stream routes through Responses; handling: preserve native stream path only when explicitly requested.
    if (streamRequested) {
      const requestedModel =
        typeof params.model === 'string' && params.model.trim().length > 0
          ? params.model.trim()
          : null;
      const streamingResult = await instrumentOpenAIOperation({
        operation: 'chat_completions_create',
        model: requestedModel,
        callback: () => originalChatCreate(params, options),
        extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
      });
      return streamingResult as unknown as ChatCompletion;
    }

    const nonStreamingParams = { ...params, stream: false } as ChatCompletionCreateParams & { stream: false };
    const responsePayload = buildResponsesRequestFromChatParams(nonStreamingParams);
    //audit Assumption: legacy chat callers must route through Responses API internally; risk: mixed API surfaces diverge; invariant: one canonical execution path for non-stream chat; handling: convert chat params to responses payload and backfill legacy shape.
    const normalizedResponsePayload = normalizeResponsesCreateParams(responsePayload);
    const requestedModel =
      typeof normalizedResponsePayload.model === 'string' && normalizedResponsePayload.model.trim().length > 0
        ? normalizedResponsePayload.model.trim()
        : null;
    const response = await instrumentOpenAIOperation({
      operation: 'responses_create',
      model: requestedModel,
      callback: () => originalResponsesCreate(normalizedResponsePayload, options),
      extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
    });
    return convertResponseToLegacyChatCompletion(response, nonStreamingParams.model);
  };

  const safeResponsesParse = async (
    params: Record<string, unknown>,
    options?: OpenAIResponsesRequestOptions
  ): Promise<any> => {
    assertValidResponsesCreateParams(params);
    const normalizedParams = normalizeResponsesCreateParams(params as ResponseCreateParamsNonStreaming);
    const requestedModel =
      typeof normalizedParams.model === 'string' && normalizedParams.model.trim().length > 0
        ? normalizedParams.model.trim()
        : null;
    const safeParseClient: OpenAIResponsesClientLike = {
      responses: {
        create: (
          payload: ResponseCreateParamsNonStreaming,
          requestOptions?: OpenAIResponsesRequestOptions
        ) => originalResponsesCreate(payload, requestOptions),
      },
    };

    return instrumentOpenAIOperation({
      operation: 'responses_parse',
      model: requestedModel,
      callback: () => createSafeResponsesParse(
        safeParseClient,
        normalizedParams,
        options,
        { source: 'OpenAI responses.parse' }
      ),
      extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
    });
  };

  const safeResponsesCreate = async (
    params: any,
    options?: OpenAIResponsesRequestOptions
  ): Promise<any> => {
    assertValidResponsesCreateParams(params);
    const hasLegacyMessages =
      params &&
      typeof params === 'object' &&
      Array.isArray((params as { messages?: unknown }).messages);

    //audit Assumption: some call sites still pass chat-completions-shaped payloads to responses surface; risk: runtime schema mismatch on responses.create; invariant: adapter accepts both legacy and responses payloads during migration; handling: normalize legacy messages payloads through responses mapper then backfill legacy chat shape.
    if (hasLegacyMessages) {
      const nonStreamingParams = {
        ...(params as unknown as ChatCompletionCreateParams),
        stream: false
      } as ChatCompletionCreateParams & { stream: false };
      const responsePayload = buildResponsesRequestFromChatParams(nonStreamingParams);
      const normalizedResponsePayload = normalizeResponsesCreateParams(responsePayload);
      const requestedModel =
        typeof normalizedResponsePayload.model === 'string' && normalizedResponsePayload.model.trim().length > 0
          ? normalizedResponsePayload.model.trim()
          : null;
      const response = await instrumentOpenAIOperation({
        operation: 'responses_create',
        model: requestedModel,
        callback: () => originalResponsesCreate(normalizedResponsePayload, options),
        extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
      });
      return convertResponseToLegacyChatCompletion(response, nonStreamingParams.model);
    }

    //audit Assumption: canonical responses payloads should pass through unchanged; risk: accidental mutation of advanced params; invariant: direct responses API path remains available; handling: forward params/options directly.
    const normalizedParams = normalizeResponsesCreateParams(params as ResponseCreateParamsNonStreaming);
    const requestedModel =
      typeof normalizedParams.model === 'string' && normalizedParams.model.trim().length > 0
        ? normalizedParams.model.trim()
        : null;
    return instrumentOpenAIOperation({
      operation: 'responses_create',
      model: requestedModel,
      callback: () => originalResponsesCreate(normalizedParams, options),
      extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
    });
  };

  (client.responses as { create: typeof safeResponsesCreate; parse: typeof safeResponsesParse }).create = safeResponsesCreate;
  (client.responses as { parse: typeof safeResponsesParse }).parse = safeResponsesParse;

  return {
    responses: {
      create: safeResponsesCreate,
      parse: async (
        params: Record<string, unknown>,
        options?: OpenAIResponsesRequestOptions
      ): Promise<any> => safeResponsesParse(params, options)
    },
    chat: {
      completions: {
        create: responsesBackedChatCreate
      }
    },
    embeddings: {
      create: async (params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> => {
        const requestedModel =
          typeof params.model === 'string' && params.model.trim().length > 0
            ? params.model.trim()
            : null;
        return instrumentOpenAIOperation({
          operation: 'embeddings_create',
          model: requestedModel,
          callback: () => originalEmbeddingsCreate(params),
          extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
        });
      }
    },
    images: {
      generate: async (
        params: ImageGenerateParamsNonStreaming,
        options?: OpenAIAdapterRequestOptions
      ): Promise<ImagesResponse> => {
        //audit Assumption: image generation should support trace/cancel request options; risk: untracked long-running calls; invariant: options forwarded; handling: pass through to SDK.
        const requestedModel =
          typeof params.model === 'string' && params.model.trim().length > 0
            ? params.model.trim()
            : null;
        return instrumentOpenAIOperation({
          operation: 'images_generate',
          model: requestedModel,
          callback: () => originalImagesGenerate(params, options),
          extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
        });
      }
    },
    audio: {
      transcriptions: {
        create: async (params: TranscriptionCreateParamsNonStreaming): Promise<Transcription> => {
          const requestedModel =
            typeof params.model === 'string' && params.model.trim().length > 0
              ? params.model.trim()
              : null;
          return instrumentOpenAIOperation({
            operation: 'audio_transcriptions_create',
            model: requestedModel,
            callback: () => originalAudioTranscriptionsCreate(params),
            extractUsage: (result) => (result as { usage?: unknown } | null)?.usage,
          });
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
