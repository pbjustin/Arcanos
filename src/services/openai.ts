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
  private model: string;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // 2. USE IT PROPERLY in the OpenAI API
    this.model = process.env.FINE_TUNED_MODEL || "gpt-3.5-turbo";
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    try {
      // Use the model from environment variable or fallback
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: 1000,
        temperature: 0.7,
      });

      if (completion.choices && completion.choices.length > 0) {
        return {
          message: completion.choices[0].message?.content || 'No response',
          model: this.model,
        };
      }

      throw new Error('No response from OpenAI');
    } catch (error: any) {
      console.error('OpenAI API error:', error.message);
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