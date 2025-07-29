/**
 * @deprecated Use UnifiedOpenAIService instead. This service is maintained for backward compatibility.
 * Will be removed in a future version.
 */

import { getUnifiedOpenAI, type ChatMessage as UnifiedChatMessage, type ChatResponse as UnifiedChatResponse } from './unified-openai';
import { createServiceLogger } from '../utils/logger';
import { aiConfig } from '../config';
import type { IdentityOverride } from '../types/IdentityOverride';

const logger = createServiceLogger('OpenAIService-DEPRECATED');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  message: string;
  model: string;
  error?: string;
  fallbackRequested?: boolean;
}

export interface OpenAIServiceOptions {
  apiKey?: string;
  model?: string;
  identityOverride?: string | IdentityOverride;
  identityTriggerPhrase?: string;
}

/**
 * @deprecated Legacy OpenAI service - Use UnifiedOpenAIService for new code
 */
export class OpenAIService {
  private unifiedService: ReturnType<typeof getUnifiedOpenAI>;
  private model: string;
  private identityOverride?: string | IdentityOverride;
  private identityTriggerPhrase?: string;

  constructor(options?: OpenAIServiceOptions) {
    logger.info('OpenAIService is deprecated. Please use UnifiedOpenAIService for new implementations.');
    
    // Initialize unified service
    this.unifiedService = getUnifiedOpenAI({
      apiKey: options?.apiKey || aiConfig.openaiApiKey || process.env.OPENAI_API_KEY,
      model: options?.model || aiConfig.fineTunedModel || process.env.AI_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID',
      timeout: 30000,
      maxRetries: 3,
    });

    this.model = this.unifiedService.getModel();

    // Optional identity override injected as system message for all chats
    const override = options?.identityOverride || aiConfig.identityOverride || process.env.IDENTITY_OVERRIDE;
    if (typeof override === 'string') {
      try {
        this.identityOverride = JSON.parse(override) as IdentityOverride;
      } catch {
        this.identityOverride = override;
      }
    } else {
      this.identityOverride = override;
    }
    this.identityTriggerPhrase = options?.identityTriggerPhrase || aiConfig.identityTriggerPhrase || process.env.IDENTITY_TRIGGER_PHRASE || 'I am Skynet';
    
    // Log model configuration for audit purposes
    logger.info('Legacy OpenAI Service initialized (using UnifiedOpenAIService)', { 
      model: this.model,
      timeout: 30000,
      maxRetries: 3,
      apiKeySource: options?.apiKey ? 'options' : (aiConfig.openaiApiKey ? 'config' : 'environment')
    });
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const startTime = Date.now();

    const finalMessages = [...messages];
    if (this.identityTriggerPhrase) {
      const phrase = this.identityTriggerPhrase;
      const triggerIndex = finalMessages.findIndex(
        m => m.role === 'user' && m.content.includes(phrase)
      );
      if (triggerIndex !== -1) {
        if (!this.identityOverride) {
          const raw = aiConfig.identityOverride || process.env.IDENTITY_OVERRIDE;
          if (typeof raw === 'string') {
            try {
              this.identityOverride = JSON.parse(raw) as IdentityOverride;
            } catch {
              this.identityOverride = raw;
            }
          } else {
            this.identityOverride = raw;
          }
        }
        finalMessages[triggerIndex].content = finalMessages[triggerIndex].content.replace(phrase, '').trim();
      }
    }
    if (this.identityOverride) {
      const overrideContent = typeof this.identityOverride === 'string'
        ? this.identityOverride
        : JSON.stringify(this.identityOverride);
      finalMessages.unshift({ role: 'system', content: overrideContent });
    }
    
    // Log AI interaction start
    logger.info('AI interaction started', {
      timestamp: new Date().toISOString(),
      taskType: 'chat',
      model: this.model,
      messageCount: finalMessages.length
    });
    
    try {
      // Convert to unified format and call unified service
      const unifiedMessages: UnifiedChatMessage[] = finalMessages.map(msg => ({
        role: msg.role as any,
        content: msg.content,
      }));

      const response = await this.unifiedService.chat(unifiedMessages, {
        model: this.model,
        maxTokens: 1000,
        temperature: 0.7,
      });

      const endTime = Date.now();

      if (response.success) {
        // Log successful completion
        logger.info('AI interaction completed', {
          timestamp: new Date().toISOString(),
          taskType: 'chat',
          completionStatus: 'success',
          model: response.model,
          responseLength: response.content.length,
          completionTimeMs: endTime - startTime,
          usage: response.usage
        });
        
        return {
          message: response.content,
          model: response.model,
        };
      } else {
        throw new Error(response.error || 'Unified service returned failure');
      }
      
    } catch (error: any) {
      const endTime = Date.now();
      
      // Log failed completion  
      logger.error('AI interaction failed', {
        timestamp: new Date().toISOString(),
        taskType: 'chat',
        completionStatus: 'error',
        model: this.model,
        completionTimeMs: endTime - startTime,
        error: error.message,
        errorType: error.name,
        status: error.status,
        code: error.code
      });
      
      return {
        message: 'OpenAI service temporarily unavailable',
        model: this.model,
        error: error.message,
      };
    }
  }

  getModel(): string {
    return this.model;
  }
}
