// ARCANOS:WRITE - Narrative content generation service
// Handles requests that have narrative intent

import { getUnifiedOpenAI, type ChatMessage } from './unified-openai.js';
import { aiConfig } from '../config/index.js';
import { MemoryStorage } from '../storage/memory-storage.js';
import { arcanosLogger, createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('ARCANOS:WRITE');

export interface WriteRequest {
  message: string;
  domain?: string;
  useRAG?: boolean;
}

export interface WriteResponse {
  success: boolean;
  content: string;
  model?: string;
  error?: string;
  metadata?: {
    domain: string;
    useRAG: boolean;
    ragContextEntries?: number;
    timestamp: string;
  };
}

export class ArcanosWriteService {
  private unifiedOpenAI: ReturnType<typeof getUnifiedOpenAI> | null;
  private memoryStorage: MemoryStorage;

  constructor() {
    try {
      this.unifiedOpenAI = getUnifiedOpenAI({
        model: aiConfig.fineTunedModel,
      });
    } catch (error) {
      console.warn('⚠️ ArcanosWriteService: OpenAI not available, running in testing mode');
      this.unifiedOpenAI = null;
    }
    this.memoryStorage = new MemoryStorage();
  }

  async processWriteRequest(request: WriteRequest): Promise<WriteResponse> {
    const { message, domain = "general", useRAG = true } = request;
    
    console.log(`🖊️ ARCANOS:WRITE - Processing narrative request in domain: ${domain}`);
    
    try {
      let ragContext = null;
      let ragContextEntries = 0;

      // Step 1: Retrieve RAG context if requested
      if (useRAG) {
        try {
          const memories = await this.memoryStorage.getMemoriesByUser('user');
          ragContext = memories.slice(0, 5); // Get last 5 memories for context
          ragContextEntries = ragContext.length;
          console.log(`📚 Retrieved ${ragContextEntries} RAG context entries`);
        } catch (error: any) {
          console.warn("RAG context retrieval failed:", error.message);
          // Continue without RAG context
        }
      }

      // Step 2: Build system prompt for narrative generation
      const systemPrompt = this.buildWriteSystemPrompt(domain, ragContext || []);

      // Step 3: Generate narrative content
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ];

      console.log('🚀 Generating narrative content...');
      
      let openaiResponse;
      if (this.unifiedOpenAI) {
        const response = await this.unifiedOpenAI.chat(chatMessages);
        if (response.success) {
          openaiResponse = {
            message: response.content,
            model: response.model,
            error: null
          };
        } else {
          openaiResponse = {
            message: '',
            model: 'unknown',
            error: response.error
          };
        }
      } else {
        // Mock response when OpenAI is not available
        openaiResponse = {
          message: `[TESTING MODE] Mock narrative response for: "${message}". In a real environment with OpenAI configured, this would be generated content for domain: ${domain}`,
          model: 'mock-model',
          error: null
        };
      }

      if (openaiResponse.error) {
        arcanosLogger.openaiError('WRITE', openaiResponse);
        return {
          success: false,
          content: '',
          error: openaiResponse.error,
          model: openaiResponse.model,
          metadata: {
            domain,
            useRAG,
            ragContextEntries,
            timestamp: new Date().toISOString()
          }
        };
      }

      // Step 4: Store the interaction in memory if RAG is enabled
      if (useRAG) {
        try {
          await this.memoryStorage.storeMemory(
            'user',
            'default-session',
            'interaction',
            `write_${Date.now()}`,
            {
              userRequest: message,
              generatedContent: openaiResponse.message,
              domain,
              type: 'narrative',
              timestamp: new Date().toISOString()
            },
            [domain, 'narrative', 'write'],
            undefined
          );
          logger.info('Stored narrative interaction in memory');
        } catch (error: any) {
          logger.warning('Memory storage failed', error);
          // Continue without storing memory
        }
      }

      arcanosLogger.serviceSuccess('ARCANOS:WRITE', 'narrative content generation');
      return {
        success: true,
        content: openaiResponse.message,
        model: openaiResponse.model,
        metadata: {
          domain,
          useRAG,
          ragContextEntries,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error: any) {
      arcanosLogger.serviceError('ARCANOS:WRITE', 'narrative content generation', error);
      return {
        success: false,
        content: '',
        error: `WRITE service error: ${error.message}`,
        metadata: {
          domain,
          useRAG,
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  private buildWriteSystemPrompt(domain: string, ragContext: any[]): string {
    let prompt = `You are ARCANOS in WRITE mode. Your role is to generate high-quality narrative content, explanations, and creative writing.

Domain: ${domain}

Focus on:
- Clear, engaging narrative structure
- Rich detail and vivid descriptions
- Coherent flow and logical progression
- Creative and informative content
- Appropriate tone for the domain context`;

    if (ragContext && ragContext.length > 0) {
      prompt += `\n\nContext from previous interactions:\n${JSON.stringify(ragContext, null, 2)}`;
    }

    return prompt;
  }
}