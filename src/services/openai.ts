import OpenAI from 'openai';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { responseCache } from '../utils/cache.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import crypto from 'crypto';
import { runtime } from './openaiRuntime.js';
import { trackModelResponse, trackPromptUsage } from './contextualReinforcement.js';
import { createCacheKey } from '../utils/hashUtils.js';
import { generateMockResponse } from './openai/mock.js';
import { logOpenAIEvent, logOpenAISuccess } from '../utils/openaiLogger.js';
import { handleOpenAIRequestError } from '../utils/openaiErrorHandler.js';
import { buildSystemPromptMessages } from '../utils/messageBuilderUtils.js';
import { buildCompletionRequestPayload } from '../utils/requestPayloadUtils.js';
import { OPENAI_LOG_MESSAGES } from '../config/openaiLogMessages.js';
import {
  CACHE_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_SYSTEM_PROMPT,
  IMAGE_PROMPT_TOKEN_LIMIT,
  REQUEST_ID_HEADER,
  OPENAI_COMPLETION_DEFAULTS,
  NO_RESPONSE_CONTENT_FALLBACK
} from './openai/constants.js';
import {
  REASONING_LOG_SUMMARY_LENGTH,
  REASONING_FALLBACK_TEXT,
  REASONING_SYSTEM_PROMPT,
  REASONING_TEMPERATURE,
  REASONING_TOKEN_LIMIT,
  buildReasoningPrompt
} from '../config/reasoningTemplates.js';
import { STRICT_ASSISTANT_PROMPT } from '../config/openaiPrompts.js';
import { SERVER_CONSTANTS } from '../config/serverMessages.js';
import { buildChatMessages } from './openai/messageBuilder.js';
import { truncateText, hasContent } from '../utils/promptUtils.js';
import { prepareGPT5Request, buildReasoningRequestPayload } from './openai/requestTransforms.js';
import { buildResponseRequestPayload, extractResponseOutput } from './openai/responsePayload.js';
import { createChatCompletionWithFallback, ensureModelMatchesExpectation } from './openai/chatFallbacks.js';
import {
  CallOpenAIOptions,
  CallOpenAIResult,
  CallOpenAICacheEntry,
  ChatCompletionMessageParam,
  ChatCompletionResponseFormat,
  ImageSize
} from './openai/types.js';
import {
  DEFAULT_IMAGE_SIZE,
  IMAGE_GENERATION_MODEL,
  ROUTING_MAX_TOKENS
} from './openai/config.js';
import {
  getDefaultModel,
  getFallbackModel,
  getGPT5Model,
  getOpenAIKeySource,
  hasValidAPIKey
} from './openai/credentialProvider.js';
import {
  RESILIENCE_CONSTANTS,
  executeWithResilience,
  calculateRetryDelay,
  getCircuitBreakerSnapshot
} from './openai/resilience.js';
import {
  API_TIMEOUT_MS,
  ARCANOS_ROUTING_MESSAGE,
  getOpenAIClient,
  getOpenAIServiceHealth,
  validateAPIKeyAtStartup
} from './openai/clientFactory.js';

export type {
  CallOpenAIOptions,
  CallOpenAIResult,
  CallOpenAICacheEntry,
  ChatCompletionMessageParam,
  ChatCompletionResponseFormat,
  ImageSize
};

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
  const client = getOpenAIClient();

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

  if (!client) {
    const mock = generateMockResponse(prompt, 'ask');
    recordTraceEvent('openai.call.mock', {
      model,
      route: options.metadata?.route,
      reason: 'client_unavailable'
    });
    trackModelResponse(mock.result, reinforcementMetadata);
    return { response: mock, output: mock.result, model: 'mock', cached: false };
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

  // Use circuit breaker for resilient API calls
  let result: CallOpenAIResult;
  try {
    result = await executeWithResilience(async () => {
      return await makeOpenAIRequest(client, model, preparedMessages, tokenLimit, options);
    });
  } catch (error) {
    recordTraceEvent('openai.call.error', {
      model,
      error: error instanceof Error ? error.message : 'unknown'
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
 * Internal OpenAI request handler with exponential backoff retry logic
 * Implements error taxonomy with specialized handling for different error types
 */
async function makeOpenAIRequest(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tokenLimit: number,
  options: CallOpenAIOptions,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<CallOpenAIResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    
    try {
      // Apply exponential backoff with jitter on retries
      if (attempt > 1) {
        const delay = calculateRetryDelay(attempt - 1, lastError);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const tokenParams = getTokenParameter(model, tokenLimit);
      const requestPayload = buildCompletionRequestPayload(model, messages, tokenParams, options);

      logOpenAIEvent('info', OPENAI_LOG_MESSAGES.REQUEST.ATTEMPT(attempt, maxRetries, model));

      const response: any = await client.chat.completions.create(requestPayload, {
        signal: controller.signal,
        // Add request ID for tracing
        headers: {
          [REQUEST_ID_HEADER]: crypto.randomUUID()
        }
      } as any);

      clearTimeout(timeout);
      const output = response.choices?.[0]?.message?.content?.trim() || NO_RESPONSE_CONTENT_FALLBACK;
      const activeModel = response.model || model;

      // Log success metrics
      logOpenAISuccess(OPENAI_LOG_MESSAGES.REQUEST.SUCCESS, {
        attempt,
        model: activeModel,
        totalTokens: response.usage?.total_tokens || 'unknown'
      });

      return { response, output, model: activeModel, cached: false };
      
    } catch (err: any) {
      clearTimeout(timeout);
      lastError = err;
      
      // Handle error with centralized logic
      const { shouldRetry } = handleOpenAIRequestError(err, attempt, maxRetries);

      if (!shouldRetry) {
        break;
      }
    }
  }

  recordTraceEvent('openai.call.exhausted', {
    attempts: maxRetries,
    error: lastError instanceof Error ? lastError.message : 'unknown'
  });
  throw lastError || new Error('OpenAI request failed after all retry attempts');
}

const extractReasoningText = (response: any, fallback: string = REASONING_FALLBACK_TEXT): string =>
  response?.choices?.[0]?.message?.content?.trim() || fallback;

/**
 * Centralized GPT-5.1 helper function for reasoning tasks
 * Used by both core logic and workers
 */
export const createGPT5Reasoning = async (
  client: OpenAI,
  prompt: string,
  systemPrompt?: string
): Promise<{ content: string; model?: string; error?: string }> => {
  if (!client) {
    return { content: '[Fallback: GPT-5.1 unavailable - no OpenAI client]', error: 'No OpenAI client' };
  }

  const gpt5Model = getGPT5Model();

  try {
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.REASONING_START(gpt5Model));

    // Use token parameter utility for correct parameter selection
    const tokenParams = getTokenParameter(gpt5Model, RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS);
    const messages = buildSystemPromptMessages(prompt, systemPrompt);

    const requestPayload: any = {
      model: gpt5Model,
      messages,
      ...tokenParams
    };

    const response: any = await client.chat.completions.create(requestPayload);
    const resolvedModel = ensureModelMatchesExpectation(response, gpt5Model);

    const content = extractReasoningText(response);
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.REASONING_SUCCESS, {
      model: resolvedModel,
      preview: truncateText(content, SERVER_CONSTANTS.LOG_PREVIEW_LENGTH)
    });
    return { content, model: resolvedModel };
  } catch (err: any) {
    const errorMsg = err?.message || 'Unknown error';
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.GPT5.REASONING_ERROR, { model: gpt5Model }, err as Error);
    return { content: `[Fallback: GPT-5.1 unavailable - ${errorMsg}]`, error: errorMsg };
  }
};

/**
 * Enhanced GPT-5.1 reasoning layer that refines ARCANOS responses
 * Implements the layered approach: ARCANOS -> GPT-5.1 reasoning -> refined output
 */
export const createGPT5ReasoningLayer = async (
  client: OpenAI,
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
  if (!client) {
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

    const requestPayload: any = {
      model: gpt5Model,
      messages,
      ...tokenParams,
      temperature: REASONING_TEMPERATURE
    };

    const response: any = await client.chat.completions.create(requestPayload);
    const resolvedModel = ensureModelMatchesExpectation(response, gpt5Model);

    const reasoningContent = extractReasoningText(response);

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
  } catch (err: any) {
    const errorMsg = err?.message || 'Unknown error';
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.GPT5.LAYER_ERROR, { model: gpt5Model }, err as Error);
    
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
 */
export async function call_gpt5_strict(prompt: string, kwargs: any = {}): Promise<any> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error("GPT-5.1 call failed — no fallback allowed. OpenAI client not available.");
  }

  const gpt5Model = getGPT5Model();

  try {
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.STRICT_CALL, { model: gpt5Model });

    const messages = buildSystemPromptMessages(prompt, STRICT_ASSISTANT_PROMPT);

    const requestPayload: any = {
      model: gpt5Model,
      messages,
      ...kwargs
    };

    const response: any = await client.chat.completions.create(requestPayload);

    // Validate that the response actually came from GPT-5.1
    if (!response.model || response.model !== gpt5Model) {
      throw new Error(
        `GPT-5.1 call failed — no fallback allowed. Expected model '${gpt5Model}' but got '${response.model || 'undefined'}'.`
      );
    }

    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.STRICT_SUCCESS(response.model));
    return response;
  } catch (error: any) {
    // Re-throw with clear error message indicating no fallback
    throw new Error(`GPT-5.1 call failed — no fallback allowed. ${error.message}`);
  }
}

/**
 * Generates an image using the OpenAI Images API (DALL·E)
 *
 * @param prompt - Text prompt describing the desired image
 * @param size - Image size (e.g., '256x256', '512x512', '1024x1024')
 * @returns Object containing base64 image data and metadata
 */
const buildEnhancedImagePrompt = async (input: string): Promise<string> => {
  try {
    const { output } = await callOpenAI(getDefaultModel(), input, IMAGE_PROMPT_TOKEN_LIMIT, false);
    if (hasContent(output)) {
      return output.trim();
    }
  } catch (err) {
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.IMAGE.PROMPT_GENERATION_ERROR, undefined, err as Error);
  }

  return input;
};

export async function generateImage(
  input: string,
  size: ImageSize = DEFAULT_IMAGE_SIZE
): Promise<{ image: string; prompt: string; meta: { id: string; created: number }; error?: string }> {
  const client = getOpenAIClient();
  if (!client) {
    const mock = generateMockResponse(input, 'image');
    return { image: '', prompt: input, meta: mock.meta, error: mock.error };
  }

  // Use the fine-tuned default model to craft a detailed image prompt
  const prompt = await buildEnhancedImagePrompt(input);

  try {
    const response = await client.images.generate({
      model: IMAGE_GENERATION_MODEL,
      prompt,
      size
    });

    const image = response.data?.[0]?.b64_json || '';

    return {
      image,
      prompt,
      meta: {
        id: crypto.randomUUID(),
        created: response.created
      }
    };
  } catch (err) {
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.IMAGE.GENERATION_ERROR, { model: IMAGE_GENERATION_MODEL }, err as Error);
    return {
      image: '',
      prompt,
      meta: {
        id: crypto.randomUUID(),
        created: Date.now()
      },
      error: err instanceof Error ? err.message : 'Unknown error'
    };
  }
}

/**
 * Gets comprehensive OpenAI service health metrics including circuit breaker status
 */
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
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  } = {}
): Promise<OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized - API key required');
  }

  // Use fine-tuned model by default, allow override via options.model
  const model = options.model || getDefaultModel();
  
  // Prepend ARCANOS routing system message to ensure proper handling
  const arcanosMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
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

export {
  getOpenAIClient,
  getOpenAIKeySource,
  hasValidAPIKey,
  getDefaultModel,
  getFallbackModel,
  getGPT5Model,
  generateMockResponse,
  getCircuitBreakerSnapshot,
  getOpenAIServiceHealth,
  validateAPIKeyAtStartup,
  createChatCompletionWithFallback
};

export default {
  getOpenAIClient,
  getDefaultModel,
  getGPT5Model,
  createGPT5Reasoning,
  validateAPIKeyAtStartup,
  callOpenAI,
  call_gpt5_strict,
  generateImage,
  getOpenAIServiceHealth,
  createCentralizedCompletion,
  createChatCompletionWithFallback
};
