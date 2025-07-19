import { OpenAIService, ChatMessage } from './openai';

let openaiService: OpenAIService | null = null;

// Lazy initialize OpenAI service
function getOpenAIService(): OpenAIService {
  if (!openaiService) {
    openaiService = new OpenAIService();
  }
  return openaiService;
}

export async function processPrompt(prompt: string, options = {}) {
  try {
    const service = getOpenAIService();
    
    // Convert prompt to chat message format
    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ];
    
    const response = await service.chat(messages);
    
    return {
      message: response.message,
      model: response.model,
      error: response.error,
      fallbackRequested: response.fallbackRequested,
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    throw new Error(`Failed to process prompt: ${error.message}`);
  }
}