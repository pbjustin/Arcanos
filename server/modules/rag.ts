import OpenAI from 'openai';
import type { QueryContext, RAGResponse, RAGDocument } from '../types';
import type { ArcanosConfig } from '../config/arcanos-config';

export class ArcanosRAG {
  public name = "ArcanosRAG";
  public status: "active" | "inactive" | "error" = "active";
  private docs: RAGDocument[] = [];
  private openai: OpenAI | null = null;
  private config: ArcanosConfig | null = null;

  async initialize(config?: ArcanosConfig) {
    this.config = config || null;
    
    if (this.config) {
      const openaiConfig = this.config.getOpenAIConfig();
      if (openaiConfig.apiKey) {
        this.openai = new OpenAI({
          apiKey: openaiConfig.apiKey,
        });
        console.log('[ArcanosRAG] OpenAI client initialized successfully');
      } else {
        console.error('[ArcanosRAG] No OpenAI API key found - cannot initialize');
        this.status = "error";
        throw new Error('OpenAI API key is required for RAG module initialization');
      }
    }
    
    this.status = "active";
  }

  async query(context: QueryContext): Promise<{ success: boolean; data: RAGResponse }> {
    if (!this.openai || !this.config) {
      throw new Error('RAG module not properly initialized - OpenAI client or config missing');
    }

    try {
      const startTime = Date.now();
      
      // Use the model selection logic from config
      const model = this.config.getModel();
      if (!model) {
        throw new Error('No model configured');
      }
      
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: "You are Arcanos, an AI assistant that provides helpful, accurate, and concise responses. Use the provided context to enhance your answers when relevant."
          },
          {
            role: "user",
            content: context.query
          }
        ],
        max_tokens: 1000,
        temperature: 0.7,
      });

      const processingTime = Date.now() - startTime;
      const answer = response.choices[0]?.message?.content || "No response generated";
      
      return {
        success: true,
        data: {
          answer,
          sources: this.docs.map(doc => ({
            id: doc.id,
            content: doc.content.substring(0, 200) + "...",
            startIndex: 0,
            endIndex: doc.content.length,
            embeddings: doc.embeddings || [],
            score: 0.5
          })),
          confidence: 0.9,
          reasoning: `Generated using OpenAI model: ${model}`,
          metadata: {
            processingTime,
            tokensUsed: response.usage?.total_tokens || 0,
            model: model
          }
        }
      };
    } catch (error) {
      console.error('[ArcanosRAG] OpenAI API error:', error);
      throw error; // Re-throw error instead of returning success: false to ensure no fallback
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