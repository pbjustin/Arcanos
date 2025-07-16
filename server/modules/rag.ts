import OpenAI from 'openai';
import type { QueryContext, RAGResponse, RAGDocument } from '../types';
import type { ArcanosConfig } from '../config/arcanos-config';
import { PermissionManager } from './permission-manager';

export class ArcanosRAG {
  public name = "ArcanosRAG";
  public status: "active" | "inactive" | "error" = "active";
  private docs: RAGDocument[] = [];
  private openai: OpenAI | null = null;
  private config: ArcanosConfig | null = null;
  private permissionManager: PermissionManager = PermissionManager.getInstance();

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

    const startTime = Date.now();
    const openaiConfig = this.config.getOpenAIConfig();
    
    // Determine which model to try first
    let modelToUse = this.config.getModel();
    let isFineTuneAttempt = openaiConfig.useFineTuned;
    
    try {
      console.log(`[ArcanosRAG] Attempting query with model: ${modelToUse}`);
      
      const response = await this.openai.chat.completions.create({
        model: modelToUse,
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
      
      console.log(`[ArcanosRAG] Successfully processed query with ${modelToUse}`);
      
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
          reasoning: `Generated using OpenAI model: ${modelToUse}${isFineTuneAttempt ? ' (fine-tuned)' : ' (base model)'}`,
          metadata: {
            processingTime,
            tokensUsed: response.usage?.total_tokens || 0,
            model: modelToUse,
            wasFineTuneAttempt: isFineTuneAttempt,
            permissionRequested: false
          }
        }
      };
    } catch (error) {
      console.error(`[ArcanosRAG] Error with model ${modelToUse}:`, error);
      
      // If this was a fine-tune model attempt and it failed, ask for permission to fallback
      if (isFineTuneAttempt) {
        try {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const permissionGranted = await this.permissionManager.requestFallbackPermission(
            `Fine-tune model '${modelToUse}' failed: ${errorMessage}`
          );
          
          if (permissionGranted) {
            console.log('[ArcanosRAG] Permission granted - attempting fallback to default model');
            
            // Retry with default model
            const defaultModel = openaiConfig.defaultModel;
            const fallbackResponse = await this.openai.chat.completions.create({
              model: defaultModel,
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
            const answer = fallbackResponse.choices[0]?.message?.content || "No response generated";
            
            console.log(`[ArcanosRAG] Successfully processed query with fallback model: ${defaultModel}`);
            
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
                reasoning: `Generated using fallback model: ${defaultModel} (fine-tune model failed, user granted permission)`,
                metadata: {
                  processingTime,
                  tokensUsed: fallbackResponse.usage?.total_tokens || 0,
                  model: defaultModel,
                  wasFineTuneAttempt: true,
                  permissionRequested: true,
                  originalError: errorMessage
                }
              }
            };
          } else {
            console.log('[ArcanosRAG] Permission denied - throwing original error');
            throw new Error(`Fine-tune model failed and fallback permission denied: ${errorMessage}`);
          }
        } catch (permissionError) {
          console.error('[ArcanosRAG] Error during permission request or fallback:', permissionError);
          throw error; // Re-throw original error if permission system fails
        }
      } else {
        // If this was already a base model attempt, just throw the error
        throw error;
      }
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