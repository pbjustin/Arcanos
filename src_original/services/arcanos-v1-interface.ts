// ARCANOS MODEL INTERFACE v1.0 – DO NOT MODIFY
// Purpose: Safe, fallback-proof logic interface for model routing
// Enhanced with GPT-4 fallback for malformed outputs

import { getUnifiedOpenAI } from './unified-openai.js';
import { HRCCore } from '../modules/hrc.js';
import { MemoryStorage } from '../storage/memory-storage.js';
import { aiConfig } from '../config/index.js';
import { recoverOutput } from '../utils/output-recovery.js';

// Model interface that all models must implement
export interface ArcanosModel {
  respond(message: string, options: {
    domain?: string;
    useRAG?: boolean;
    useHRC?: boolean;
  }): Promise<{
    status: "success" | "fallback" | "error";
    text: string;
  }>;
}

// Model wrapper that integrates OpenAI service with HRC and RAG
class ArcanosModelWrapper implements ArcanosModel {
  private unifiedOpenAI: ReturnType<typeof getUnifiedOpenAI>;
  private hrcCore: HRCCore;
  private memoryStorage: MemoryStorage;

  constructor(unifiedOpenAI: ReturnType<typeof getUnifiedOpenAI>) {
    this.unifiedOpenAI = unifiedOpenAI;
    this.hrcCore = new HRCCore();
    this.memoryStorage = new MemoryStorage();
  }

  async respond(message: string, options: {
    domain?: string;
    useRAG?: boolean;
    useHRC?: boolean;
  } = {}): Promise<{
    status: "success" | "fallback" | "error";
    text: string;
  }> {
    const { domain = "general", useRAG = true, useHRC = true } = options;
    try {
      let hrcValidation = null;
      let ragContext = null;

      // Step 1: HRC validation if requested
      if (useHRC) {
        try {
          hrcValidation = await this.hrcCore.validate(message, { domain });
        } catch (error) {
          console.warn("HRC validation failed:", error);
          // Continue without HRC validation
        }
      }

      // Step 2: RAG context retrieval if requested
      if (useRAG) {
        try {
          const memories = await this.memoryStorage.getMemoriesByUser('user');
          ragContext = memories.slice(0, 5); // Get last 5 memories for context
        } catch (error) {
          console.warn("RAG context retrieval failed:", error);
          // Continue without RAG context
        }
      }

      // Step 3: Generate AI response using OpenAI service
      const chatMessages = [
        {
          role: 'system' as const,
          content: `You are ARCANOS, an AI assistant. Domain: ${domain}. ${
            ragContext ? `Context from previous interactions: ${JSON.stringify(ragContext)}` : ''
          }`
        },
        {
          role: 'user' as const,
          content: message
        }
      ];

      const openaiResponse = await this.unifiedOpenAI.chat(chatMessages);

      // Handle OpenAI response
      if (!openaiResponse.success) {
        return {
          status: "error",
          text: openaiResponse.error || 'Chat request failed'
        };
      }

      let responseText = openaiResponse.content;

      // Apply GPT-4 fallback if the response appears malformed
      try {
        const recoveryResult = await recoverOutput(responseText, {
          task: `ARCANOS response for domain: ${domain}`,
          expectedFormat: 'text',
          source: 'arcanos-v1-interface'
        });

        if (recoveryResult.wasRecovered) {
          console.log('🔄 Applied GPT-4 fallback recovery to ARCANOS response');
          responseText = recoveryResult.output;
        }
      } catch (recoveryError: any) {
        console.warn('⚠️ GPT-4 fallback recovery failed:', recoveryError.message);
        // Continue with original response if recovery fails
      }

      // Store interaction in memory if RAG is enabled
      if (useRAG) {
        try {
          await this.memoryStorage.storeMemory(
            'user',
            'default-session',
            'interaction',
            `interaction_${Date.now()}`,
            {
              userMessage: message,
              aiResponse: responseText,
              domain: domain,
              timestamp: new Date().toISOString()
            },
            [domain || 'general', 'interaction'],
            undefined
          );
        } catch (error) {
          console.warn("Memory storage failed:", error);
          // Continue without storing memory
        }
      }

      return {
        status: "success",
        text: responseText
      };

    } catch (error: any) {
      console.error("Model respond error:", error);
      return {
        status: "error",
        text: `Error processing request: ${error.message}`
      };
    }
  }
}

// Function to get the active model - returns null if no model is available
export async function getActiveModel(): Promise<ArcanosModel | null> {
  try {
    // Check if OpenAI API key is configured through config system
    if (!aiConfig.openaiApiKey && !process.env.OPENAI_API_KEY) {
      console.warn("No OpenAI API key configured");
      return null;
    }

    // Check if a fine-tuned model is configured
    const fineTunedModel = aiConfig.fineTunedModel;
    if (!fineTunedModel) {
      console.warn("No fine-tuned model configured");
      return null;
    }

    // Try to initialize the unified OpenAI service with configuration
    const unifiedOpenAI = getUnifiedOpenAI({
      apiKey: aiConfig.openaiApiKey,
      model: fineTunedModel,
    });
    
    // Create and return the model wrapper
    return new ArcanosModelWrapper(unifiedOpenAI);

  } catch (error: any) {
    console.error("Failed to get active model:", error);
    return null;
  }
}

// ARCANOS MODEL INTERFACE v1.0 – Main function as specified
export async function askArcanosV1_Safe({
  message,
  domain = "general",
  useRAG = true,
  useHRC = true,
}: {
  message: string;
  domain?: string;
  useRAG?: boolean;
  useHRC?: boolean;
}): Promise<{ response: string; model?: string }> {
  // Get the actual model name from environment (if available)
  const modelName = aiConfig.fineTunedModel;
  
  const model = await getActiveModel(); // ← Your current backend model hook

  if (!model) {
    return { 
      response: "❌ Error: No active model found. Fallback blocked.",
      model: modelName || undefined
    };
  }

  const result = await model.respond(message, { domain, useRAG, useHRC });

  if (result.status === "fallback" || result.status === "error") {
    return { 
      response: "❌ Error: Fallback triggered or invalid model response.",
      model: modelName || undefined
    };
  }

  return { 
    response: result.text,
    model: modelName || undefined
  };
}