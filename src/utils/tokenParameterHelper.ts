/**
 * Token Parameter Helper for OpenAI API calls
 * 
 * This utility enforces correct token parameter usage across different OpenAI models.
 * - Default to using `max_tokens` for most models
 * - Fallback to `max_completion_tokens` for models that don't support `max_tokens`
 * 
 * Implements safety checks and audit logging as required by the system directive.
 */

import OpenAI from 'openai';

// Known models that require max_completion_tokens instead of max_tokens
const MAX_COMPLETION_TOKENS_MODELS = new Set<string>([
  // Add specific model names here as they are discovered
  // This will be populated based on API testing and documentation
  'gpt-5.1'
]);

// Cache for model capability testing to avoid repeated API calls
const modelCapabilityCache = new Map<string, 'max_tokens' | 'max_completion_tokens'>();

interface TokenParameterResult {
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface TokenParameterOptions {
  skipValidation?: boolean;
  forceParameter?: 'max_tokens' | 'max_completion_tokens';
}

/**
 * Get the appropriate token parameter for a given model and token limit
 * @param modelName - The OpenAI model name (e.g., 'gpt-4', 'gpt-5.1', 'ft:gpt-3.5-turbo-*')
 * @param tokenLimit - The desired token limit (must be a positive number)
 * @param options - Additional options for parameter selection
 * @returns Object with either max_tokens or max_completion_tokens set
 */
export function getTokenParameter(
  modelName: string,
  tokenLimit: number,
  options: TokenParameterOptions = {}
): TokenParameterResult {
  // Safety: Validate token limit is a number and within safe bounds
  if (typeof tokenLimit !== 'number' || !isFinite(tokenLimit) || tokenLimit <= 0) {
    console.warn(`[🔒 TOKEN-SAFETY] Invalid token limit: ${tokenLimit}, using default 1000`);
    tokenLimit = 1000;
  }
  
  // Safety: Cap token limit to reasonable maximum (8000 for most models)
  const maxSafeTokens = 8000;
  if (tokenLimit > maxSafeTokens) {
    console.warn(`[🔒 TOKEN-SAFETY] Token limit ${tokenLimit} exceeds safe maximum ${maxSafeTokens}, capping`);
    tokenLimit = maxSafeTokens;
  }

  // Check for forced parameter override
  if (options.forceParameter) {
    const parameterUsed = options.forceParameter;
    console.log(`[📊 TOKEN-AUDIT] Model: ${modelName}, Parameter: ${parameterUsed} (forced), Tokens: ${tokenLimit}`);
    return parameterUsed === 'max_tokens' 
      ? { max_tokens: tokenLimit }
      : { max_completion_tokens: tokenLimit };
  }

  // Check cache first
  const cachedParameter = modelCapabilityCache.get(modelName);
  if (cachedParameter) {
    console.log(`[📊 TOKEN-AUDIT] Model: ${modelName}, Parameter: ${cachedParameter} (cached), Tokens: ${tokenLimit}`);
    return cachedParameter === 'max_tokens'
      ? { max_tokens: tokenLimit }
      : { max_completion_tokens: tokenLimit };
  }

  // Determine parameter based on model name patterns and known limitations
  const parameterToUse = determineTokenParameter(modelName);
  
  // Cache the result for future calls
  modelCapabilityCache.set(modelName, parameterToUse);

  // Log for audit tracking
  console.log(`[📊 TOKEN-AUDIT] Model: ${modelName}, Parameter: ${parameterToUse}, Tokens: ${tokenLimit}`);

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
  if (MAX_COMPLETION_TOKENS_MODELS.has(modelName)) {
    return 'max_completion_tokens';
  }

  // Model name pattern analysis
  const lowerModelName = modelName.toLowerCase();

  // Fine-tuned models typically use max_tokens
  if (lowerModelName.startsWith('ft:')) {
    return 'max_tokens';
  }

  // GPT-4 variants typically use max_tokens
  if (lowerModelName.includes('gpt-4')) {
    return 'max_tokens';
  }

  // GPT-3.5 variants typically use max_tokens
  if (lowerModelName.includes('gpt-3.5')) {
    return 'max_tokens';
  }

  // GPT-5 models require max_completion_tokens
  if (lowerModelName.includes('gpt-5')) {
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
  modelName: string
): Promise<'max_tokens' | 'max_completion_tokens'> {
  
  console.log(`[🔬 TOKEN-TEST] Testing token parameter capability for model: ${modelName}`);

  // Try max_tokens first (most common)
  try {
    await client.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 1,
      stream: false
    });
    
    // If successful, cache and return max_tokens
    modelCapabilityCache.set(modelName, 'max_tokens');
    console.log(`[✅ TOKEN-TEST] Model ${modelName} supports max_tokens`);
    return 'max_tokens';
    
  } catch (error: any) {
    // Check if the error is specifically about the token parameter
    const errorMessage = error?.message?.toLowerCase() || '';
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
        modelCapabilityCache.set(modelName, 'max_completion_tokens');
        console.log(`[✅ TOKEN-TEST] Model ${modelName} supports max_completion_tokens`);
        return 'max_completion_tokens';
        
      } catch {
        console.warn(`[⚠️ TOKEN-TEST] Model ${modelName} failed both token parameters, defaulting to max_tokens`);
        modelCapabilityCache.set(modelName, 'max_tokens');
        return 'max_tokens';
      }
    } else {
      // Error not related to token parameters, assume max_tokens works
      console.log(`[✅ TOKEN-TEST] Model ${modelName} error unrelated to tokens, assuming max_tokens support`);
      modelCapabilityCache.set(modelName, 'max_tokens');
      return 'max_tokens';
    }
  }
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
  tokenLimit: number
): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  
  const tokenParams = getTokenParameter(modelName, tokenLimit);
  
  return {
    ...baseParams,
    model: modelName,
    ...tokenParams
  };
}

/**
 * Clear the model capability cache (useful for testing or when model capabilities change)
 */
export function clearModelCapabilityCache(): void {
  modelCapabilityCache.clear();
  console.log(`[🔄 TOKEN-CACHE] Model capability cache cleared`);
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