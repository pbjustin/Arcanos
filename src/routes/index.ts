import { Router } from 'express';
import { OpenAIService, ChatMessage } from '../services/openai.js';

const router = Router();
let openaiService: OpenAIService | null = null;

// Lazy initialize OpenAI service
function getOpenAIService(): OpenAIService {
  if (!openaiService) {
    openaiService = new OpenAIService();
  }
  return openaiService;
}

// Sample GET endpoint
router.get('/', (req, res) => {
  let finetuneModel = 'Not configured';
  let fallbackModel = 'Not configured';
  
  try {
    const service = getOpenAIService();
    finetuneModel = service.getFinetuneModel();
    fallbackModel = service.getFallbackModel();
  } catch (error) {
    // Service not available
  }

  res.json({
    message: 'Welcome to Arcanos API',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    finetuneModel,
    fallbackModel
  });
});

// Sample POST endpoint
router.post('/echo', (req, res) => {
  res.json({
    message: 'Echo endpoint',
    data: req.body,
    timestamp: new Date().toISOString()
  });
});

// Chat endpoint without fallback (requires permission)
router.post('/ask', async (req, res) => {
  let service: OpenAIService;
  
  try {
    service = getOpenAIService();
  } catch (error: any) {
    return res.status(500).json({
      error: 'OpenAI service not initialized. Check API key and fine-tuned model configuration.',
      details: error.message
    });
  }

  const { message, messages } = req.body;

  if (!message && !messages) {
    return res.status(400).json({
      error: 'Either "message" (string) or "messages" (array) is required'
    });
  }

  try {
    let chatMessages: ChatMessage[];

    if (messages) {
      // Use provided messages array
      chatMessages = messages;
    } else {
      // Convert single message to messages array
      chatMessages = [
        { role: 'user', content: message }
      ];
    }

    // Call without fallback permission - will ask for permission if fine-tuned model fails
    const response = await service.chat(chatMessages, false);
    
    res.json({
      response: response.message,
      model: response.model,
      error: response.error,
      fallbackRequested: response.fallbackRequested,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Chat endpoint with fallback permission granted
router.post('/ask-with-fallback', async (req, res) => {
  let service: OpenAIService;
  
  try {
    service = getOpenAIService();
  } catch (error: any) {
    return res.status(500).json({
      error: 'OpenAI service not initialized. Check API key and fine-tuned model configuration.',
      details: error.message
    });
  }

  const { message, messages } = req.body;

  if (!message && !messages) {
    return res.status(400).json({
      error: 'Either "message" (string) or "messages" (array) is required'
    });
  }

  try {
    let chatMessages: ChatMessage[];

    if (messages) {
      // Use provided messages array
      chatMessages = messages;
    } else {
      // Convert single message to messages array
      chatMessages = [
        { role: 'user', content: message }
      ];
    }

    // Call with fallback permission granted
    const response = await service.chat(chatMessages, true);
    
    res.json({
      response: response.message,
      model: response.model,
      error: response.error,
      fallbackUsed: response.model !== service.getFinetuneModel(),
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get model status
router.get('/model-status', (req, res) => {
  try {
    const service = getOpenAIService();
    res.json({
      configured: true,
      finetuneModel: service.getFinetuneModel(),
      fallbackModel: service.getFallbackModel(),
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'OpenAI service not initialized',
      configured: false,
      details: error.message
    });
  }
});

export default router;