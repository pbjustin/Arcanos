// Optimized AI Dispatcher - Enhanced for refactored worker system compatibility
// Uses optimized scheduling format and modular fallback dispatch

import { getUnifiedOpenAI, type ChatMessage } from './unified-openai';
import { aiConfig } from '../config';
import { OptimizedScheduleFormat } from './ai-worker-refactor';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('OptimizedAIDispatcher');

// Enhanced dispatch request format
export interface EnhancedDispatchRequest {
  type: 'api' | 'internal' | 'worker' | 'cron' | 'memory' | 'audit';
  endpoint?: string;
  method?: string;
  payload: any;
  context?: {
    userId?: string;
    sessionId?: string;
    headers?: Record<string, string>;
  };
  schedule?: Partial<OptimizedScheduleFormat>;
}

// Optimized dispatch instruction format
export interface OptimizedDispatchInstruction {
  action: 'execute' | 'respond' | 'schedule' | 'delegate' | 'fallback';
  service?: string;
  parameters?: Record<string, any>;
  response?: string;
  execute?: boolean;
  worker?: string;
  schedule?: OptimizedScheduleFormat;
  priority?: number;
  retryPolicy?: {
    maxAttempts: number;
    backoffMs: number;
    exponential: boolean;
  };
  timeout?: number;
}

export interface OptimizedDispatchResponse {
  success: boolean;
  instructions: OptimizedDispatchInstruction[];
  directResponse?: string;
  error?: string;
  metadata?: {
    processingTime?: number;
    model?: string;
    fallbackUsed?: boolean;
  };
}

export class OptimizedAIDispatcher {
  private unifiedOpenAI: ReturnType<typeof getUnifiedOpenAI> | null;
  private model: string;
  private dispatchLocks: Map<string, boolean> = new Map();

  constructor() {
    this.model = process.env.AI_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID';
    
    try {
      this.unifiedOpenAI = getUnifiedOpenAI({
        model: this.model,
      });
      logger.info('Optimized AI Dispatcher initialized', { model: this.model });
    } catch (error) {
      logger.warning('Optimized AI Dispatcher initialized without OpenAI (testing mode):', error);
      this.unifiedOpenAI = null;
    }
  }

  /**
   * Enhanced dispatch method with optimized scheduling and unified fallback
   */
  async dispatch(request: EnhancedDispatchRequest): Promise<OptimizedDispatchResponse> {
    const startTime = Date.now();
    
    logger.info('Optimized AI Dispatcher processing request', {
      type: request.type,
      endpoint: request.endpoint,
      method: request.method,
      hasSchedule: !!request.schedule
    });

    // Enhanced debounce logic with exponential backoff
    const lockKey = this.generateLockKey(request);
    if (lockKey && this.dispatchLocks.get(lockKey)) {
      logger.info(`Dispatch already in progress for: ${lockKey}`);
      return {
        success: false,
        instructions: [],
        error: 'dispatch_in_progress',
        metadata: { processingTime: Date.now() - startTime }
      };
    }

    if (lockKey) {
      this.dispatchLocks.set(lockKey, true);
    }

    try {
      // Use mock response if OpenAI not available
      if (!this.unifiedOpenAI) {
        const mockResponse = this.createOptimizedMockResponse(request);
        return {
          ...mockResponse,
          metadata: {
            processingTime: Date.now() - startTime,
            fallbackUsed: true
          }
        };
      }

      // Create enhanced system prompt with scheduling awareness
      const systemPrompt = this.createOptimizedSystemPrompt();
      const userPrompt = this.createOptimizedRequestPrompt(request);

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      logger.info('Sending request to optimized AI model');
      const response = await this.unifiedOpenAI.chat(messages);

      if (!response.success) {
        logger.error('Optimized AI model error:', response.error);
        return {
          success: false,
          instructions: [],
          error: response.error,
          metadata: { processingTime: Date.now() - startTime }
        };
      }

      // Parse response with enhanced instruction format
      const instructions = this.parseOptimizedModelResponse(response.content, request);
      
      const result: OptimizedDispatchResponse = {
        success: true,
        instructions,
        directResponse: this.extractDirectResponse(response.content),
        metadata: {
          processingTime: Date.now() - startTime,
          model: this.model,
          fallbackUsed: false
        }
      };

      logger.info('Optimized dispatch completed successfully');
      return result;

    } catch (error: any) {
      logger.error('Optimized AI Dispatcher error:', error);
      return {
        success: false,
        instructions: [],
        error: error.message,
        metadata: { processingTime: Date.now() - startTime }
      };
    } finally {
      if (lockKey) {
        // Clear lock after delay to prevent rapid re-dispatch
        setTimeout(() => this.dispatchLocks.delete(lockKey), 1000);
      }
    }
  }

  /**
   * Generate a unique lock key for dispatch deduplication
   */
  private generateLockKey(request: EnhancedDispatchRequest): string | null {
    if (request.type === 'worker' && request.payload?.worker) {
      return `worker:${request.payload.worker}`;
    }
    if (request.type === 'cron' && request.payload?.trigger) {
      return `cron:${request.payload.trigger}`;
    }
    return null;
  }

  /**
   * Enhanced system prompt with optimized scheduling capabilities
   */
  private createOptimizedSystemPrompt(): string {
    return `You are ARCANOS v1.0.0, an AI system with enhanced operational control and optimized scheduling.

Your role is to analyze requests and provide structured instructions using the optimized format.

Respond with JSON-formatted instructions:
{
  "action": "execute|respond|schedule|delegate|fallback",
  "service": "memory|audit|write|diagnostic|worker|api",
  "parameters": {...},
  "response": "user-facing response if applicable",
  "execute": true/false,
  "worker": "worker name if delegating",
  "schedule": {
    "worker": "worker name",
    "type": "immediate|delayed|recurring|conditional",
    "priority": 1-10,
    "retryPolicy": {
      "maxAttempts": number,
      "backoffMs": number,
      "exponential": boolean
    },
    "timeout": number,
    "schedule": "cron expression for recurring",
    "delay": "milliseconds for delayed",
    "condition": "condition expression",
    "metadata": {}
  },
  "priority": 1-10,
  "retryPolicy": {
    "maxAttempts": number,
    "backoffMs": number,
    "exponential": boolean
  },
  "timeout": number
}

Enhanced scheduling types:
- immediate: Execute now with high priority
- delayed: Execute after specified delay
- recurring: Execute on cron schedule
- conditional: Execute when condition is met

Optimized fallback strategies:
- Use "fallback" action for graceful degradation
- Include retry policies for resilient execution
- Set appropriate timeouts for different operation types

Always optimize for performance, reliability, and graceful degradation.`;
  }

  /**
   * Create optimized request prompt with scheduling context
   */
  private createOptimizedRequestPrompt(request: EnhancedDispatchRequest): string {
    const context = request.context || {};
    
    let prompt = `OPTIMIZED REQUEST ANALYSIS:
Type: ${request.type}
Endpoint: ${request.endpoint || 'N/A'}
Method: ${request.method || 'N/A'}
User ID: ${context.userId || 'anonymous'}
Session ID: ${context.sessionId || 'default'}

PAYLOAD:
${JSON.stringify(request.payload, null, 2)}`;

    if (request.schedule) {
      prompt += `\n\nSCHEDULING CONTEXT:
${JSON.stringify(request.schedule, null, 2)}`;
    }

    prompt += `\n\nHEADERS:
${JSON.stringify(context.headers || {}, null, 2)}

Please analyze this request and provide optimized instructions with enhanced scheduling support.`;

    return prompt;
  }

  /**
   * Parse model response into optimized instruction format
   */
  private parseOptimizedModelResponse(
    response: string, 
    request: EnhancedDispatchRequest
  ): OptimizedDispatchInstruction[] {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return [{
          action: 'respond',
          service: 'api',
          response: response,
          execute: true,
          priority: 5,
          retryPolicy: { maxAttempts: 1, backoffMs: 1000, exponential: false },
          timeout: 30000
        }];
      }

      const jsonStr = jsonMatch[0];
      let parsed;
      
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseError) {
        return [{
          action: 'respond',
          service: 'api',
          response: response,
          execute: true,
          priority: 5,
          retryPolicy: { maxAttempts: 1, backoffMs: 1000, exponential: false },
          timeout: 30000
        }];
      }

      let instructions: OptimizedDispatchInstruction[] = Array.isArray(parsed) ? parsed : [parsed];

      // Enhance instructions with defaults and validation
      instructions = instructions.map(instr => ({
        ...instr,
        priority: instr.priority || 5,
        retryPolicy: instr.retryPolicy || { maxAttempts: 3, backoffMs: 1000, exponential: true },
        timeout: instr.timeout || 30000
      }));

      // Filter out invalid schedule instructions
      instructions = instructions.filter(instr => {
        if (instr.action === 'schedule') {
          if (!instr.schedule?.worker) {
            logger.warning('Dropping schedule instruction without worker', instr);
            return false;
          }
          if (instr.schedule.type === 'recurring' && !instr.schedule.schedule) {
            logger.warning('Dropping recurring schedule instruction without cron expression', instr);
            return false;
          }
        }
        return true;
      });

      return instructions;

    } catch (error) {
      logger.warning('Failed to parse optimized model response, using fallback:', error);
      return [{
        action: 'fallback',
        service: 'api',
        response: response,
        execute: true,
        priority: 1,
        retryPolicy: { maxAttempts: 1, backoffMs: 1000, exponential: false },
        timeout: 30000
      }];
    }
  }

  /**
   * Extract direct response from model output
   */
  private extractDirectResponse(response: string): string | undefined {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const beforeJson = response.substring(0, jsonMatch.index).trim();
      return beforeJson || undefined;
    }
    return response;
  }

  /**
   * Create optimized mock response for testing
   */
  private createOptimizedMockResponse(request: EnhancedDispatchRequest): OptimizedDispatchResponse {
    logger.info('Creating optimized mock AI response');
    
    let mockInstructions: OptimizedDispatchInstruction[] = [];
    let mockResponse = '';

    if (request.type === 'api' && request.payload?.message) {
      mockResponse = `Optimized AI Mock: Processed message "${request.payload.message}" with enhanced scheduling and fallback support.`;
      mockInstructions = [{
        action: 'respond',
        service: 'api',
        response: mockResponse,
        execute: true,
        priority: 5,
        retryPolicy: { maxAttempts: 3, backoffMs: 1000, exponential: true },
        timeout: 30000
      }];
    } else if (request.schedule) {
      mockResponse = `Optimized AI Mock: Scheduled operation configured with type: ${request.schedule.type}`;
      mockInstructions = [{
        action: 'schedule',
        service: 'worker',
        worker: request.schedule.worker || 'defaultWorker',
        schedule: {
          worker: request.schedule.worker || 'defaultWorker',
          type: request.schedule.type || 'immediate',
          priority: request.schedule.priority || 5,
          retryPolicy: request.schedule.retryPolicy || { maxAttempts: 3, backoffMs: 1000, exponential: true },
          timeout: request.schedule.timeout || 30000,
          metadata: { mock: true, ...request.schedule.metadata }
        },
        execute: true,
        priority: request.schedule.priority || 5,
        retryPolicy: { maxAttempts: 3, backoffMs: 1000, exponential: true },
        timeout: 30000
      }];
    } else {
      mockResponse = `Optimized AI Mock: Request processed with enhanced capabilities. Type: ${request.type}`;
      mockInstructions = [{
        action: 'respond',
        service: 'api',
        response: mockResponse,
        execute: true,
        priority: 5,
        retryPolicy: { maxAttempts: 3, backoffMs: 1000, exponential: true },
        timeout: 30000
      }];
    }

    return {
      success: true,
      instructions: mockInstructions,
      directResponse: mockResponse
    };
  }

  /**
   * Quick optimized AI query method
   */
  async askOptimized(query: string, options?: { priority?: number; timeout?: number }): Promise<string> {
    const request: EnhancedDispatchRequest = {
      type: 'api',
      payload: { message: query },
      context: { userId: 'system', sessionId: 'direct-query' }
    };

    const response = await this.dispatch(request);
    
    if (response.error) {
      return `Optimized AI Error: ${response.error}`;
    }

    return response.directResponse || response.instructions[0]?.response || 'No response available';
  }
}

// Export singleton instance
export const optimizedAIDispatcher = new OptimizedAIDispatcher();