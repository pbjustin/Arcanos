import { logOpenAIEvent, logOpenAISuccess } from "@platform/logging/openaiLogger.js";
import { getOpenAIClientOrAdapter } from "../clientBridge.js";
import { generateRequestId } from "@shared/idGenerator.js";
import { responseCache } from "@platform/resilience/cache.js";
import { trackModelResponse, trackPromptUsage } from "@services/contextualReinforcement.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { createCacheKey } from "@shared/hashUtils.js";
import { generateMockResponse } from "../mock.js";
import { OPENAI_LOG_MESSAGES } from "@platform/runtime/openaiLogMessages.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { buildSystemPromptMessages } from "@shared/messageBuilderUtils.js";
import { runtime } from "@services/openaiRuntime.js";
import type OpenAI from 'openai';
import type { OpenAIAdapter } from "@core/adapters/openai.adapter.js";
import type {
  CallOpenAIOptions,
  CallOpenAIResult,
  CallOpenAICacheEntry,
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionResponseFormat
} from '../types.js';
import { CACHE_TTL_MS, DEFAULT_MAX_RETRIES, DEFAULT_SYSTEM_PROMPT, OPENAI_COMPLETION_DEFAULTS, NO_RESPONSE_CONTENT_FALLBACK, REQUEST_ID_HEADER } from "../constants.js";
import { ROUTING_MAX_TOKENS } from "../config.js";
import {
  REASONING_LOG_SUMMARY_LENGTH,
  REASONING_FALLBACK_TEXT,
  REASONING_SYSTEM_PROMPT,
  REASONING_TEMPERATURE,
  REASONING_TOKEN_LIMIT,
  buildReasoningPrompt
} from "@platform/runtime/reasoningTemplates.js";
import { STRICT_ASSISTANT_PROMPT } from "@platform/runtime/openaiPrompts.js";
import { SERVER_CONSTANTS } from "@platform/runtime/serverMessages.js";
import { buildChatMessages } from '../messageBuilder.js';
import { truncateText, hasContent } from "@shared/promptUtils.js";
import { createChatCompletionWithFallback, ensureModelMatchesExpectation } from '../chatFallbacks.js';
import { RESILIENCE_CONSTANTS } from '../resilience.js';
import { getApiTimeoutMs, getRoutingMessage } from '@arcanos/openai/unifiedClient';
import { getDefaultModel, getGPT5Model } from '../credentialProvider.js';
import { classifyOpenAIError } from "@core/lib/errors/reusable.js";
import { getTokenParameter } from "@shared/tokenParameterHelper.js";
import { resolveMaxTokensFromTokenParameters } from './utils.js';
import { prepareChatFlow } from './prepare.js';
import { executeChatFlow } from './execute.js';
import { parseChatFlowResponse } from './parse.js';
import {
  traceOpenAIMock,
  traceOpenAICacheHit,
  traceOpenAIStart,
  traceOpenAIError,
  traceOpenAISuccess,
  logRequestSuccess
} from './trace.js';

import {
  buildResponsesRequest,
  convertResponseToLegacyChatCompletion,
  extractResponseOutputText
} from '../requestBuilders.js';
import {
  createLinkedAbortController,
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  throwIfRequestAborted
} from "@arcanos/runtime";
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

  const { reinforcementMetadata, preparedMessages, cacheKey } = prepareChatFlow(
    model,
    prompt,
    tokenLimit,
    useCache,
    options
  );

  // No client/adapter → deterministic mock path
  if (!adapter) {
    const mock = generateMockResponse(prompt, 'ask');
    traceOpenAIMock(model, options.metadata?.route, 'client_unavailable');

    const mockResult = mock.result ?? '';
    trackModelResponse(mockResult, reinforcementMetadata);

    const mockChatCompletion: ChatCompletion = {
      id: mock.meta.id,
      object: 'chat.completion',
      created: mock.meta.created,
      model: 'mock',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: mockResult, refusal: null },
          finish_reason: 'stop',
          logprobs: null
        }
      ],
      usage: {
        prompt_tokens: mock.meta.tokens.prompt_tokens,
        completion_tokens: mock.meta.tokens.completion_tokens,
        total_tokens: mock.meta.tokens.total_tokens
      }
    };

    return { response: mockChatCompletion, output: mockResult, model: 'mock', cached: false };
  }

  // Cache read
  if (useCache && cacheKey) {
    const cachedResult = responseCache.get(cacheKey) as CallOpenAICacheEntry | undefined;
    if (cachedResult) {
      traceOpenAICacheHit(cacheKey);
      trackModelResponse(cachedResult.output, reinforcementMetadata);
      return { ...cachedResult, cached: true };
    }
  }

  traceOpenAIStart(model, tokenLimit, useCache);

  try {
    // execute (network) → parse (text + legacy shape)
    const rawResponse = await executeChatFlow(adapter, model, preparedMessages, tokenLimit, options);
    const { output, activeModel, legacyResponse } = parseChatFlowResponse(rawResponse, model);

    // Success logging that depends on usage (available after parse)
    logRequestSuccess(activeModel, 1, legacyResponse.usage?.total_tokens);

    const result: CallOpenAIResult = {
      response: legacyResponse,
      output,
      model: activeModel,
      cached: false
    };

    trackModelResponse(result.output, reinforcementMetadata);
    traceOpenAISuccess(result.model, result.cached);

    // Cache write
    if (useCache && cacheKey) {
      const cachePayload: CallOpenAICacheEntry = {
        response: result.response,
        output: result.output,
        model: result.model
      };
      responseCache.set(cacheKey, cachePayload, CACHE_TTL_MS);
    }

    return result;
  } catch (error) {
    traceOpenAIError(model, error);
    throw error;
  }
}


/**
 * Internal OpenAI request handler (single attempt)
 * Retry logic is handled by unifiedRetry module in callOpenAI
 * Implements error taxonomy with specialized handling for different error types
 */

/**
 * Extract reasoning text from OpenAI ChatCompletion response
 * @confidence 1.0 - Type-safe extraction with fallback
 */
const extractReasoningText = (response: ChatCompletion, fallback: string = REASONING_FALLBACK_TEXT): string =>
  response?.choices?.[0]?.message?.content?.trim() || fallback;

interface OpenAIResponsesRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function resolveResponsesTimeoutMs(explicitTimeoutMs?: number): number {
  const baseTimeoutMs = explicitTimeoutMs ?? getApiTimeoutMs();
  const remainingRequestMs = getRequestRemainingMs();

  if (remainingRequestMs === null) {
    return baseTimeoutMs;
  }

  return Math.max(1, Math.min(baseTimeoutMs, remainingRequestMs));
}

async function invokeResponsesCompletion(
  clientOrAdapter: OpenAI | OpenAIAdapter,
  payload: ReturnType<typeof buildResponsesRequest>,
  expectedModel: string,
  options: OpenAIResponsesRequestOptions = {}
): Promise<ChatCompletion> {
  throwIfRequestAborted();

  const requestTimeoutMs = resolveResponsesTimeoutMs(options.timeoutMs);
  const requestScope = createLinkedAbortController({
    timeoutMs: requestTimeoutMs,
    parentSignal: options.signal ?? getRequestAbortSignal(),
    abortMessage: `OpenAI Responses request timed out after ${requestTimeoutMs}ms`
  });

  try {
    const requestOptions = {
      signal: requestScope.signal,
      headers: options.headers
    };
    const responsesResult = 'responses' in clientOrAdapter && typeof (clientOrAdapter as OpenAIAdapter).responses === 'object'
      ? await (clientOrAdapter as OpenAIAdapter).responses.create(payload, requestOptions)
      : await (clientOrAdapter as OpenAI).responses.create(payload, requestOptions);
    return convertResponseToLegacyChatCompletion(responsesResult, expectedModel);
  } finally {
    requestScope.cleanup();
  }
}

/**
 * Centralized GPT-5.1 helper function for reasoning tasks
 * Used by both core logic and workers
 */
export const createGPT5Reasoning = async (
  clientOrAdapter: OpenAI | OpenAIAdapter | null,
  prompt: string,
  systemPrompt?: string,
  options: OpenAIResponsesRequestOptions = {}
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
    const requestPayload = buildResponsesRequest({
      prompt,
      model: gpt5Model,
      messages,
      maxTokens: resolveMaxTokensFromTokenParameters(
        tokenParams as Record<string, unknown>,
        RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS
      ),
      includeRoutingMessage: false
    });
    const response = await invokeResponsesCompletion(clientOrAdapter, requestPayload, gpt5Model, options);
    const resolvedModel = ensureModelMatchesExpectation(response as ChatCompletion, gpt5Model);

    const content = extractReasoningText(response as ChatCompletion);
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.REASONING_SUCCESS, {
      model: resolvedModel,
      preview: truncateText(content, SERVER_CONSTANTS.LOG_PREVIEW_LENGTH)
    });
    return { content, model: resolvedModel };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (isAbortError(error)) {
      throw error;
    }
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
  context?: string,
  options: OpenAIResponsesRequestOptions = {}
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
    const requestPayload = buildResponsesRequest({
      prompt: originalPrompt,
      model: gpt5Model,
      messages,
      maxTokens: resolveMaxTokensFromTokenParameters(
        tokenParams as Record<string, unknown>,
        REASONING_TOKEN_LIMIT
      ),
      temperature: REASONING_TEMPERATURE,
      includeRoutingMessage: false
    });
    const response = await invokeResponsesCompletion(clientOrAdapter, requestPayload, gpt5Model, options);
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
    if (isAbortError(error)) {
      throw error;
    }
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
  kwargs: Partial<ChatCompletionCreateParams> = {},
  options: OpenAIResponsesRequestOptions = {}
): Promise<ChatCompletion> {
  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error("GPT-5.1 call failed — no fallback allowed. OpenAI client not available.");
  }

  const gpt5Model = getGPT5Model();

  try {
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.GPT5.STRICT_CALL, { model: gpt5Model });

    const messages = buildSystemPromptMessages(prompt, STRICT_ASSISTANT_PROMPT);
    const maxTokens = resolveMaxTokensFromTokenParameters(
      kwargs as Record<string, unknown>,
      RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS
    );
    const requestPayload = buildResponsesRequest({
      prompt,
      model: gpt5Model,
      messages,
      maxTokens,
      temperature: kwargs.temperature ?? undefined,
      top_p: kwargs.top_p ?? undefined,
      frequency_penalty: kwargs.frequency_penalty ?? undefined,
      presence_penalty: kwargs.presence_penalty ?? undefined,
      includeRoutingMessage: false
    });

    const response = await invokeResponsesCompletion(client, requestPayload, gpt5Model, options);

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
    signal?: AbortSignal;
  } = {}
): Promise<ChatCompletion | AsyncIterable<unknown>> {
  const { adapter, client } = getOpenAIClientOrAdapter();
  if (!adapter && !client) {
    throw new Error('OpenAI client not initialized - API key required');
  }

  // Use fine-tuned model by default, allow override via options.model
  const model = options.model || getDefaultModel();
  
  // Prepend ARCANOS routing system message to ensure proper handling
  const arcanosMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: getRoutingMessage() },
    ...messages
  ];

  // Record the conversation and model metadata in the lightweight runtime
  const sessionId = runtime.createSession();
  runtime.addMessages(sessionId, arcanosMessages);
  runtime.setMetadata(sessionId, { model });

  logOpenAIEvent('info', `${OPENAI_LOG_MESSAGES.ARCANOS.ROUTING_PREFIX} ${getRoutingMessage()}`, { model });

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
    throwIfRequestAborted();
    const requestOptions = {
      signal: options.signal ?? getRequestAbortSignal(),
      headers: {
        [REQUEST_ID_HEADER]: crypto.randomUUID()
      }
    };

    let response: ChatCompletion | AsyncIterable<unknown>;
    if (requestPayload.stream) {
      //audit Assumption: streaming compatibility remains on chat.completions temporarily; risk: behavior mismatch with Responses stream events; invariant: non-stream calls still use Responses API; handling: preserve legacy stream path until stream abstraction is standardized.
      const streamClient = client ?? adapter?.getClient();
      if (!streamClient) {
        throw new Error('OpenAI client not initialized - streaming unavailable');
      }
      const responsePayload = buildResponsesRequest({
        prompt: '',
        model,
        messages: arcanosMessages,
        maxTokens: resolveMaxTokensFromTokenParameters(
          tokenParams as Record<string, unknown>,
          options.max_tokens || ROUTING_MAX_TOKENS
        ),
        temperature: requestPayload.temperature,
        top_p: requestPayload.top_p,
        frequency_penalty: requestPayload.frequency_penalty,
        presence_penalty: requestPayload.presence_penalty,
        includeRoutingMessage: false
      }) as any;

      const requestTimeoutMs = resolveResponsesTimeoutMs();
      const requestScope = createLinkedAbortController({
        timeoutMs: requestTimeoutMs,
        parentSignal: options.signal ?? getRequestAbortSignal(),
        abortMessage: `OpenAI Responses request timed out after ${requestTimeoutMs}ms`
      });

      try {
        response = await (streamClient as any).responses.create(
          { ...responsePayload, stream: true },
          { ...requestOptions, signal: requestScope.signal }
        );
      } finally {
        requestScope.cleanup();
      }
    } else if (adapter) {
      const responsePayload = buildResponsesRequest({
        prompt: '',
        model,
        messages: arcanosMessages,
        maxTokens: resolveMaxTokensFromTokenParameters(
          tokenParams as Record<string, unknown>,
          options.max_tokens || ROUTING_MAX_TOKENS
        ),
        temperature: requestPayload.temperature,
        top_p: requestPayload.top_p,
        frequency_penalty: requestPayload.frequency_penalty,
        presence_penalty: requestPayload.presence_penalty,
        includeRoutingMessage: false
      });
      response = await invokeResponsesCompletion(adapter, responsePayload, model, requestOptions);
    } else if (client) {
      const responsePayload = buildResponsesRequest({
        prompt: '',
        model,
        messages: arcanosMessages,
        maxTokens: resolveMaxTokensFromTokenParameters(
          tokenParams as Record<string, unknown>,
          options.max_tokens || ROUTING_MAX_TOKENS
        ),
        temperature: requestPayload.temperature,
        top_p: requestPayload.top_p,
        frequency_penalty: requestPayload.frequency_penalty,
        presence_penalty: requestPayload.presence_penalty,
        includeRoutingMessage: false
      });
      response = await invokeResponsesCompletion(client, responsePayload, model, requestOptions);
    } else {
      throw new Error('OpenAI client not initialized');
    }
    
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
