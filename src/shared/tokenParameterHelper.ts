/**
 * Token Parameter Helper for OpenAI API calls
 * 
 * This utility enforces correct token parameter usage across different OpenAI models.
 * - Default to using `max_tokens` for most models
 * - Fallback to `max_completion_tokens` for models that don't support `max_tokens`
 * 
 * Implements safety checks and audit logging as required by the system directive.
 */

import type OpenAI from 'openai';
import { APPLICATION_CONSTANTS } from "@shared/constants.js";

// Known models that require max_completion_tokens instead of max_tokens
// Store lowercase variants to ensure detection is case-insensitive
const MAX_COMPLETION_TOKENS_MODELS = new Set<string>([
  APPLICATION_CONSTANTS.MODEL_GPT_5,
  APPLICATION_CONSTANTS.MODEL_GPT_5_1
].map(m => (m || '').toLowerCase()));

// Cache for model capability testing to avoid repeated API calls
const modelCapabilityCache = new Map<string, 'max_tokens' | 'max_completion_tokens'>();

export interface TokenParameterResult {
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface TokenParameterOptions {
  skipValidation?: boolean;
  forceParameter?: 'max_tokens' | 'max_completion_tokens';
}

export interface TokenParameterLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface TokenParameterDependencies {
  logger?: TokenParameterLogger;
}

const defaultTokenParameterLogger: TokenParameterLogger = {
  info: (message: string): void => {
    console.log(message);
  },
  warn: (message: string): void => {
    console.warn(message);
  }
};

function resolveTokenParameterLogger(dependencies: TokenParameterDependencies): TokenParameterLogger {
  return dependencies.logger ?? defaultTokenParameterLogger;
}

/**
 * Get the appropriate token parameter for a given model and token limit
 * @param modelName - The OpenAI model name (e.g., 'gpt-4', 'gpt-5', 'ft:gpt-3.5-turbo-*')
 * @param tokenLimit - The desired token limit (must be a positive number)
 * @param options - Additional options for parameter selection
 * @returns Object with either max_tokens or max_completion_tokens set
 */
export function getTokenParameter(
  modelName: string,
  tokenLimit: number,
  options: TokenParameterOptions = {},
  dependencies: TokenParameterDependencies = {}
): TokenParameterResult {
  const tokenLogger = resolveTokenParameterLogger(dependencies);

  // Safety: Validate token limit is a number and within safe bounds
  //audit Assumption: invalid limits should fall back; Risk: unintended model usage
  if (typeof tokenLimit !== 'number' || !isFinite(tokenLimit) || tokenLimit <= 0) {
    tokenLogger.warn(`[TOKEN-SAFETY] Invalid token limit: ${tokenLimit}, using default ${APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT}`);
    tokenLimit = APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT;
  }
  
  // Safety: Cap token limit to reasonable maximum (8000 for most models)
  //audit Assumption: cap prevents excessive usage; Handling: clamp to max
  const maxSafeTokens = APPLICATION_CONSTANTS.MAX_SAFE_TOKENS;
  if (tokenLimit > maxSafeTokens) {
    tokenLogger.warn(`[TOKEN-SAFETY] Token limit ${tokenLimit} exceeds safe maximum ${maxSafeTokens}, capping`);
    tokenLimit = maxSafeTokens;
  }

  // Check for forced parameter override
  //audit Assumption: forced parameter is authoritative; Risk: API mismatch
  if (options.forceParameter) {
    const parameterUsed = options.forceParameter;
    tokenLogger.info(`[TOKEN-AUDIT] Model: ${modelName}, Parameter: ${parameterUsed} (forced), Tokens: ${tokenLimit}`);
    return parameterUsed === 'max_tokens' 
      ? { max_tokens: tokenLimit }
      : { max_completion_tokens: tokenLimit };
  }

  // Normalize model name for consistent comparisons and cache keys
  const normalizedModelName = (modelName || '').toLowerCase().trim();

  // Check cache first
  //audit Assumption: cached capability remains valid; Risk: model behavior changes
  const cachedParameter = modelCapabilityCache.get(normalizedModelName);
  if (cachedParameter) {
    tokenLogger.info(`[TOKEN-AUDIT] Model: ${modelName}, Parameter: ${cachedParameter} (cached), Tokens: ${tokenLimit}`);
    return cachedParameter === 'max_tokens'
      ? { max_tokens: tokenLimit }
      : { max_completion_tokens: tokenLimit };
  }

  // Determine parameter based on model name patterns and known limitations
  //audit Assumption: naming conventions map to capability; Risk: mis-detection
  const parameterToUse = determineTokenParameter(normalizedModelName);
  
  // Cache the result for future calls using normalized name
  //audit Assumption: storing capability improves consistency; Handling: cache set
  modelCapabilityCache.set(normalizedModelName, parameterToUse);

  // Log for audit tracking
  tokenLogger.info(`[TOKEN-AUDIT] Model: ${modelName}, Parameter: ${parameterToUse}, Tokens: ${tokenLimit}`);

  return parameterToUse === 'max_tokens'
    ? { max_tokens: tokenLimit }
    : { max_completion_tokens: tokenLimit };
}

/**
 * Determine which token parameter to use based on model name and known capabilities
 * @param modelName - The OpenAI model name
 * @returns The parameter type to use
 */
function determineTokenParameter(modelName: string): 'max_tokens' | 'max_completion_tokens' {
  // Check explicit list first
  //audit Assumption: explicit list overrides heuristics; Handling: direct return
  if (MAX_COMPLETION_TOKENS_MODELS.has(modelName)) {
    return 'max_completion_tokens';
  }

  // Model name pattern analysis
  const lowerModelName = modelName; // already normalized by caller

  // Fine-tuned models typically use max_tokens
  //audit Assumption: fine-tuned models follow max_tokens; Risk: vendor variation
  if (lowerModelName.startsWith('ft:')) {
    return 'max_tokens';
  }

  // GPT-4 variants typically use max_tokens
  //audit Assumption: GPT-4 uses max_tokens; Handling: return max_tokens
  if (lowerModelName.includes('gpt-4')) {
    return 'max_tokens';
  }

  // GPT-3.5 variants typically use max_tokens
  //audit Assumption: GPT-3.5 uses max_tokens; Handling: return max_tokens
  if (lowerModelName.includes('gpt-3.5')) {
    return 'max_tokens';
  }

  // GPT-5.1 models require max_completion_tokens
  //audit Assumption: GPT-5 requires max_completion_tokens; Handling: switch param
  // Also treat Google's Gemini family as using max_completion_tokens
  //audit Assumption: gemini models use the newer token parameter; Handling: switch param
  // Treat any model name that mentions 'gemini' as part of the Gemini family.
  // Use a simple substring check to cover variants like 'gemini-1', 'gpt-gemini', or 'gemini_v1'.
  if (lowerModelName.includes('gemini')) {
    return 'max_completion_tokens';
  }

  if (APPLICATION_CONSTANTS.MODEL_GPT_5 && lowerModelName.includes(APPLICATION_CONSTANTS.MODEL_GPT_5.toLowerCase())) {
    return 'max_completion_tokens';
  }

  // Default to max_tokens for unknown models, with fallback capability
  return 'max_tokens';
}

/**
 * Test a model's token parameter capability by making a minimal API call
 * This function can be used to dynamically discover model capabilities
 * @param client - OpenAI client instance
 * @param modelName - Model to test
 * @returns Promise resolving to the supported parameter type
 */
export async function testModelTokenParameter(
  client: OpenAI,
  modelName: string,
  dependencies: TokenParameterDependencies = {}
): Promise<'max_tokens' | 'max_completion_tokens'> {
  const tokenLogger = resolveTokenParameterLogger(dependencies);
  
  const normalizedModelName = (modelName || '').toLowerCase().trim();
  tokenLogger.info(`[TOKEN-TEST] Testing token parameter capability for model: ${modelName}`);

  // Try max_tokens first (most common)
  try {
    await client.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 1,
      stream: false
    });
    
    // If successful, cache and return max_tokens
    modelCapabilityCache.set(normalizedModelName, 'max_tokens');
    tokenLogger.info(`[TOKEN-TEST] Model ${modelName} supports max_tokens`);
    return 'max_tokens';
    
  } catch (error: unknown) {
    // Check if the error is specifically about the token parameter
    //audit Assumption: error message indicates unsupported param; Handling: fallback
    const errorMessage = getErrorMessage(error).toLowerCase();
    if (errorMessage.includes('max_tokens') || errorMessage.includes('unrecognized')) {
      
      // Try max_completion_tokens as fallback
      try {
        await client.chat.completions.create({
          model: modelName,
          messages: [{ role: 'user', content: 'test' }],
          max_completion_tokens: 1,
          stream: false
        });
        
        // If successful, cache and return max_completion_tokens
        modelCapabilityCache.set(normalizedModelName, 'max_completion_tokens');
        tokenLogger.info(`[TOKEN-TEST] Model ${modelName} supports max_completion_tokens`);
        return 'max_completion_tokens';
        
      } catch (fallbackError: unknown) {
        //audit Assumption: both params failed; Handling: default to max_tokens
        tokenLogger.warn(
          `[TOKEN-TEST] Model ${modelName} failed both token parameters, defaulting to max_tokens: ${getErrorMessage(fallbackError)}`
        );
        modelCapabilityCache.set(normalizedModelName, 'max_tokens');
        return 'max_tokens';
      }
    } else {
      // Error not related to token parameters, assume max_tokens works
      //audit Assumption: non-token error implies max_tokens support; Risk: false
      tokenLogger.info(`[TOKEN-TEST] Model ${modelName} error unrelated to tokens, assuming max_tokens support`);
      modelCapabilityCache.set(normalizedModelName, 'max_tokens');
      return 'max_tokens';
    }
  }
}

function getErrorMessage(error: unknown): string {
  //audit Assumption: extract message for diagnostics; Handling: safe fallbacks
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
}

/**
 * Create OpenAI chat completion parameters with correct token parameter
 * @param baseParams - Base parameters for the API call
 * @param modelName - Model name to use
 * @param tokenLimit - Token limit to apply
 * @returns Complete parameters object with correct token parameter
 */
export function createChatCompletionParams(
  baseParams: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, 'max_tokens' | 'max_completion_tokens'>,
  modelName: string,
  tokenLimit: number,
  dependencies: TokenParameterDependencies = {}
): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  
  //audit Assumption: helper returns valid token param; Handling: spread into payload
  const tokenParams = getTokenParameter(modelName, tokenLimit, {}, dependencies);
  
  return {
    ...baseParams,
    model: modelName,
    ...tokenParams
  };
}

/**
 * Clear the model capability cache (useful for testing or when model capabilities change)
 */
export function clearModelCapabilityCache(dependencies: TokenParameterDependencies = {}): void {
  const tokenLogger = resolveTokenParameterLogger(dependencies);

  //audit Assumption: cache invalidation is intentional; Handling: clear map
  modelCapabilityCache.clear();
  tokenLogger.info(`[TOKEN-CACHE] Model capability cache cleared`);
}

/**
 * Get current cache status for debugging
 */
export function getModelCapabilityCacheStatus(): { 
  size: number; 
  entries: Array<{ model: string; parameter: string }> 
} {
  const entries = Array.from(modelCapabilityCache.entries()).map(([model, parameter]) => ({
    model,
    parameter
  }));
  
  //audit Assumption: expose cache state for diagnostics; Handling: return snapshot
  return {
    size: modelCapabilityCache.size,
    entries
  };
}

export default {
  getTokenParameter,
  testModelTokenParameter,
  createChatCompletionParams,
  clearModelCapabilityCache,
  getModelCapabilityCacheStatus
};
