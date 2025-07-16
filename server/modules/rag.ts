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
        console.warn('[ArcanosRAG] No OpenAI API key found, using fallback responses');
        this.status = "error";
        return;
      }
    }
    
    this.status = "active";
  }

  async query(context: QueryContext): Promise<{ success: boolean; data: RAGResponse }> {
    if (!this.openai || !this.config) {
      return {
        success: true,
        data: {
          answer: "RAG response placeholder - OpenAI not configured",
          sources: [],
          confidence: 1,
          reasoning: "N/A",
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            model: "rag-fallback"
          }
        }
      };
    }

    try {
      const startTime = Date.now();
      const openaiConfig = this.config.getOpenAIConfig();
      
      // Try to use the fine-tune model first, fall back to default if it fails
      let model = openaiConfig.fineTuneModel || openaiConfig.defaultModel;
      let response;
      
      try {
        response = await this.openai.chat.completions.create({
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
      } catch (modelError: any) {
        if (modelError.code === 'model_not_found' && model !== openaiConfig.defaultModel) {
          console.warn(`[ArcanosRAG] Fine-tune model ${model} not found, falling back to ${openaiConfig.defaultModel}`);
          model = openaiConfig.defaultModel;
          response = await this.openai.chat.completions.create({
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
        } else {
          throw modelError;
        }
      }

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
      return {
        success: false,
        data: {
          answer: "Sorry, I encountered an error processing your request.",
          sources: [],
          confidence: 0,
          reasoning: "API Error",
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            model: "error"
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