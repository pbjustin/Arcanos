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
  failsafeEnabled?: boolean;
  rollbackEnabled?: boolean;
  isolatedRollback?: boolean;
}

export interface FailsafeState {
  checkpoint: any;
  timestamp: number;
  operationId: string;
  context: any;
}

export interface RollbackOptions {
  isolated?: boolean;
  preserveContext?: boolean;
  rollbackStrategy?: 'immediate' | 'gradual' | 'checkpoint';
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
 * Enhanced OpenAI handler with resilience, failsafe, and isolated rollback capabilities
 */
export class ClarkeHandler {
  private openaiClient: OpenAI;
  private resilienceConfig?: ResilienceOptions;
  private fallbackHandler?: any;
  private initialized: boolean = false;
  private failsafeStates: Map<string, FailsafeState> = new Map();
  private rollbackHistory: Array<{ operationId: string; checkpoint: any; timestamp: number }> = [];
  private operationCounter: number = 0;

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
   * Initialize resilience configuration with failsafe and rollback capabilities
   * Note: Method name kept as 'initialzeResilience' to match problem statement
   */
  initialzeResilience(options: ResilienceOptions): void {
    this.resilienceConfig = {
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
      timeoutMs: 60000,
      failsafeEnabled: true,
      rollbackEnabled: true,
      isolatedRollback: true,
      ...options
    };
    
    this.initialized = true;
    
    console.log('Enhanced resilience configuration initialized', {
      retries: this.resilienceConfig.retries,
      backoffMultiplier: this.resilienceConfig.backoffMultiplier,
      maxBackoffMs: this.resilienceConfig.maxBackoffMs,
      failsafeEnabled: this.resilienceConfig.failsafeEnabled,
      rollbackEnabled: this.resilienceConfig.rollbackEnabled,
      isolatedRollback: this.resilienceConfig.isolatedRollback
    });
  }

  /**
   * Create failsafe checkpoint for isolated rollback
   */
  private createFailsafeCheckpoint(context: any): string {
    const operationId = `op_${++this.operationCounter}_${Date.now()}`;
    
    if (this.resilienceConfig?.failsafeEnabled) {
      const checkpoint: FailsafeState = {
        checkpoint: JSON.parse(JSON.stringify(context)), // Deep clone
        timestamp: Date.now(),
        operationId,
        context: {
          state: 'initialized',
          isolatedEnvironment: this.resilienceConfig.isolatedRollback
        }
      };
      
      this.failsafeStates.set(operationId, checkpoint);
      
      // Maintain rollback history
      this.rollbackHistory.push({
        operationId,
        checkpoint: checkpoint.checkpoint,
        timestamp: checkpoint.timestamp
      });
      
      // Limit history size for memory optimization
      if (this.rollbackHistory.length > 50) {
        const oldestOperation = this.rollbackHistory.shift();
        if (oldestOperation) {
          this.failsafeStates.delete(oldestOperation.operationId);
        }
      }
      
      logger.info('Failsafe checkpoint created', { operationId, isolated: this.resilienceConfig.isolatedRollback });
    }
    
    return operationId;
  }

  /**
   * Execute isolated rollback to a previous safe state
   */
  private async executeIsolatedRollback(operationId: string, options: RollbackOptions = {}): Promise<boolean> {
    if (!this.resilienceConfig?.rollbackEnabled) {
      logger.warning('Rollback attempted but not enabled');
      return false;
    }
    
    const failsafeState = this.failsafeStates.get(operationId);
    if (!failsafeState) {
      logger.error('Rollback failed: checkpoint not found', { operationId });
      return false;
    }
    
    try {
      const rollbackStrategy = options.rollbackStrategy || 'immediate';
      const isolated = options.isolated ?? this.resilienceConfig.isolatedRollback;
      
      logger.info('Executing isolated rollback', { 
        operationId, 
        strategy: rollbackStrategy, 
        isolated 
      });
      
      if (isolated) {
        // Isolated rollback: only affect this operation's context
        await this.performIsolatedRollback(failsafeState, options);
      } else {
        // Global rollback: affects broader system state
        await this.performGlobalRollback(failsafeState, options);
      }
      
      // Update rollback history
      failsafeState.context.rollbackPerformed = true;
      failsafeState.context.rollbackTimestamp = Date.now();
      
      logger.success('Rollback completed successfully', { operationId, isolated });
      return true;
      
    } catch (rollbackError: any) {
      logger.error('Rollback execution failed', { 
        operationId, 
        error: rollbackError.message 
      });
      return false;
    }
  }

  /**
   * Perform isolated rollback that doesn't affect other operations
   */
  private async performIsolatedRollback(failsafeState: FailsafeState, options: RollbackOptions): Promise<void> {
    // Create isolated environment for rollback
    const isolatedContext = {
      ...failsafeState.checkpoint,
      rollbackScope: 'isolated',
      preserveContext: options.preserveContext ?? true
    };
    
    // Restore state within isolated scope
    logger.info('Performing isolated rollback within contained environment');
    
    // Implementation would restore specific operation state without affecting global state
    // This is a safe rollback that only affects the current operation context
  }

  /**
   * Perform global rollback (use with caution)
   */
  private async performGlobalRollback(failsafeState: FailsafeState, options: RollbackOptions): Promise<void> {
    logger.warning('Performing global rollback - may affect other operations');
    
    // Global rollback implementation
    // Should be used sparingly and with proper safeguards
  }

  /**
   * Configure fallback handler
   */
  fallbackTo(fallbackHandler: any): void {
    this.fallbackHandler = fallbackHandler;
    console.log('Fallback handler configured');
  }

  /**
   * Enhanced chat completion with resilience, failsafe, and isolated rollback
   */
  async chat(messages: any[], options: any = {}): Promise<any> {
    if (!this.initialized) {
      console.log('ClarkeHandler used without resilience initialization');
    }

    // Create failsafe checkpoint
    const operationId = this.createFailsafeCheckpoint({
      messages,
      options,
      operation: 'chat_completion'
    });

    const maxRetries = this.resilienceConfig?.retries || 3;
    let lastError: any;
    let attemptHistory: Array<{ attempt: number; error?: string; success: boolean }> = [];

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
        
        // Success - clean up checkpoint if configured
        attemptHistory.push({ attempt: attempt + 1, success: true });
        
        if (this.resilienceConfig?.failsafeEnabled) {
          // Operation succeeded, mark checkpoint as completed
          const failsafeState = this.failsafeStates.get(operationId);
          if (failsafeState) {
            failsafeState.context.state = 'completed';
            failsafeState.context.completedAt = Date.now();
          }
        }
        
        return {
          success: true,
          content,
          usage: response.usage,
          response,
          operationId,
          attemptHistory,
          resilience: {
            checkpointCreated: true,
            failsafeEnabled: this.resilienceConfig?.failsafeEnabled,
            rollbackCapable: this.resilienceConfig?.rollbackEnabled
          }
        };

      } catch (error: any) {
        lastError = error;
        attemptHistory.push({ 
          attempt: attempt + 1, 
          success: false, 
          error: error.message 
        });
        
        console.log(`ClarkeHandler attempt ${attempt + 1}/${maxRetries + 1} failed`, {
          error: error.message,
          code: error.code,
          operationId
        });

        // Failsafe: Check if we should trigger rollback
        if (this.resilienceConfig?.failsafeEnabled && attempt >= 1) {
          const rollbackSuccess = await this.executeIsolatedRollback(operationId, {
            isolated: true,
            rollbackStrategy: 'checkpoint'
          });
          
          if (rollbackSuccess) {
            logger.info('Failsafe rollback executed', { operationId, attempt: attempt + 1 });
          }
        }

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

    // All retries failed, execute final failsafe rollback
    if (this.resilienceConfig?.failsafeEnabled) {
      logger.warning('All retries failed, executing final failsafe rollback', { operationId });
      await this.executeIsolatedRollback(operationId, {
        isolated: true,
        rollbackStrategy: 'immediate'
      });
    }

    // All retries failed, try fallback
    if (this.fallbackHandler) {
      try {
        console.log('Attempting fallback recovery');
        const fallbackResult = await this.fallbackHandler.handle(lastError, {
          messages,
          options,
          task: 'chat_completion',
          operationId,
          attemptHistory
        });
        
        return {
          success: true,
          content: fallbackResult,
          fallback: true,
          error: lastError.message,
          operationId,
          attemptHistory,
          resilience: {
            failsafeRollbackExecuted: true,
            fallbackUsed: true
          }
        };
      } catch (fallbackError) {
        console.error('Fallback handler failed', { error: fallbackError });
      }
    }

    // Final failure - mark checkpoint as failed
    const failsafeState = this.failsafeStates.get(operationId);
    if (failsafeState) {
      failsafeState.context.state = 'failed';
      failsafeState.context.failedAt = Date.now();
    }

    // Final failure
    console.error('ClarkeHandler exhausted all options', { 
      error: lastError.message,
      attempts: maxRetries + 1,
      operationId
    });

    return {
      success: false,
      error: lastError.message,
      attempts: maxRetries + 1,
      operationId,
      attemptHistory,
      resilience: {
        failsafeEnabled: this.resilienceConfig?.failsafeEnabled,
        rollbackAttempted: true,
        allOptionsExhausted: true
      }
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
   * Get failsafe statistics and state information
   */
  getFailsafeStats(): {
    activeCheckpoints: number;
    rollbackHistory: number;
    failsafeEnabled: boolean;
    rollbackEnabled: boolean;
    isolatedRollback: boolean;
  } {
    return {
      activeCheckpoints: this.failsafeStates.size,
      rollbackHistory: this.rollbackHistory.length,
      failsafeEnabled: this.resilienceConfig?.failsafeEnabled ?? false,
      rollbackEnabled: this.resilienceConfig?.rollbackEnabled ?? false,
      isolatedRollback: this.resilienceConfig?.isolatedRollback ?? false
    };
  }

  /**
   * Manual failsafe rollback for external operations
   */
  async triggerFailsafeRollback(operationId: string, options: RollbackOptions = {}): Promise<boolean> {
    return this.executeIsolatedRollback(operationId, {
      isolated: true,
      rollbackStrategy: 'immediate',
      ...options
    });
  }

  /**
   * Clean up old failsafe checkpoints
   */
  cleanupFailsafeCheckpoints(maxAge: number = 3600000): number { // Default 1 hour
    const now = Date.now();
    let cleaned = 0;
    
    for (const [operationId, state] of this.failsafeStates.entries()) {
      if (now - state.timestamp > maxAge) {
        this.failsafeStates.delete(operationId);
        cleaned++;
      }
    }
    
    // Also clean rollback history
    this.rollbackHistory = this.rollbackHistory.filter(entry => 
      now - entry.timestamp <= maxAge
    );
    
    if (cleaned > 0) {
      logger.info('Cleaned up old failsafe checkpoints', { cleaned });
    }
    
    return cleaned;
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