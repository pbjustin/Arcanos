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

    this.finetuneModel = process.env.FINE_TUNED_MODEL || this.fallbackModel;
    
    if (!process.env.FINE_TUNED_MODEL) {
      console.warn('⚠️ FINE_TUNED_MODEL not set, using fallback model:', this.fallbackModel);
    }
  }

  async chat(messages: ChatMessage[], allowFallback: boolean = false): Promise<ChatResponse> {
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

      // NEVER automatically fall back - always request permission first
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