import OpenAI from 'openai';
import type { QueryContext, RAGResponse, RAGDocument } from '../types/index.js';

export class ArcanosRAG {
  public name = "ArcanosRAG";
  public status: "active" | "inactive" | "error" = "active";
  private docs: RAGDocument[] = [];
  private openai: OpenAI | null = null;
  private config: any = null;

  async initialize(config?: any) {
    try {
      this.config = config;
      if (config?.openai?.apiKey) {
        this.openai = new OpenAI({
          apiKey: config.openai.apiKey,
        });
        
        // Test the connection immediately to fail fast
        try {
          const testResponse = await this.openai.chat.completions.create({
            model: config.openai.model,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 1
          });
          console.log('[RAG] OpenAI client initialized and tested successfully');
        } catch (testError) {
          console.error('[RAG] OpenAI connection test failed:', testError);
          this.status = "error";
          throw new Error(`OpenAI connection failed: ${testError instanceof Error ? testError.message : 'Unknown error'}`);
        }
      } else {
        console.error('[RAG] No OpenAI API key provided - service will be unavailable');
        this.status = "error";
        throw new Error('OpenAI API key is required but not provided');
      }
      this.status = "active";
    } catch (error) {
      console.error('[RAG] Failed to initialize OpenAI client:', error);
      this.status = "error";
      throw error; // Re-throw to fail server initialization
    }
  }

  async query(context: QueryContext): Promise<{ success: boolean; data: RAGResponse }> {
    const startTime = Date.now();
    
    try {
      // Check if OpenAI is available - no fallback, return error if not configured
      if (!this.openai || !this.config?.openai) {
        console.error('[RAG] OpenAI client not initialized or configured');
        return {
          success: false,
          data: {
            answer: "OpenAI connection error: AI service is not properly configured or unavailable",
            sources: [],
            confidence: 0,
            reasoning: "OpenAI client not initialized - no fallback available",
            metadata: {
              processingTime: Date.now() - startTime,
              tokensUsed: 0,
              model: this.config?.openai?.model || "not_configured"
            }
          }
        };
      }

      const completion = await this.openai.chat.completions.create({
        model: this.config.openai.model,
        messages: [
          {
            role: "system",
            content: "You are Arcanos, an advanced AI assistant. Provide helpful, accurate, and thoughtful responses."
          },
          {
            role: "user",
            content: context.query
          }
        ],
        max_tokens: this.config.openai.maxTokens || 1000,
        temperature: this.config.openai.temperature || 0.7,
      });

      const response = completion.choices[0]?.message?.content || "I apologize, but I couldn't generate a response.";
      const tokensUsed = completion.usage?.total_tokens || 0;
      const processingTime = Date.now() - startTime;

      return {
        success: true,
        data: {
          answer: response,
          sources: [],
          confidence: 0.95,
          reasoning: "Generated using fine-tuned GPT model",
          metadata: {
            processingTime,
            tokensUsed,
            model: this.config.openai.model
          }
        }
      };
    } catch (error) {
      console.error('[RAG] Error during query processing:', error);
      return {
        success: false,
        data: {
          answer: `OpenAI connection error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
          sources: [],
          confidence: 0,
          reasoning: "Error occurred during OpenAI API call",
          metadata: {
            processingTime: Date.now() - startTime,
            tokensUsed: 0,
            model: this.config?.openai?.model || "error"
          }
        }
      };
    }
  }

  async addDocument(content: string, metadata: any) {
    this.docs.push({
      id: String(this.docs.length + 1),
      content,
      metadata,
      embeddings: [],
      chunks: [],
      lastUpdated: new Date()
    });
    return { success: true };
  }
}