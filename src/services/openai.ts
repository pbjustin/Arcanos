import OpenAI from 'openai';
import { createServiceLogger } from '../utils/logger';
import { aiConfig } from '../config';
import type { IdentityOverride } from '../../types/IdentityOverride';

const logger = createServiceLogger('OpenAIService');

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

export class OpenAIService {
  private client: OpenAI;
  private model: string;
  private identityOverride?: string | IdentityOverride;
  private identityTriggerPhrase?: string;

  constructor(options?: OpenAIServiceOptions) {
    // Get API key from options, config, or environment variable
    const apiKey = options?.apiKey || aiConfig.openaiApiKey || process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      throw new Error('The OPENAI_API_KEY environment variable is missing or empty; either provide it, or instantiate the OpenAI client with an apiKey option, like new OpenAI({ apiKey: \'My API Key\' }).');
    }

    this.client = new OpenAI({
      apiKey: apiKey,
      timeout: 30000, // 30 seconds timeout
      maxRetries: 3,  // Increased from 2 for better reliability
    });

    // Use configured fine-tuned model or fallback to predefined ID
    this.model = options?.model || aiConfig.fineTunedModel || process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106:BpYtP0ox';

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
    logger.info('OpenAI Service initialized', { 
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
      // Use the configured AI model
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: finalMessages,
        max_tokens: 1000,
        temperature: 0.7,
      });

      const endTime = Date.now();
      
      if (completion.choices && completion.choices.length > 0) {
        const responseMessage = completion.choices[0].message?.content || 'No response';
        
        // Log successful completion
        logger.info('AI interaction completed', {
          timestamp: new Date().toISOString(),
          taskType: 'chat',
          completionStatus: 'success',
          model: this.model,
          responseLength: responseMessage.length,
          completionTimeMs: endTime - startTime,
          usage: completion.usage
        });
        
        return {
          message: responseMessage,
          model: this.model,
        };
      }

      throw new Error('No response from OpenAI');
      
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
