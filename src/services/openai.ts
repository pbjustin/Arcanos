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

    this.finetuneModel = process.env.FINE_TUNED_MODEL || '';
    
    if (!this.finetuneModel) {
      throw new Error('FINE_TUNED_MODEL is required');
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

      // If fine-tuned model fails and fallback is not allowed, request permission
      if (!allowFallback) {
        return {
          message: 'Fine-tuned model is not available. Would you like to use the default model instead?',
          model: this.finetuneModel,
          error: error.message,
          fallbackRequested: true,
        };
      }

      // Fallback to default model if allowed
      try {
        console.log(`Falling back to ${this.fallbackModel} due to fine-tuned model error`);
        
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
            error: `Fine-tuned model failed: ${error.message}. Used fallback.`,
          };
        }

        throw new Error('No response from fallback model');
      } catch (fallbackError: any) {
        return {
          message: 'Both fine-tuned and fallback models failed',
          model: 'none',
          error: `Fine-tuned: ${error.message}, Fallback: ${fallbackError.message}`,
        };
      }
    }
  }

  getFinetuneModel(): string {
    return this.finetuneModel;
  }

  getFallbackModel(): string {
    return this.fallbackModel;
  }
}