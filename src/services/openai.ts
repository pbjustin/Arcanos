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
      timeout: 30000, // 30 seconds timeout
      maxRetries: 2,
    });

    // Default to "arcanos-v1" if no fine-tuned model specified
    this.model = process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL || "arcanos-v1";
    
    // Log model configuration for audit purposes
    console.log('🔧 OpenAI Service initialized with model:', this.model);
    if (!process.env.FINE_TUNED_MODEL && !process.env.OPENAI_FINE_TUNED_MODEL) {
      console.warn('⚠️ No fine-tuned model specified, using default:', this.model);
    }
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    console.log('🚀 Starting OpenAI API call');
    console.log('📝 Model:', this.model);
    console.log('💬 Messages:', JSON.stringify(messages, null, 2));
    
    try {
      // Log before the API call
      const startTime = Date.now();
      console.log('⏰ Making OpenAI API request at:', new Date().toISOString());
      
      // Use the model from environment variable or fallback
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: 1000,
        temperature: 0.7,
      });

      const endTime = Date.now();
      console.log('✅ OpenAI API call completed in:', endTime - startTime, 'ms');
      console.log('📊 API Response:', {
        id: completion.id,
        model: completion.model,
        choices: completion.choices?.length || 0,
        usage: completion.usage
      });

      if (completion.choices && completion.choices.length > 0) {
        const responseMessage = completion.choices[0].message?.content || 'No response';
        console.log('💬 Response content length:', responseMessage.length);
        
        return {
          message: responseMessage,
          model: this.model,
        };
      }

      throw new Error('No response from OpenAI');
    } catch (error: any) {
      console.error('❌ OpenAI API error:', error.message);
      console.error('🔍 Error details:', {
        name: error.name,
        status: error.status,
        code: error.code,
        type: error.type
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