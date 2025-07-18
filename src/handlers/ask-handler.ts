import { Request, Response } from 'express';
import { OpenAIService, ChatMessage } from '../services/openai.js';
import { HRCCore } from '../modules/hrc.js';
import { MemoryStorage } from '../storage/memory-storage.js';

let openaiService: OpenAIService | null = null;
let hrcCore: HRCCore | null = null;
let memoryStorage: MemoryStorage | null = null;

// Lazy initialization of services
function getOpenAIService(): OpenAIService {
  if (!openaiService) {
    openaiService = new OpenAIService();
  }
  return openaiService;
}

function getHRCCore(): HRCCore {
  if (!hrcCore) {
    hrcCore = new HRCCore();
  }
  return hrcCore;
}

function getMemoryStorage(): MemoryStorage {
  if (!memoryStorage) {
    memoryStorage = new MemoryStorage();
  }
  return memoryStorage;
}

export const askHandler = async (req: Request, res: Response) => {
  try {
    const { message, domain = "general", useRAG = true, useHRC = true } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: "Message is required and must be a string",
        timestamp: new Date().toISOString()
      });
    }

    console.log("Processing ARCANOS request:", { message, domain, useRAG, useHRC });

    let response = message;
    let hrcValidation = null;
    let ragContext = null;
    let aiResponse = null;
    let errors: string[] = [];

    // Step 1: HRC validation if requested
    if (useHRC) {
      try {
        const hrc = getHRCCore();
        hrcValidation = await hrc.validate(message, { domain });
        console.log("HRC validation result:", hrcValidation);
      } catch (error: any) {
        console.error("HRC validation error:", error);
        errors.push(`HRC validation failed: ${error.message}`);
      }
    }

    // Step 2: RAG context retrieval if requested
    if (useRAG) {
      try {
        const memory = getMemoryStorage();
        // Retrieve relevant context from memory
        const memories = await memory.getMemoriesByUser('user');
        ragContext = memories.slice(0, 5); // Get last 5 memories for context
        console.log("Retrieved RAG context:", ragContext?.length || 0, "entries");
      } catch (error: any) {
        console.error("RAG context retrieval error:", error);
        errors.push(`RAG context retrieval failed: ${error.message}`);
      }
    }

    // Step 3: Generate AI response using OpenAI service
    try {
      const openai = getOpenAIService();
      
      // Build chat messages with context
      const chatMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are ARCANOS, an AI assistant. Domain: ${domain}. ${
            ragContext ? `Context from previous interactions: ${JSON.stringify(ragContext)}` : ''
          }`
        },
        {
          role: 'user',
          content: message
        }
      ];

      // Use OpenAI service to generate response
      const openaiResponse = await openai.chat(chatMessages, true); // Allow fallback
      aiResponse = openaiResponse;
      response = openaiResponse.message;

      // Store interaction in memory if RAG is enabled
      if (useRAG) {
        try {
          const memory = getMemoryStorage();
          await memory.storeMemory(
            'user',
            (req as any).sessionID || 'default-session',
            'interaction',
            `interaction_${Date.now()}`,
            {
              userMessage: message,
              aiResponse: response,
              domain,
              timestamp: new Date().toISOString()
            },
            [domain, 'interaction'],
            undefined
          );
        } catch (error: any) {
          console.error("Memory storage error:", error);
          errors.push(`Memory storage failed: ${error.message}`);
        }
      }

    } catch (error: any) {
      console.error("OpenAI service error:", error);
      errors.push(`AI response generation failed: ${error.message}`);
      // Fallback to basic response
      response = `I apologize, but I'm experiencing technical difficulties. Your message "${message}" was received in the ${domain} domain.`;
    }

    // Return comprehensive response
    return res.status(200).json({
      response,
      domain,
      useRAG,
      useHRC,
      hrcValidation,
      ragContextCount: ragContext?.length || 0,
      aiModel: aiResponse?.model || 'none',
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error("askHandler error:", error);
    return res.status(500).json({ 
      error: "Internal server error",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};