import type OpenAI from 'openai';
import type { OpenAIAdapter } from '../../adapters/openai.adapter.js';
import type {
  CallOpenAIOptions,
  CallOpenAIResult,
  CallOpenAICacheEntry,
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionResponseFormat
} from './types.js';
import { getOpenAIClientOrAdapter } from './clientBridge.js';
import { generateRequestId } from '../../utils/idGenerator.js';
import { responseCache } from '../../utils/cache.js';
import { aiLogger } from '../../utils/structuredLogging.js';
import { recordTraceEvent } from '../../utils/telemetry.js';
import crypto from 'crypto';
import { runtime } from '../openaiRuntime.js';
import { trackModelResponse, trackPromptUsage } from '../contextualReinforcement.js';
import { createCacheKey } from '../../utils/hashUtils.js';
import { generateMockResponse } from './mock.js';
import { logOpenAIEvent, logOpenAISuccess } from '../../utils/openaiLogger.js';
import { resolveErrorMessage } from '../../lib/errors/index.js';
import { buildSystemPromptMessages } from '../../utils/messageBuilderUtils.js';
import { OPENAI_LOG_MESSAGES } from '../../config/openaiLogMessages.js';
import {
  CACHE_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_SYSTEM_PROMPT,
  OPENAI_COMPLETION_DEFAULTS,
  NO_RESPONSE_CONTENT_FALLBACK,
  REQUEST_ID_HEADER
} from './constants.js';
import { ROUTING_MAX_TOKENS } from './config.js';
import {
  REASONING_LOG_SUMMARY_LENGTH,
  REASONING_FALLBACK_TEXT,
  REASONING_SYSTEM_PROMPT,
  REASONING_TEMPERATURE,
  REASONING_TOKEN_LIMIT,
  buildReasoningPrompt
} from '../../config/reasoningTemplates.js';
import { STRICT_ASSISTANT_PROMPT } from '../../config/openaiPrompts.js';
import { SERVER_CONSTANTS } from '../../config/serverMessages.js';
import { buildChatMessages } from './messageBuilder.js';
import { truncateText, hasContent } from '../../utils/promptUtils.js';
import { createChatCompletionWithFallback, ensureModelMatchesExpectation } from './chatFallbacks.js';
import { RESILIENCE_CONSTANTS } from './resilience.js';
import {
  API_TIMEOUT_MS,
  ARCANOS_ROUTING_MESSAGE,
  getDefaultModel,
  getGPT5Model
} from './unifiedClient.js';
import { withRetry } from '../../utils/resilience/unifiedRetry.js';
import { classifyOpenAIError } from '../../lib/errors/reusable.js';
import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { buildChatCompletionRequest } from './requestBuilders.js';

/**
 * Enhanced OpenAI call helper with circuit breaker, exponential backoff, and caching
 */
export async function callOpenAI(
  model: string,
  prompt: string,
  tokenLimit: number,
  useCache: boolean = true,
  options: CallOpenAIOptions = {}
): Promise<CallOpenAIResult> {
  const { adapter } = getOpenAIClientOrAdapter();

  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const baseMetadata = options.metadata ?? {};
  const rawRequestId = baseMetadata ? (baseMetadata as Record<string, unknown>)['requestId'] : undefined;
  const requestIdString = typeof rawRequestId === 'string' ? rawRequestId : undefined;
  const reinforcementRequestId = hasContent(requestIdString)
    ? requestIdString
    : generateRequestId('ctx');
  const reinforcementMetadata: Record<string, unknown> = {
    ...baseMetadata,
    requestId: reinforcementRequestId,
    model
  };

  trackPromptUsage(prompt, reinforcementMetadata);

  const preparedMessages = buildChatMessages(prompt, systemPrompt, options);

  if (!adapter) {
    const mock = generateMockResponse(prompt, 'ask');
    recordTraceEvent('openai.call.mock', {
      model,
      route: options.metadata?.route,
      reason: 'client_unavailable'
    });
    const mockResult = mock.result ?? '';
    trackModelResponse(mockResult, reinforcementMetadata);
    // Create a minimal ChatCompletion-compatible structure for type safety
    // Mock response structure is intentionally different but converted to match ChatCompletion interface
    const mockChatCompletion: ChatCompletion = {
      id: mock.meta.id,
      object: 'chat.completion',
      created: mock.meta.created,
      model: 'mock',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: mockResult,
          refusal: null
        },
        finish_reason: 'stop',
        logprobs: null
      }],
      usage: {
        prompt_tokens: mock.meta.tokens.prompt_tokens,
        completion_tokens: mock.meta.tokens.completion_tokens,
        total_tokens: mock.meta.tokens.total_tokens
      }
    };
    return { 
      response: mockChatCompletion, 
      output: mockResult, 
      model: 'mock', 
      cached: false 
    };
  }

  if (Object.keys(reinforcementMetadata).length > 0) {
    aiLogger.debug('OpenAI call metadata', {
      operation: 'callOpenAI',
      model,
      ...reinforcementMetadata
    });
  }

  const cacheDescriptor = {
    messages: preparedMessages,
    tokenLimit,
    temperature: options.temperature,
    top_p: options.top_p,
    frequency_penalty: options.frequency_penalty,
    presence_penalty: options.presence_penalty,
    response_format: options.responseFormat,
    user: options.user
  };

  let cacheKey: string | null = null;

  if (useCache) {
    cacheKey = createCacheKey(model, cacheDescriptor);
    const cachedResult = responseCache.get(cacheKey) as CallOpenAICacheEntry | undefined;
    if (cachedResult) {
      logOpenAIEvent('info', OPENAI_LOG_MESSAGES.CACHE.HIT, { cacheKey });
      trackModelResponse(cachedResult.output, reinforcementMetadata);
      return { ...cachedResult, cached: true };
    }
  }

  recordTraceEvent('openai.call.start', {
    model,
    tokenLimit,
    cacheEnabled: useCache
  });

  // Use unified retry/resilience module for resilient API calls
  let result: CallOpenAIResult;
  try {
    result = await withRetry(
      async () => {
        return await makeOpenAIRequest(adapter, model, preparedMessages, tokenLimit, options);
      },
      {
        maxRetries: DEFAULT_MAX_RETRIES,
        operationName: 'callOpenAI',
        useCircuitBreaker: true
      }
    );
  } catch (error) {
    recordTraceEvent('openai.call.error', {
      model,
      error: resolveErrorMessage(error, 'unknown')
    });
    throw error;
  }

  trackModelResponse(result.output, reinforcementMetadata);
  recordTraceEvent('openai.call.success', {
    model: result.model,
    cached: result.cached,
    cacheHit: result.cached === true
  });

  // Cache successful results
  if (useCache && result && cacheKey) {
    const cachePayload: CallOpenAICacheEntry = {
      response: result.response,
      output: result.output,
      model: result.model
    };
    responseCache.set(cacheKey, cachePayload, CACHE_TTL_MS);
  }

  return result;
}

/**
 * Internal OpenAI request handler (single attempt)
 * Retry logic is handled by unifiedRetry module in callOpenAI
 * Implements error taxonomy with specialized handling for different error types
 */
async function makeOpenAIRequest(
  adapter: OpenAIAdapter | null,
  model: string,
  messages: ChatCompletionMessageParam[],
  tokenLimit: number,
  options: CallOpenAIOptions
): Promise<CallOpenAIResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  
  try {
    // Extract prompt from messages for the builder (required by ChatParams type)
    const userMessage = messages.find(m => m.role === 'user');
    const prompt = typeof userMessage?.content === 'string' 
      ? userMessage.content 
      : Array.isArray(userMessage?.content)
        ? userMessage.content.find(c => c.type === 'text')?.text || ''
        : '';
    
    // Use the new standardized request builder
    // Pass messages directly to preserve conversation history and routing message
    const nonStreamingPayload = buildChatCompletionRequest({
      prompt,
      model,
      messages,
      maxTokens: tokenLimit,
      temperature: options.temperature,
      top_p: options.top_p,
      frequency_penalty: options.frequency_penalty,
      presence_penalty: options.presence_penalty,
      responseFormat: options.responseFormat,
      user: options.user,
      includeRoutingMessage: false // Messages already include routing message if needed
    });

    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.REQUEST.ATTEMPT(1, 1, model));

    if (!adapter) {
      throw new Error('OpenAI adapter not available');
    }

    // Use adapter for OpenAI calls (adapter boundary pattern)
    // Note: Adapter doesn't support signal/headers yet, so we use getClient() for now
    // TODO: Extend adapter interface to support signal/headers
    const client = adapter.getClient();
    const response = await client.chat.completions.create(nonStreamingPayload, {
      signal: controller.signal,
      // Add request ID for tracing
      headers: {
        [REQUEST_ID_HEADER]: crypto.randomUUID()
      }
    });

    clearTimeout(timeout);
    const output = response.choices?.[0]?.message?.content?.trim() || NO_RESPONSE_CONTENT_FALLBACK;
    const activeModel = response.model || model;

    // Log success metrics
    logOpenAISuccess(OPENAI_LOG_MESSAGES.REQUEST.SUCCESS, {
      attempt: 1,
      model: activeModel,
      totalTokens: response.usage?.total_tokens || 'unknown'
    });

    return { response, output, model: activeModel, cached: false };
    
  } catch (err: unknown) {
    clearTimeout(timeout);
    const error = err instanceof Error ? err : new Error(String(err));
    
    // Classify error using unified error handling
    const classification = classifyOpenAIError(error);
    
    // Log error with classification
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.REQUEST.FAILED_PERMANENT(1), {
      model,
      errorType: classification.type,
      errorMessage: classification.message
    }, error);

    throw error;
  }
}

/**
 * Extract reasoning text from OpenAI ChatCompletion response
 * @confidence 1.0 - Type-safe extraction with fallback
 */
const extractReasoningText = (response: ChatCompletion, fallback: string = REASONING_FALLBACK_TEXT): string =>
  response?.choices?.[0]?.message?.content?.trim() || fallback;

/**
 * Centralized GPT-5.1 helper function for reasoning tasks
 * Used by both core logic and workers
 */
export const createGPT5Reasoning = async (
  clientOrAdapter: OpenAI | OpenAIAdapter | null,
  prompt: string,
  systemPrompt?: string
): Promise<{ content: string; model?: string; error?: string }> => {
  if (!clientOrAdapter) {
    return { content: '[Fallback: GPT-5.1 unavailable - no OpenAI client]', error: 'No OpenAI client' };
  }

  const gpt5Model = getGPT5Model();

  try {
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.REASONING_START(gpt5Model));

    // Use token parameter utility for correct parameter selection
    const tokenParams = getTokenParameter(gpt5Model, RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS);
    const messages = buildSystemPromptMessages(prompt, systemPrompt);

    const requestPayload: ChatCompletionCreateParams = {
      model: gpt5Model,
      messages,
      ...tokenParams
    };

    // Support both adapter and legacy client
    const response = 'chat' in clientOrAdapter && typeof clientOrAdapter.chat === 'object'
      ? await clientOrAdapter.chat.completions.create(requestPayload)
      : await (clientOrAdapter as OpenAI).chat.completions.create({ ...requestPayload, stream: false });
    const resolvedModel = ensureModelMatchesExpectation(response as ChatCompletion, gpt5Model);

    const content = extractReasoningText(response as ChatCompletion);
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.REASONING_SUCCESS, {
      model: resolvedModel,
      preview: truncateText(content, SERVER_CONSTANTS.LOG_PREVIEW_LENGTH)
    });
    return { content, model: resolvedModel };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errorMsg = error.message || 'Unknown error';
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.GPT5.REASONING_ERROR, { model: gpt5Model }, error);
    return { content: `[Fallback: GPT-5.1 unavailable - ${errorMsg}]`, error: errorMsg };
  }
};

/**
 * Enhanced GPT-5.1 reasoning layer that refines ARCANOS responses
 * Implements the layered approach: ARCANOS -> GPT-5.1 reasoning -> refined output
 */
export const createGPT5ReasoningLayer = async (
  clientOrAdapter: OpenAI | OpenAIAdapter | null,
  arcanosResult: string,
  originalPrompt: string,
  context?: string
): Promise<{
  refinedResult: string;
  reasoningUsed: boolean;
  reasoningContent?: string;
  model?: string;
  error?: string
}> => {
  if (!clientOrAdapter) {
    return { 
      refinedResult: arcanosResult, 
      reasoningUsed: false, 
      error: 'No OpenAI client available for GPT-5.1 reasoning' 
    };
  }

  const gpt5Model = getGPT5Model();

  try {
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.LAYER_REFINING, { model: gpt5Model });

    const tokenParams = getTokenParameter(gpt5Model, REASONING_TOKEN_LIMIT);
    const messages = buildSystemPromptMessages(
      buildReasoningPrompt(originalPrompt, arcanosResult, context),
      REASONING_SYSTEM_PROMPT
    );

    const requestPayload: ChatCompletionCreateParams = {
      model: gpt5Model,
      messages,
      ...tokenParams,
      temperature: REASONING_TEMPERATURE
    };

    // Support both adapter and legacy client
    const response = 'chat' in clientOrAdapter && typeof clientOrAdapter.chat === 'object'
      ? await clientOrAdapter.chat.completions.create(requestPayload)
      : await (clientOrAdapter as OpenAI).chat.completions.create({ ...requestPayload, stream: false });
    const resolvedModel = ensureModelMatchesExpectation(response as ChatCompletion, gpt5Model);

    const reasoningContent = extractReasoningText(response as ChatCompletion);

    // The GPT-5.1 response IS the refined result
    const refinedResult = reasoningContent;

    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.LAYER_SUCCESS, {
      model: resolvedModel,
      length: refinedResult.length
    });

    return {
      refinedResult,
      reasoningUsed: true,
      reasoningContent: reasoningContent.substring(0, REASONING_LOG_SUMMARY_LENGTH) + '...', // Summary for logging
      model: resolvedModel
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errorMsg = error.message || 'Unknown error';
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.GPT5.LAYER_ERROR, { model: gpt5Model }, error);
    
    // Return original ARCANOS result on failure
    return { 
      refinedResult: arcanosResult, 
      reasoningUsed: false, 
      error: errorMsg 
    };
  }
};

/**
 * Strict GPT-5.1 call function that only uses GPT-5.1 with no fallback
 * Raises RuntimeError if the response doesn't come from GPT-5.1
 * @confidence 0.95 - Type-safe with proper OpenAI SDK types
 */
export async function call_gpt5_strict(
  prompt: string, 
  kwargs: Partial<ChatCompletionCreateParams> = {}
): Promise<ChatCompletion> {
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error("GPT-5.1 call failed — no fallback allowed. OpenAI client not available.");
  }

  const gpt5Model = getGPT5Model();

  try {
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.STRICT_CALL, { model: gpt5Model });

    const messages = buildSystemPromptMessages(prompt, STRICT_ASSISTANT_PROMPT);

    const requestPayload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: gpt5Model,
      messages,
      stream: false,
      ...(kwargs && typeof kwargs === 'object' ? Object.fromEntries(
        Object.entries(kwargs).filter(([key]) => key !== 'stream')
      ) : {})
    };

    const response = await client.chat.completions.create(requestPayload);

    // Validate that the response actually came from GPT-5.1
    // Response is guaranteed to be ChatCompletion (not Stream) because stream: false
    if (!response.model || response.model !== gpt5Model) {
      throw new Error(
        `GPT-5.1 call failed — no fallback allowed. Expected model '${gpt5Model}' but got '${response.model || 'undefined'}'.`
      );
    }

    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.STRICT_SUCCESS(response.model));
    return response;
  } catch (error: unknown) {
    // Re-throw with clear error message indicating no fallback
    const errorMessage = resolveErrorMessage(error);
    throw new Error(`GPT-5.1 call failed — no fallback allowed. ${errorMessage}`);
  }
}

/**
 * Centralized OpenAI completion wrapper that ensures all calls go through
 * the fine-tuned model by default with ARCANOS routing system message.
 * This is the main function that should be used for all AI completions.
 * 
 * @param messages - Array of chat completion messages
 * @param options - Optional configuration overrides
 * @returns Promise resolving to OpenAI chat completion response or stream
 */
export async function createCentralizedCompletion(
  messages: ChatCompletionMessageParam[],
  options: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  } = {}
): Promise<ChatCompletion | AsyncIterable<unknown>> {
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error('OpenAI client not initialized - API key required');
  }

  // Use fine-tuned model by default, allow override via options.model
  const model = options.model || getDefaultModel();
  
  // Prepend ARCANOS routing system message to ensure proper handling
  const arcanosMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: ARCANOS_ROUTING_MESSAGE },
    ...messages
  ];

  // Record the conversation and model metadata in the lightweight runtime
  const sessionId = runtime.createSession();
  runtime.addMessages(sessionId, arcanosMessages);
  runtime.setMetadata(sessionId, { model });

  logOpenAIEvent('info', `${OPENAI_LOG_MESSAGES.ARCANOS.ROUTING_PREFIX} ${ARCANOS_ROUTING_MESSAGE}`, { model });

  // Prepare request with token parameters for the specific model
  const tokenParams = getTokenParameter(model, options.max_tokens || ROUTING_MAX_TOKENS);
  
  const requestPayload = {
    model,
    messages: arcanosMessages,
    temperature: options.temperature ?? OPENAI_COMPLETION_DEFAULTS.TEMPERATURE,
    top_p: options.top_p ?? OPENAI_COMPLETION_DEFAULTS.TOP_P,
    frequency_penalty: options.frequency_penalty ?? OPENAI_COMPLETION_DEFAULTS.FREQUENCY_PENALTY,
    presence_penalty: options.presence_penalty ?? OPENAI_COMPLETION_DEFAULTS.PRESENCE_PENALTY,
    stream: options.stream ?? false,
    ...tokenParams
  };

  try {
    const response = await client.chat.completions.create(requestPayload);
    
    if (!options.stream && 'usage' in response) {
      logOpenAIEvent('info', OPENAI_LOG_MESSAGES.ARCANOS.COMPLETION_SUCCESS, {
        model,
        totalTokens: response.usage?.total_tokens || 'unknown'
      });
    } else {
      logOpenAIEvent('info', OPENAI_LOG_MESSAGES.ARCANOS.STREAMING_START, { model });
    }

    return response;
  } catch (error) {
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.ARCANOS.COMPLETION_ERROR, { model }, error as Error);
    throw error;
  }
}

export type {
  CallOpenAIOptions,
  CallOpenAIResult,
  CallOpenAICacheEntry,
  ChatCompletionMessageParam,
  ChatCompletionResponseFormat
};

export {
  createChatCompletionWithFallback
};
