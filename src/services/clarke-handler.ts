/**
 * ClarkeHandler - Resilient OpenAI Handler with Fallback Support
 * Provides enterprise-grade resilience, retry logic, and fallback mechanisms
 * for OpenAI API interactions across the ARCANOS system.
 */

import OpenAI from 'openai';
import { getGPT4FallbackService } from './gpt4-fallback.js';
import { createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('ClarkeHandler');

// Global type declaration for resilience handler state
declare global {
  var resilienceHandlerInitialized: boolean | undefined;
}

export interface ResilienceOptions {
  retries: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
}

export interface ClarkeHandlerOptions {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  [key: string]: any;
}

/**
 * Generic fallback function that provides basic error recovery
 */
export function genericFallback() {
  return {
    async handle(error: any, context: any = {}) {
      console.log('Generic fallback triggered', { error: error.message, context });
      
      // Try GPT4 fallback service for malformed outputs
      if (context.output && context.task) {
        try {
          const fallbackService = getGPT4FallbackService();
          const result = await fallbackService.fallbackToGPT4({
            task: context.task,
            malformedOutput: context.output,
            expectedFormat: context.expectedFormat || 'text'
          });
          
          if (result.success) {
            console.log('Generic fallback successful via GPT4 service');
            return result.repairedOutput;
          }
        } catch (fallbackError) {
          console.error('Generic fallback failed', { error: fallbackError });
        }
      }
      
      // Default fallback response
      return {
        success: false,
        error: 'Service temporarily unavailable. Please try again later.',
        fallback: true,
        originalError: error.message
      };
    }
  };
}

/**
 * Enhanced OpenAI handler with resilience and fallback capabilities
 */
export class ClarkeHandler {
  private openaiClient: OpenAI;
  private resilienceConfig?: ResilienceOptions;
  private fallbackHandler?: any;
  private initialized: boolean = false;

  constructor(options: ClarkeHandlerOptions) {
    // Extract OpenAI-specific options from process.env-style spread
    const openaiOptions: any = {};
    
    if (options.apiKey || options.OPENAI_API_KEY) {
      openaiOptions.apiKey = options.apiKey || options.OPENAI_API_KEY;
    }
    if (options.baseURL || options.OPENAI_BASE_URL) {
      openaiOptions.baseURL = options.baseURL || options.OPENAI_BASE_URL;
    }
    if (options.organization || options.OPENAI_ORGANIZATION) {
      openaiOptions.organization = options.organization || options.OPENAI_ORGANIZATION;
    }
    if (options.project || options.OPENAI_PROJECT) {
      openaiOptions.project = options.project || options.OPENAI_PROJECT;
    }

    this.openaiClient = new OpenAI(openaiOptions);
    
    console.log('ClarkeHandler initialized', { 
      hasApiKey: !!openaiOptions.apiKey,
      baseURL: openaiOptions.baseURL || 'default'
    });
  }

  /**
   * Initialize resilience configuration
   * Note: Method name kept as 'initialzeResilience' to match problem statement
   */
  initialzeResilience(options: ResilienceOptions): void {
    this.resilienceConfig = {
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
      timeoutMs: 60000,
      ...options
    };
    
    this.initialized = true;
    
    console.log('Resilience configuration initialized', {
      retries: this.resilienceConfig.retries,
      backoffMultiplier: this.resilienceConfig.backoffMultiplier,
      maxBackoffMs: this.resilienceConfig.maxBackoffMs
    });
  }

  /**
   * Configure fallback handler
   */
  fallbackTo(fallbackHandler: any): void {
    this.fallbackHandler = fallbackHandler;
    console.log('Fallback handler configured');
  }

  /**
   * Enhanced chat completion with resilience and fallback
   */
  async chat(messages: any[], options: any = {}): Promise<any> {
    if (!this.initialized) {
      console.log('ClarkeHandler used without resilience initialization');
    }

    const maxRetries = this.resilienceConfig?.retries || 3;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.openaiClient.chat.completions.create({
          messages,
          model: options.model || 'gpt-4',
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens,
          response_format: options.responseFormat,
          ...options
        });

        const content = response.choices[0]?.message?.content || '';
        
        return {
          success: true,
          content,
          usage: response.usage,
          response
        };

      } catch (error: any) {
        lastError = error;
        
        console.log(`ClarkeHandler attempt ${attempt + 1}/${maxRetries + 1} failed`, {
          error: error.message,
          code: error.code
        });

        // Don't retry on certain errors
        if (error.code === 'invalid_api_key' || error.code === 'insufficient_quota') {
          break;
        }

        // Apply backoff delay if not the last attempt
        if (attempt < maxRetries) {
          const delay = this.calculateBackoffDelay(attempt);
          console.log(`Backing off for ${delay}ms before retry`);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed, try fallback
    if (this.fallbackHandler) {
      try {
        console.log('Attempting fallback recovery');
        const fallbackResult = await this.fallbackHandler.handle(lastError, {
          messages,
          options,
          task: 'chat_completion'
        });
        
        return {
          success: true,
          content: fallbackResult,
          fallback: true,
          error: lastError.message
        };
      } catch (fallbackError) {
        console.error('Fallback handler failed', { error: fallbackError });
      }
    }

    // Final failure
    console.error('ClarkeHandler exhausted all options', { 
      error: lastError.message,
      attempts: maxRetries + 1
    });

    return {
      success: false,
      error: lastError.message,
      attempts: maxRetries + 1
    };
  }

  private calculateBackoffDelay(attempt: number): number {
    if (!this.resilienceConfig) return 1000;
    
    const baseDelay = 1000;
    const multiplier = this.resilienceConfig.backoffMultiplier || 2;
    const maxDelay = this.resilienceConfig.maxBackoffMs || 30000;
    
    const delay = baseDelay * Math.pow(multiplier, attempt);
    return Math.min(delay, maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if handler is properly initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get current resilience configuration
   */
  getResilienceConfig(): ResilienceOptions | undefined {
    return this.resilienceConfig;
  }

  /**
   * Access to underlying OpenAI client for advanced usage
   */
  get client(): OpenAI {
    return this.openaiClient;
  }
}

// Module augmentation to add ClarkeHandler to OpenAI namespace
declare module 'openai' {
  namespace OpenAI {
    export const ClarkeHandler: typeof import('./clarke-handler.js').ClarkeHandler;
  }
}

// Attach ClarkeHandler to OpenAI namespace
(OpenAI as any).ClarkeHandler = ClarkeHandler;

// Export for direct usage
export { ClarkeHandler as default };