import OpenAI from 'openai';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { CircuitBreaker, ExponentialBackoff } from '../utils/circuitBreaker.js';
import { responseCache } from '../utils/cache.js';
import { aiLogger } from '../utils/structuredLogging.js';
import crypto from 'crypto';
import { runtime } from './openaiRuntime.js';

type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionResponseFormat =
  OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];

let openai: OpenAI | null = null;
let defaultModel: string | null = null;
const API_TIMEOUT_MS = parseInt(process.env.WORKER_API_TIMEOUT_MS || '60000', 10);

// OpenAI API Configuration Constants
const OPENAI_CONSTANTS = {
  DEFAULT_MAX_TOKENS: 1024,
  RATE_LIMIT_JITTER_MAX_MS: 2000, // 0-2 seconds additional jitter for rate limits
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 30000, // 30 seconds
  CIRCUIT_BREAKER_MONITORING_PERIOD_MS: 60000, // 1 minute
  BACKOFF_BASE_DELAY_MS: 1000, // 1 second
  BACKOFF_MAX_DELAY_MS: 30000, // 30 seconds
  BACKOFF_MULTIPLIER: 2,
  BACKOFF_JITTER_MAX_MS: 500
} as const;

// Initialize circuit breaker for OpenAI API calls
const openaiCircuitBreaker = new CircuitBreaker({
  failureThreshold: OPENAI_CONSTANTS.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  resetTimeoutMs: OPENAI_CONSTANTS.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  monitoringPeriodMs: OPENAI_CONSTANTS.CIRCUIT_BREAKER_MONITORING_PERIOD_MS
});

// Initialize exponential backoff for retries
const backoffStrategy = new ExponentialBackoff(
  OPENAI_CONSTANTS.BACKOFF_BASE_DELAY_MS,
  OPENAI_CONSTANTS.BACKOFF_MAX_DELAY_MS,
  OPENAI_CONSTANTS.BACKOFF_MULTIPLIER,
  OPENAI_CONSTANTS.BACKOFF_JITTER_MAX_MS
);

export interface CallOpenAIOptions {
  systemPrompt?: string;
  messages?: ChatCompletionMessageParam[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  responseFormat?: ChatCompletionResponseFormat;
  user?: string;
  metadata?: Record<string, unknown>;
}

interface CallOpenAICacheEntry {
  response: any;
  output: string;
  model: string;
}

export interface CallOpenAIResult extends CallOpenAICacheEntry {
  cached?: boolean;
}

/**
 * Generates mock AI responses when OpenAI API key is not available
 *
 * @param input - User input text to generate a mock response for
 * @param endpoint - API endpoint name (ask, write, guide, audit, sim, etc.)
 * @returns Mock response object with realistic structure matching real AI responses
 */
export const generateMockResponse = (input: string, endpoint: string = 'ask'): any => {
  const mockId = generateRequestId('mock');
  const timestamp = Math.floor(Date.now() / 1000);
  
  const baseMockResponse = {
    meta: {
      id: mockId,
      created: timestamp,
      tokens: {
        prompt_tokens: 50,
        completion_tokens: 100,
        total_tokens: 150
      }
    },
    activeModel: 'MOCK',
    fallbackFlag: false,
    gpt5Used: true,
    routingStages: ['ARCANOS-INTAKE:MOCK', 'GPT5-REASONING', 'ARCANOS-FINAL'],
    auditSafe: {
      mode: true,
      overrideUsed: input.toLowerCase().includes('override'),
      overrideReason: input.toLowerCase().includes('override') ? 'Mock override detected in input' : undefined,
      auditFlags: ['MOCK_MODE', 'AUDIT_SAFE_ACTIVE'],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: Math.floor(Math.random() * 3),
      contextSummary: 'Mock memory context - no real memory system active',
      memoryEnhanced: Math.random() > 0.5
    },
    taskLineage: {
      requestId: mockId,
      logged: true
    },
    error: 'OPENAI_API_KEY not configured - returning mock response'
  };

  switch (endpoint) {
    case 'arcanos':
      return {
        ...baseMockResponse,
        result: `[MOCK ARCANOS RESPONSE] System analysis for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        componentStatus: 'MOCK: All systems simulated as operational',
        suggestedFixes: 'MOCK: Configure OPENAI_API_KEY for real analysis',
        coreLogicTrace: 'MOCK: Trinity -> ARCANOS -> Mock Response Generator',
        gpt5Delegation: {
          used: true,
          reason: 'Unconditional GPT-5 routing (mock)',
          delegatedQuery: input
        }
      };
    case 'ask':
    case 'brain':
      return {
        ...baseMockResponse,
        result: `[MOCK AI RESPONSE] Processed request: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockBrain'
      };
    case 'write':
      return {
        ...baseMockResponse,
        result: `[MOCK WRITE RESPONSE] Generated content for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockWriter',
        endpoint: 'write'
      };
    case 'guide':
      return {
        ...baseMockResponse,
        result: `[MOCK GUIDE RESPONSE] Step-by-step guidance for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockGuide',
        endpoint: 'guide'
      };
    case 'audit':
      return {
        ...baseMockResponse,
        result: `[MOCK AUDIT RESPONSE] Analysis and evaluation of: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockAuditor',
        endpoint: 'audit'
      };
    case 'sim':
      return {
        ...baseMockResponse,
        result: `[MOCK SIMULATION RESPONSE] Scenario modeling for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockSimulator',
        endpoint: 'sim'
      };
    default:
      return {
        ...baseMockResponse,
        result: `[MOCK RESPONSE] Processed request: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockProcessor'
      };
  }
};

/**
 * Validates whether a proper OpenAI API key is configured
 * 
 * @returns True if API key is set and valid, false otherwise
 */
export const hasValidAPIKey = (): boolean => {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  return !!(apiKey && apiKey.trim() !== '' && apiKey !== 'your-openai-api-key-here' && apiKey !== 'your-openai-key-here');
};

/**
 * Initializes OpenAI client with API key validation and default model configuration
 * 
 * @returns OpenAI client instance or null if initialization fails
 */
const initializeOpenAI = (): OpenAI | null => {
  if (openai) return openai;

  try {
    const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
    if (!hasValidAPIKey()) {
      aiLogger.warn('OpenAI API key not configured - AI endpoints will return mock responses', { 
        operation: 'initialization' 
      });
      return null; // Return null to indicate mock mode
    }

    openai = new OpenAI({ apiKey, timeout: API_TIMEOUT_MS });
    // Support OPENAI_MODEL (primary), FINETUNED_MODEL_ID, and AI_MODEL for Railway compatibility
    defaultModel =
      process.env.OPENAI_MODEL ||
      process.env.FINETUNED_MODEL_ID ||
      process.env.FINE_TUNED_MODEL_ID ||
      process.env.AI_MODEL ||
      'gpt-4o';
    
    console.log('✅ OpenAI client initialized');
    console.log(`🧠 Default AI Model: ${defaultModel}`);
    console.log(`🔄 Fallback Model: ${getFallbackModel()}`);
    console.log('🎯 ARCANOS routing active - all calls will use configured model by default');
    
    return openai;
  } catch (error) {
    console.error('❌ Failed to initialize OpenAI client:', error);
    return null;
  }
};

/**
 * Gets the active OpenAI client instance, initializing if needed
 * 
 * @returns OpenAI client instance or null if unavailable
 */
export const getOpenAIClient = (): OpenAI | null => {
  return openai || initializeOpenAI();
};

/**
 * Gets the configured default AI model (typically fine-tuned)
 * Supports OPENAI_MODEL (primary), FINETUNED_MODEL_ID and AI_MODEL for Railway compatibility
 * 
 * @returns Model identifier string (defaults to gpt-4o)
 */
export const getDefaultModel = (): string => {
  return (
    defaultModel ||
    process.env.OPENAI_MODEL ||
    process.env.FINETUNED_MODEL_ID ||
    process.env.FINE_TUNED_MODEL_ID ||
    process.env.AI_MODEL ||
    'gpt-4o'
  );
};

/**
 * Gets the configured GPT-5 model identifier
 * 
 * @returns GPT-5 model string (defaults to 'gpt-5')
 */
export const getGPT5Model = (): string => {
  return process.env.GPT5_MODEL || 'gpt-5';
};

/**
 * Gets the fallback model when primary model fails
 * Prioritizes explicit fallback configuration, then fine-tuned selections
 *
 * @returns Fallback model identifier (defaults to 'gpt-4')
 */
export function getFallbackModel(): string {
  return (
    process.env.FALLBACK_MODEL ||
    process.env.AI_FALLBACK_MODEL ||
    process.env.FINETUNED_MODEL_ID ||
    process.env.FINE_TUNED_MODEL_ID ||
    process.env.AI_MODEL ||
    'gpt-4'
  );
}

/**
 * Prepare payloads for GPT-5 by migrating deprecated max_tokens
 * to max_completion_tokens and providing a sensible default.
 */
function prepareGPT5Request(payload: any): any {
  if (payload.model && typeof payload.model === 'string' && payload.model.includes('gpt-5')) {
    // GPT-5 uses max_output_tokens in the new Responses API
    if (payload.max_tokens) {
      payload.max_output_tokens = payload.max_tokens;
      delete payload.max_tokens;
    }
    if (payload.max_completion_tokens) {
      payload.max_output_tokens = payload.max_completion_tokens;
      delete payload.max_completion_tokens;
    }
    if (!payload.max_output_tokens) {
      payload.max_output_tokens = OPENAI_CONSTANTS.DEFAULT_MAX_TOKENS;
    }
  }
  return payload;
}

/**
 * Creates a cache key for OpenAI requests
 */
const createCacheKey = (model: string, payload: unknown): string => {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const content = `${model}:${serialized}`;
  return crypto.createHash('sha256').update(content).digest('hex');
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
  if (!client) {
    const mock = generateMockResponse(prompt, 'ask');
    return { response: mock, output: mock.result, model: 'mock', cached: false };
  }

  const systemPrompt = options.systemPrompt ?? 'You are a helpful AI assistant.';
  let preparedMessages: ChatCompletionMessageParam[];

  if (options.messages && options.messages.length > 0) {
    preparedMessages = [...options.messages];

    if (options.systemPrompt) {
      const hasSystemMessage = preparedMessages.some(message => message.role === 'system');
      if (!hasSystemMessage) {
        preparedMessages = [{ role: 'system', content: systemPrompt }, ...preparedMessages];
      }
    }
  } else {
    preparedMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];
  }

  if (options.metadata) {
    aiLogger.debug('OpenAI call metadata', {
      operation: 'callOpenAI',
      model,
      ...options.metadata
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
      console.log('💾 Cache hit for OpenAI request');
      return { ...cachedResult, cached: true };
    }
  }

  // Use circuit breaker for resilient API calls
  const result = await openaiCircuitBreaker.execute(async () => {
    return await makeOpenAIRequest(client, model, preparedMessages, tokenLimit, options);
  });

  // Cache successful results
  if (useCache && result && cacheKey) {
    const cachePayload: CallOpenAICacheEntry = {
      response: result.response,
      output: result.output,
      model: result.model
    };
    responseCache.set(cacheKey, cachePayload, 5 * 60 * 1000); // 5 minutes
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
  maxRetries: number = 3
): Promise<CallOpenAIResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    
    try {
      // Apply exponential backoff with jitter on retries
      if (attempt > 1) {
        const delay = getRetryDelay(attempt - 1, lastError);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const tokenParams = getTokenParameter(model, tokenLimit);
      const requestPayload = prepareGPT5Request({
        model,
        messages,
        ...tokenParams,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.top_p !== undefined ? { top_p: options.top_p } : {}),
        ...(options.frequency_penalty !== undefined
          ? { frequency_penalty: options.frequency_penalty }
          : {}),
        ...(options.presence_penalty !== undefined
          ? { presence_penalty: options.presence_penalty }
          : {}),
        ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
        ...(options.user !== undefined ? { user: options.user } : {})
      });

      console.log(`🤖 OpenAI request (attempt ${attempt}/${maxRetries}) - Model: ${model}`);

      const response: any = await client.chat.completions.create(
        requestPayload,
        { 
          signal: controller.signal,
          // Add request ID for tracing
          headers: {
            'X-Request-ID': crypto.randomUUID()
          }
        }
      );
      
      clearTimeout(timeout);
      const output = response.choices?.[0]?.message?.content || '';
      const activeModel = response.model || model;

      // Log success metrics
      console.log(
        `✅ OpenAI request succeeded (attempt ${attempt}) - Model: ${activeModel}, Tokens: ${
          response.usage?.total_tokens || 'unknown'
        }`
      );

      return { response, output, model: activeModel, cached: false };
      
    } catch (err: any) {
      clearTimeout(timeout);
      lastError = err;
      
      const isRetryable = isRetryableError(err);
      const shouldRetry = attempt < maxRetries && isRetryable;
      
      // Enhanced error logging with error taxonomy
      const errorType = err.status === 429 ? 'RATE_LIMIT' : 
                       err.status >= 500 ? 'SERVER_ERROR' :
                       err.code === 'ETIMEDOUT' ? 'TIMEOUT' :
                       err.code === 'ECONNRESET' ? 'NETWORK_ERROR' : 
                       'UNKNOWN';
      
      console.warn(`⚠️ OpenAI request failed (attempt ${attempt}/${maxRetries}, type: ${errorType}): ${err.message}`);
      
      if (!shouldRetry) {
        console.error(`❌ OpenAI request failed permanently after ${attempt} attempts`);
        break;
      }
      
      console.log(`🔄 Retrying OpenAI request (${maxRetries - attempt} attempts remaining)`);
    }
  }

  throw lastError || new Error('OpenAI request failed after all retry attempts');
}

/**
 * Determines if an error is retryable based on error taxonomy
 * 
 * Error Taxonomy:
 * - 429 (Rate Limit): Retryable with exponential backoff + jitter
 * - 5xx (Server Error): Retryable with capped retries (max 3)
 * - Network errors (ECONNRESET, ETIMEDOUT): Retryable with backoff
 * - 4xx (Client Error, except 429): Not retryable
 */
function isRetryableError(error: any): boolean {
  // Network errors and timeouts are retryable
  if (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    return true;
  }
  
  // OpenAI API rate limits (429) and server errors (5xx) are retryable
  if (error.status) {
    return error.status === 429 || error.status >= 500;
  }
  
  // Default to non-retryable for unknown errors
  return false;
}

/**
 * Calculate retry delay with jitter for 429 errors
 * Uses exponential backoff with random jitter to prevent thundering herd
 */
function getRetryDelay(attempt: number, error: any): number {
  const baseDelay = backoffStrategy.calculateDelay(attempt);
  
  // Add extra jitter for rate limit errors (429)
  if (error?.status === 429) {
    const jitterMs = Math.random() * OPENAI_CONSTANTS.RATE_LIMIT_JITTER_MAX_MS;
    console.log(`⏱️ Rate limit detected - adding jitter (${jitterMs.toFixed(0)}ms)`);
    return baseDelay + jitterMs;
  }
  
  return baseDelay;
}

/**
 * Helper to attempt API call with a specific model
 */
async function attemptModelCall(
  client: OpenAI,
  params: any,
  model: string,
  logPrefix: string
): Promise<{ response: any; model: string }> {
  console.log(`${logPrefix} Attempting with model: ${model}`);
  const response = await client.chat.completions.create({
    ...params,
    model
  });
  console.log(`✅ ${logPrefix} Success with ${model}`);
  return { response, model };
}

/**
 * Helper to attempt GPT-5 call with proper token parameter handling
 */
async function attemptGPT5Call(
  client: OpenAI,
  params: any,
  gpt5Model: string
): Promise<{ response: any; model: string }> {
  console.log(`🚀 [GPT-5 FALLBACK] Attempting with GPT-5: ${gpt5Model}`);
  
  const tokenParams = getTokenParameter(gpt5Model, params.max_tokens || params.max_completion_tokens || OPENAI_CONSTANTS.DEFAULT_MAX_TOKENS);
  const gpt5Payload = prepareGPT5Request({
    ...params,
    model: gpt5Model,
    ...tokenParams
  });
  
  const response = await client.chat.completions.create(gpt5Payload);
  console.log(`✅ [GPT-5 FALLBACK] Success with ${gpt5Model}`);
  return { response, model: gpt5Model };
}

/**
 * Enhanced chat completion with graceful fallback handling
 * Sequence: fine-tuned GPT-4.1 → retry → GPT-5 → configured fallback
 */
export const createChatCompletionWithFallback = async (
  client: OpenAI,
  params: any
): Promise<any> => {
  const primaryModel = getDefaultModel(); // fine-tuned GPT-4.1
  const gpt5Model = getGPT5Model();
  const finalFallbackModel = getFallbackModel(); // Configurable fallback
  
  // First attempt with the fine-tuned model
  try {
    const { response, model } = await attemptModelCall(client, params, primaryModel, '🧠 [PRIMARY]');
    return {
      ...response,
      activeModel: model,
      fallbackFlag: false
    };
  } catch (primaryError) {
    console.warn(`⚠️ [PRIMARY] Failed: ${primaryError instanceof Error ? primaryError.message : 'Unknown error'}`);
    
    // Retry with the fine-tuned model once more
    try {
      const { response, model } = await attemptModelCall(client, params, primaryModel, '🔄 [RETRY]');
      return {
        ...response,
        activeModel: model,
        fallbackFlag: false,
        retryUsed: true
      };
    } catch (retryError) {
      console.warn(`⚠️ [RETRY] Also failed: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`);
      
      // Fall back to GPT-5
      try {
        const { response, model } = await attemptGPT5Call(client, params, gpt5Model);
        return {
          ...response,
          activeModel: model,
          fallbackFlag: true,
          fallbackReason: `Primary model ${primaryModel} failed twice, used GPT-5`,
          gpt5Used: true
        };
      } catch (gpt5Error) {
        console.warn(`⚠️ [GPT-5 FALLBACK] Failed: ${gpt5Error instanceof Error ? gpt5Error.message : 'Unknown error'}`);
        
        // Final fallback to configured backup model
        try {
          const { response, model } = await attemptModelCall(client, params, finalFallbackModel, '🛟 [FINAL FALLBACK]');
          return {
            ...response,
            activeModel: model,
            fallbackFlag: true,
            fallbackReason: `All models failed: ${primaryModel} (primary), ${gpt5Model} (GPT-5 fallback), using final fallback`
          };
        } catch {
          console.error(`❌ [COMPLETE FAILURE] All fallback attempts failed`);
          throw new Error(`All models failed: Primary (${primaryModel}), GPT-5 (${gpt5Model}), Final (${finalFallbackModel})`);
        }
      }
    }
  }
};

export const validateAPIKeyAtStartup = (): boolean => {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'your-openai-api-key-here' || apiKey === 'your-openai-key-here') {
    console.warn('⚠️ OPENAI_API_KEY not set - will return mock responses');
    return true; // Allow startup but return mock responses
  }
  console.log('✅ OPENAI_API_KEY validation passed');
  return true;
};

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

const ensureModelMatchesExpectation = (response: any, expectedModel: string): string => {
  const actualModel = typeof response?.model === 'string' ? response.model.trim() : '';

  if (!actualModel) {
    throw new Error(`GPT-5 reasoning response did not include a model identifier. Expected '${expectedModel}'.`);
  }

  const normalizedActual = normalizeModelId(actualModel);
  const normalizedExpected = normalizeModelId(expectedModel);

  const matchesExpected =
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(`${normalizedExpected}-`) ||
    normalizedActual.startsWith(`${normalizedExpected}.`);

  if (!matchesExpected) {
    throw new Error(
      `GPT-5 reasoning response used unexpected model '${actualModel}'. Expected model to start with '${expectedModel}'.`
    );
  }

  return actualModel;
};

/**
 * Centralized GPT-5 helper function for reasoning tasks
 * Used by both core logic and workers
 */
export const createGPT5Reasoning = async (
  client: OpenAI,
  prompt: string,
  systemPrompt?: string
): Promise<{ content: string; model?: string; error?: string }> => {
  if (!client) {
    return { content: '[Fallback: GPT-5 unavailable - no OpenAI client]', error: 'No OpenAI client' };
  }

  try {
    const gpt5Model = getGPT5Model();
    console.log(`🚀 [GPT-5 REASONING] Using model: ${gpt5Model}`);

    // Use token parameter utility for correct parameter selection
    const tokenParams = getTokenParameter(gpt5Model, OPENAI_CONSTANTS.DEFAULT_MAX_TOKENS);

    const requestPayload = prepareGPT5Request({
      model: gpt5Model,
      input: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: prompt }
      ],
      text: { verbosity: 'medium' as const },
      reasoning: { effort: 'minimal' as const },
      ...tokenParams,
      // Temperature omitted to use default (1) for GPT-5
    });

    const response: any = await client.responses.create(requestPayload);
    const resolvedModel = ensureModelMatchesExpectation(response, gpt5Model);

    const content =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      '[No reasoning provided]';
    console.log(`✅ [GPT-5 REASONING] Success: ${content.substring(0, 100)}...`);
    return { content, model: resolvedModel };
  } catch (err: any) {
    const errorMsg = err?.message || 'Unknown error';
    console.error(`❌ [GPT-5 REASONING] Error: ${errorMsg}`);
    return { content: `[Fallback: GPT-5 unavailable - ${errorMsg}]`, error: errorMsg };
  }
};

/**
 * Enhanced GPT-5 reasoning layer that refines ARCANOS responses
 * Implements the layered approach: ARCANOS -> GPT-5 reasoning -> refined output
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
      error: 'No OpenAI client available for GPT-5 reasoning' 
    };
  }

  try {
    const gpt5Model = getGPT5Model();
    console.log(`🔄 [GPT-5 LAYER] Refining ARCANOS response with ${gpt5Model}`);

    // Construct reasoning prompt that asks GPT-5 to analyze and refine ARCANOS output
    const reasoningPrompt = `As an advanced reasoning engine, analyze and refine the following ARCANOS response:

ORIGINAL USER REQUEST:
${originalPrompt}

ARCANOS RESPONSE:
${arcanosResult}

${context ? `ADDITIONAL CONTEXT:\n${context}\n` : ''}

Your task:
1. Evaluate the logical consistency and completeness of the ARCANOS response
2. Identify any gaps in reasoning or potential improvements
3. Provide a refined, enhanced version that maintains ARCANOS's core analysis while adding deeper insights
4. Ensure the response is well-structured and comprehensive

Return only the refined response without meta-commentary about your analysis process.`;

    const systemPrompt = `You are an advanced reasoning layer for ARCANOS AI. Your role is to refine and enhance ARCANOS responses through deeper analysis while preserving the original intent and structure. Focus on logical consistency, completeness, and clarity.`;

    const tokenParams = getTokenParameter(gpt5Model, 1500);

    const requestPayload = prepareGPT5Request({
      model: gpt5Model,
      input: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: reasoningPrompt }
      ],
      text: { verbosity: 'medium' as const },
      reasoning: { effort: 'minimal' as const },
      ...tokenParams,
      temperature: 0.7 // Balanced creativity for reasoning
    });

    const response: any = await client.responses.create(requestPayload);
    const resolvedModel = ensureModelMatchesExpectation(response, gpt5Model);

    const reasoningContent =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      '[No reasoning provided]';

    // The GPT-5 response IS the refined result
    const refinedResult = reasoningContent;
    
    console.log(`✅ [GPT-5 LAYER] Successfully refined response (${refinedResult.length} chars)`);
    
    return {
      refinedResult,
      reasoningUsed: true,
      reasoningContent: reasoningContent.substring(0, 200) + '...', // Summary for logging
      model: resolvedModel
    };
  } catch (err: any) {
    const errorMsg = err?.message || 'Unknown error';
    console.error(`❌ [GPT-5 LAYER] Reasoning layer failed: ${errorMsg}`);
    
    // Return original ARCANOS result on failure
    return { 
      refinedResult: arcanosResult, 
      reasoningUsed: false, 
      error: errorMsg 
    };
  }
};

/**
 * Strict GPT-5 call function that only uses GPT-5 with no fallback
 * Raises RuntimeError if the response doesn't come from GPT-5
 */
export async function call_gpt5_strict(prompt: string, kwargs: any = {}): Promise<any> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error("GPT-5 call failed — no fallback allowed. OpenAI client not available.");
  }

  const gpt5Model = getGPT5Model();

  try {
    console.log(`🎯 [GPT-5 STRICT] Making strict call with model: ${gpt5Model}`);

    const requestPayload = prepareGPT5Request({
      model: gpt5Model,
      input: [
        { role: 'system', content: 'You are a precise and safe code assistant.' },
        { role: 'user', content: prompt }
      ],
      text: { verbosity: 'medium' },
      reasoning: { effort: 'minimal' },
      ...kwargs
    });

    const response: any = await client.responses.create(requestPayload);

    // Validate that the response actually came from GPT-5
    if (!response.model || response.model !== gpt5Model) {
      throw new Error(
        `GPT-5 call failed — no fallback allowed. Expected model '${gpt5Model}' but got '${response.model || 'undefined'}'.`
      );
    }

    console.log(`✅ [GPT-5 STRICT] Success with model: ${response.model}`);
    return response;
  } catch (error: any) {
    // Re-throw with clear error message indicating no fallback
    throw new Error(`GPT-5 call failed — no fallback allowed. ${error.message}`);
  }
}

/**
 * Generates an image using the OpenAI Images API (DALL·E)
 *
 * @param prompt - Text prompt describing the desired image
 * @param size - Image size (e.g., '256x256', '512x512', '1024x1024')
 * @returns Object containing base64 image data and metadata
 */
type ImageSize =
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | '1792x1024'
  | '1024x1792'
  | 'auto';

export async function generateImage(
  input: string,
  size: ImageSize = '1024x1024'
): Promise<{ image: string; prompt: string; meta: { id: string; created: number }; error?: string }> {
  const client = getOpenAIClient();
  if (!client) {
    const mock = generateMockResponse(input, 'image');
    return { image: '', prompt: input, meta: mock.meta, error: mock.error };
  }

  // Use the fine-tuned default model to craft a detailed image prompt
  let prompt = input;
  try {
    const { output } = await callOpenAI(getDefaultModel(), input, 256, false);
    if (output && output.trim().length > 0) {
      prompt = output.trim();
    }
  } catch (err) {
    console.error('❌ Failed to generate prompt via fine-tuned model:', err);
  }

  const response = await client.images.generate({
    model: 'gpt-image-1',
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
}

/**
 * Gets comprehensive OpenAI service health metrics including circuit breaker status
 */
export const getOpenAIServiceHealth = () => {
  const circuitBreakerMetrics = openaiCircuitBreaker.getMetrics();
  const cacheStats = responseCache.getStats();
  
  return {
    apiKey: {
      configured: hasValidAPIKey(),
      status: hasValidAPIKey() ? 'valid' : 'missing_or_invalid'
    },
    client: {
      initialized: openai !== null,
      model: defaultModel,
      timeout: API_TIMEOUT_MS
    },
    circuitBreaker: {
      ...circuitBreakerMetrics,
      healthy: circuitBreakerMetrics.state !== 'OPEN'
    },
    cache: {
      ...cacheStats,
      enabled: true
    },
    lastHealthCheck: new Date().toISOString()
  };
};

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
    { role: 'system', content: 'ARCANOS routing active' },
    ...messages
  ];

  // Record the conversation and model metadata in the lightweight runtime
  const sessionId = runtime.createSession();
  runtime.addMessages(sessionId, arcanosMessages);
  runtime.setMetadata(sessionId, { model });

  console.log(`🎯 ARCANOS centralized routing - Model: ${model}`);

  // Prepare request with token parameters for the specific model
  const tokenParams = getTokenParameter(model, options.max_tokens || 4096);
  
  const requestPayload = {
    model,
    messages: arcanosMessages,
    temperature: options.temperature ?? 0.7,
    top_p: options.top_p ?? 1,
    frequency_penalty: options.frequency_penalty ?? 0,
    presence_penalty: options.presence_penalty ?? 0,
    stream: options.stream ?? false,
    ...tokenParams
  };

  try {
    const response = await client.chat.completions.create(requestPayload);
    
    if (!options.stream && 'usage' in response) {
      console.log(`✅ ARCANOS completion successful - Model: ${model}, Tokens: ${response.usage?.total_tokens || 'unknown'}`);
    } else {
      console.log(`✅ ARCANOS streaming completion started - Model: ${model}`);
    }
    
    return response;
  } catch (error) {
    console.error(`❌ ARCANOS completion failed - Model: ${model}:`, error);
    throw error;
  }
}

export default { getOpenAIClient, getDefaultModel, getGPT5Model, createGPT5Reasoning, validateAPIKeyAtStartup, callOpenAI, call_gpt5_strict, generateImage, getOpenAIServiceHealth, createCentralizedCompletion };