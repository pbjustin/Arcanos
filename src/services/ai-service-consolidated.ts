/**
 * AI Service Consolidated - Single entry point for all AI operations
 * Replaces codexService.ts, code-interpreter.ts, and core-ai-service.ts
 * Uses the unified OpenAI service for all operations
 */

import { getUnifiedOpenAI, type ChatMessage, type ChatOptions, type CodeInterpreterResult } from './unified-openai';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('AIServiceConsolidated');
const openaiService = getUnifiedOpenAI();

/**
 * Legacy codex prompt runner - now uses unified service
 * @deprecated Use openaiService.runPrompt directly
 */
export async function runCodexPrompt(prompt: string, model = 'gpt-4'): Promise<string> {
  try {
    return await openaiService.runPrompt(prompt, model, 0.2);
  } catch (error: any) {
    logger.error('Codex prompt failed:', error.message);
    return '❌ Codex request failed.';
  }
}

/**
 * Code interpreter service - now uses unified service
 */
export class CodeInterpreterService {
  private model: string;

  constructor() {
    this.model = process.env.CODE_INTERPRETER_MODEL || 'gpt-4';
  }

  async run(prompt: string): Promise<CodeInterpreterResult> {
    return await openaiService.runCodeInterpreter(prompt, this.model);
  }
}

/**
 * Core AI completion with retry logic and logging
 */
export interface AIResponse {
  success: boolean;
  content: string;
  model: string;
  usage?: any;
  error?: string;
}

export interface AIServiceConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  maxRetries?: number;
  stream?: boolean;
}

export class CoreAIService {
  private defaultModel: string;

  constructor() {
    this.defaultModel = process.env.AI_MODEL || 'gpt-4-turbo';
    logger.info('Core AI Service initialized with unified backend', { 
      model: this.defaultModel 
    });
  }

  /**
   * Core completion method using unified service
   */
  async complete(
    messages: ChatMessage[],
    taskType: string,
    config: AIServiceConfig = {}
  ): Promise<AIResponse> {
    const startTime = Date.now();
    
    try {
      const response = await openaiService.chat(messages, {
        model: config.model || this.defaultModel,
        maxTokens: config.maxTokens || 1000,
        temperature: config.temperature || 0.7,
      });

      const completionTime = Date.now() - startTime;

      logger.info('AI completion successful', {
        taskType,
        model: response.model,
        completionTime,
        success: response.success,
      });

      return {
        success: response.success,
        content: response.content,
        model: response.model,
        usage: response.usage,
        error: response.error,
      };

    } catch (error: any) {
      const completionTime = Date.now() - startTime;
      
      logger.error('AI completion failed', {
        taskType,
        error: error.message,
        completionTime,
      });

      return {
        success: false,
        content: `AI service error: ${error.message}`,
        model: config.model || this.defaultModel,
        error: error.message,
      };
    }
  }

  /**
   * Streaming completion method using unified service
   */
  async completeStream(
    messages: ChatMessage[],
    taskType: string,
    onToken: (token: string) => void,
    config: AIServiceConfig = {}
  ): Promise<AIResponse> {
    const startTime = Date.now();
    
    try {
      const response = await openaiService.chatStream(
        messages,
        (chunk, isComplete) => {
          if (!isComplete && chunk) {
            onToken(chunk);
          }
        },
        {
          model: config.model || this.defaultModel,
          maxTokens: config.maxTokens || 1000,
          temperature: config.temperature || 0.7,
        }
      );

      const completionTime = Date.now() - startTime;

      logger.info('AI stream completion successful', {
        taskType,
        model: response.model,
        completionTime,
        success: response.success,
      });

      return {
        success: response.success,
        content: response.content,
        model: response.model,
        usage: response.usage,
        error: response.error,
      };

    } catch (error: any) {
      const completionTime = Date.now() - startTime;
      
      logger.error('AI stream completion failed', {
        taskType,
        error: error.message,
        completionTime,
      });

      return {
        success: false,
        content: `AI stream service error: ${error.message}`,
        model: config.model || this.defaultModel,
        error: error.message,
      };
    }
  }

  getModel(): string {
    return this.defaultModel;
  }
}

// Export singleton instances for backward compatibility
export const codeInterpreterService = new CodeInterpreterService();
export const coreAIService = new CoreAIService();

// Export the unified service for new implementations
export { openaiService as unifiedAIService };

// Export types
export type { CodeInterpreterResult } from './unified-openai';