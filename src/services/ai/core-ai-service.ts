/**
 * Core AI Service - Standardized OpenAI SDK interface with retry logic and comprehensive logging
 * Replaces all manual HTTP requests to OpenAI with openai.chat.completions.create() calls
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createServiceLogger } from '../../utils/logger';

const logger = createServiceLogger('CoreAIService');

export interface AIInteractionLog {
  timestamp: string;
  taskType: string;
  completionStatus: 'success' | 'error' | 'retry' | 'fallback';
  model?: string;
  promptLength?: number;
  responseLength?: number;
  completionTimeMs?: number;
  error?: string;
  attemptNumber?: number;
}

export interface AIServiceConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface AIResponse {
  success: boolean;
  content: string;
  model: string;
  usage?: any;
  error?: string;
  stream?: boolean;
}

export class CoreAIService {
  private client: OpenAI;
  private defaultModel: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000,
      maxRetries: 2,
    });

    // Use configured fine-tuned model or fallback ID
    this.defaultModel = process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v3:ByCSivqD';
    this.maxRetries = 3;
    this.retryDelayMs = 1000;

    logger.info('Core AI Service initialized', { 
      model: this.defaultModel,
      maxRetries: this.maxRetries 
    });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private logInteraction(log: AIInteractionLog): void {
    logger.info('AI interaction logged', log);
    
    // Store in a more structured way for potential future analytics
    if (process.env.NODE_ENV === 'development') {
      console.log(`[AI-LOG] ${JSON.stringify(log)}`);
    }
  }

  /**
   * Core method for AI completions with retry logic and comprehensive logging
   */
  async complete(
    messages: ChatCompletionMessageParam[],
    taskType: string,
    config: AIServiceConfig = {}
  ): Promise<AIResponse> {
    const startTime = Date.now();
    const {
      model = this.defaultModel,
      maxTokens = 1000,
      temperature = 0.7,
      stream = false,
      maxRetries = this.maxRetries,
      retryDelayMs = this.retryDelayMs
    } = config;

    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Log attempt start
        this.logInteraction({
          timestamp: new Date().toISOString(),
          taskType,
          completionStatus: attempt > 1 ? 'retry' : 'success',
          model,
          promptLength: JSON.stringify(messages).length,
          attemptNumber: attempt
        });

        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: false,
        }) as OpenAI.Chat.Completions.ChatCompletion;

        const completionTime = Date.now() - startTime;
        const content = completion.choices?.[0]?.message?.content || '';

        // Log successful completion
        this.logInteraction({
          timestamp: new Date().toISOString(),
          taskType,
          completionStatus: 'success',
          model,
          promptLength: JSON.stringify(messages).length,
          responseLength: content.length,
          completionTimeMs: completionTime,
          attemptNumber: attempt
        });

        return {
          success: true,
          content,
          model,
          usage: completion.usage,
          stream: false
        };

      } catch (error: any) {
        lastError = error;
        const completionTime = Date.now() - startTime;

        // Log failed attempt
        this.logInteraction({
          timestamp: new Date().toISOString(),
          taskType,
          completionStatus: attempt < maxRetries ? 'retry' : 'error',
          model,
          promptLength: JSON.stringify(messages).length,
          completionTimeMs: completionTime,
          error: error.message,
          attemptNumber: attempt
        });

        logger.error(`Attempt ${attempt} failed for ${taskType}`, error, {
          model,
          attempt: `${attempt}/${maxRetries}`
        });

        if (attempt < maxRetries) {
          await this.delay(retryDelayMs * attempt); // Exponential backoff
        }
      }
    }

    // All retries failed - return fallback response
    this.logInteraction({
      timestamp: new Date().toISOString(),
      taskType,
      completionStatus: 'fallback',
      model,
      error: lastError?.message || 'All retry attempts failed'
    });

    return {
      success: false,
      content: `AI service temporarily unavailable. Error: ${lastError?.message || 'Unknown error'}`,
      model,
      error: lastError?.message
    };
  }

  /**
   * Streaming completion with retry logic
   */
  async completeStream(
    messages: ChatCompletionMessageParam[],
    taskType: string,
    onToken: (token: string) => void,
    config: AIServiceConfig = {}
  ): Promise<AIResponse> {
    const startTime = Date.now();
    const {
      model = this.defaultModel,
      maxTokens = 1000,
      temperature = 0.7,
      maxRetries = this.maxRetries,
      retryDelayMs = this.retryDelayMs
    } = config;

    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Log stream attempt start
        this.logInteraction({
          timestamp: new Date().toISOString(),
          taskType: `${taskType}-stream`,
          completionStatus: attempt > 1 ? 'retry' : 'success',
          model,
          promptLength: JSON.stringify(messages).length,
          attemptNumber: attempt
        });

        const stream = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: true
        });

        let fullContent = '';
        for await (const chunk of stream) {
          const token = chunk.choices?.[0]?.delta?.content || '';
          if (token) {
            fullContent += token;
            onToken(token);
          }
        }

        const completionTime = Date.now() - startTime;

        // Log successful stream completion
        this.logInteraction({
          timestamp: new Date().toISOString(),
          taskType: `${taskType}-stream`,
          completionStatus: 'success',
          model,
          promptLength: JSON.stringify(messages).length,
          responseLength: fullContent.length,
          completionTimeMs: completionTime,
          attemptNumber: attempt
        });

        return {
          success: true,
          content: fullContent,
          model,
          stream: true
        };

      } catch (error: any) {
        lastError = error;
        const completionTime = Date.now() - startTime;

        // Log failed stream attempt
        this.logInteraction({
          timestamp: new Date().toISOString(),
          taskType: `${taskType}-stream`,
          completionStatus: attempt < maxRetries ? 'retry' : 'error',
          model,
          promptLength: JSON.stringify(messages).length,
          completionTimeMs: completionTime,
          error: error.message,
          attemptNumber: attempt
        });

        logger.error(`Stream attempt ${attempt} failed for ${taskType}`, error, {
          model,
          attempt: `${attempt}/${maxRetries}`
        });

        if (attempt < maxRetries) {
          await this.delay(retryDelayMs * attempt);
        }
      }
    }

    // Stream fallback
    this.logInteraction({
      timestamp: new Date().toISOString(),
      taskType: `${taskType}-stream`,
      completionStatus: 'fallback',
      model,
      error: lastError?.message || 'All stream retry attempts failed'
    });

    return {
      success: false,
      content: `Streaming AI service temporarily unavailable. Error: ${lastError?.message || 'Unknown error'}`,
      model,
      error: lastError?.message,
      stream: true
    };
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.defaultModel;
  }
}

// Export singleton instance
export const coreAIService = new CoreAIService();