import { Request, Response } from 'express';
import { OpenAIService, ChatMessage } from '../services/openai';
import { HRCCore } from '../modules/hrc';
import { HRCOverlay } from '../modules/overlay';
import { MemoryStorage } from '../storage/memory-storage';

let openaiService: OpenAIService | null = null;
let hrcCore: HRCCore | null = null;
let hrcOverlay: HRCOverlay | null = null;
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

function getHRCOverlay(): HRCOverlay {
  if (!hrcOverlay) {
    hrcOverlay = new HRCOverlay();
  }
  return hrcOverlay;
}

function getMemoryStorage(): MemoryStorage {
  if (!memoryStorage) {
    memoryStorage = new MemoryStorage();
  }
  return memoryStorage;
}

export const askHandler = async (req: Request, res: Response) => {
  try {
    const { message, domain = "general", useRAG = true, useHRC = true, allowFallback = false } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: "Message is required and must be a string",
        timestamp: new Date().toISOString()
      });
    }

    console.log("Processing ARCANOS request:", { message, domain, useRAG, useHRC, allowFallback });

    let response = message;
    let hrcValidation = null;
    let ragContext = null;
    let aiResponse = null;
    let errors: string[] = [];

    // Step 1: HRC overlay evaluation if requested
    if (useHRC) {
      try {
        const overlay = getHRCOverlay();
        const result = await overlay.evaluate(message, domain);
        hrcValidation = result.metrics;
        console.log('HRC overlay result:', result);
        if (result.route === 'block') {
          return res.status(400).json({
            error: 'Message blocked by HRC overlay',
            metrics: result.metrics,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error: any) {
        console.error('HRC overlay error:', error);
        errors.push(`HRC overlay failed: ${error.message}`);
      }
    }

    // Step 2: RAG context retrieval if requested
    if (useRAG) {
      try {
        const memory = getMemoryStorage();
        const userId = (req.headers['x-user-id'] as string) || 'default';
        // Retrieve relevant context from memory
        const memories = await memory.getMemoriesByUser(userId);
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
      
      // Log the fine-tuned model being used
      console.log('🔍 Using fine-tuned model:', process.env.AI_MODEL || process.env.FINE_TUNE_MODEL || process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL || 'default');
      console.log('🎯 Processing message:', message.substring(0, 100) + (message.length > 100 ? '...' : ''));
      
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
      console.log('🚀 Sending request to OpenAI service...');
      const openaiResponse = await openai.chat(chatMessages);
      aiResponse = openaiResponse;
      console.log('📥 Received response from OpenAI service');
      
      // Handle error cases
      if (openaiResponse.error) {
        console.warn('⚠️ OpenAI service returned an error:', openaiResponse.error);
        response = openaiResponse.message;
        errors.push(`OpenAI error: ${openaiResponse.error}`);
      } else {
        console.log('✅ Successfully generated AI response');
        response = openaiResponse.message;
      }

      // Store interaction in memory if RAG is enabled
      if (useRAG) {
        try {
          const memory = getMemoryStorage();
          const userId = (req.headers['x-user-id'] as string) || 'default';
          await memory.storeMemory(
            userId,
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

    // Return the actual response with metadata
    return res.status(200).json({ 
      response,
      metadata: {
        model: aiResponse?.model || 'unknown',
        domain,
        useHRC,
        useRAG,
        hrcValidation,
        ragContextEntries: ragContext?.length || 0,
        errors: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString()
      }
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