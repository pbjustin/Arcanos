import OpenAI from 'openai';

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

export class OpenAIService {
  private client: OpenAI;
  private finetuneModel: string;
  private fallbackModel: string = 'gpt-3.5-turbo';

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.finetuneModel = (process.env.OPENAI_FINE_TUNED_MODEL || '').trim();
    
    // Don't throw error on startup - let the service ask permission when needed
  }

  async chat(messages: ChatMessage[], allowFallback: boolean = false): Promise<ChatResponse> {
    // Check if fine-tuned model is configured
    if (!this.finetuneModel) {
      return {
        message: 'Fine-tuned model is not configured. Would you like to use the default model (gpt-3.5-turbo) instead?',
        model: 'none',
        error: 'OPENAI_FINE_TUNED_MODEL not configured',
        fallbackRequested: true,
      };
    }

    try {
      // First attempt with fine-tuned model
      const response = await this.client.chat.completions.create({
        model: this.finetuneModel,
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
      });

      if (response.choices && response.choices.length > 0) {
        return {
          message: response.choices[0].message?.content || 'No response',
          model: this.finetuneModel,
        };
      }

      throw new Error('No response from OpenAI');
    } catch (error: any) {
      console.error('Fine-tuned model error:', error.message);

      // Ask for permission to use fallback model
      return {
        message: 'Fine-tuned model is not available. Would you like to use the default model instead?',
        model: this.finetuneModel,
        error: error.message,
        fallbackRequested: true,
      };
    }
  }

  /**
   * Use fallback model after explicit permission is granted
   */
  async chatWithFallback(messages: ChatMessage[]): Promise<ChatResponse> {
    try {
      console.log(`Using fallback model ${this.fallbackModel} with explicit permission`);
      
      const fallbackResponse = await this.client.chat.completions.create({
        model: this.fallbackModel,
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
      });

      if (fallbackResponse.choices && fallbackResponse.choices.length > 0) {
        return {
          message: fallbackResponse.choices[0].message?.content || 'No response',
          model: this.fallbackModel,
          error: 'Using fallback model with explicit permission',
        };
      }

      throw new Error('No response from fallback model');
    } catch (fallbackError: any) {
      return {
        message: 'Fallback model failed',
        model: 'none',
        error: `Fallback model error: ${fallbackError.message}`,
      };
    }
  }

  getFinetuneModel(): string {
    return this.finetuneModel;
  }

  getFallbackModel(): string {
    return this.fallbackModel;
  }
}