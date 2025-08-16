import { getOpenAIClient, generateMockResponse } from './openai.js';
import { runThroughBrain } from '../logic/trinity.js';

/**
 * Handles a basic ARCANOS prompt by routing it through the Trinity brain.
 * Falls back to a mocked response when the OpenAI client isn't available.
 * Includes enhanced error handling for network reachability and API issues.
 *
 * @param prompt - User provided prompt text
 * @returns AI response object
 */
export async function handleArcanosPrompt(prompt: string) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt');
  }

  const client = getOpenAIClient();

  // When no OpenAI API key is configured we return a mock response
  if (!client) {
    return generateMockResponse(prompt, 'ask');
  }

  try {
    // Route the prompt through the main Trinity brain processing
    const output = await runThroughBrain(client, prompt);
    return output;
  } catch (error: any) {
    // Enhanced error handling for better diagnostics
    const errorMessage = error.message || 'Unknown error occurred';
    
    // Network connectivity issues
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo ENOTFOUND')) {
      throw new Error(`Network connectivity issue: Unable to resolve OpenAI API hostname. Check internet connection and DNS settings.`);
    }
    
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connect ECONNREFUSED')) {
      throw new Error(`Network connectivity issue: Connection refused by OpenAI API. Check firewall settings and network access.`);
    }
    
    if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout') || errorMessage.includes('ESOCKETTIMEDOUT')) {
      throw new Error(`Request timeout: OpenAI API did not respond within the timeout period. Network may be slow or unstable.`);
    }
    
    // API authentication and authorization issues
    if (errorMessage.includes('401') || errorMessage.includes('unauthorized') || errorMessage.includes('API key')) {
      throw new Error(`API authentication failed: Invalid or missing OpenAI API key. Check your API key configuration.`);
    }
    
    if (errorMessage.includes('403') || errorMessage.includes('forbidden')) {
      throw new Error(`API access forbidden: Your API key does not have permission to access the requested resource.`);
    }
    
    // Rate limiting
    if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      throw new Error(`API rate limit exceeded: Too many requests to OpenAI API. Please wait before retrying.`);
    }
    
    // Service unavailable
    if (errorMessage.includes('502') || errorMessage.includes('503') || errorMessage.includes('504')) {
      throw new Error(`OpenAI API service unavailable: The API is temporarily down or overloaded. Please try again later.`);
    }
    
    // Model-specific errors
    if (errorMessage.includes('model') && errorMessage.includes('does not exist')) {
      throw new Error(`Model not found: The fine-tuned model is not available. Check model configuration and availability.`);
    }
    
    // Re-throw with original message if no specific handling applies
    throw error;
  }
}

