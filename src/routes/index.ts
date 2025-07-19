import { Router } from 'express';
import { OpenAIService, ChatMessage } from '../services/openai';
import askRoute from './ask';
import { HRCCore } from '../modules/hrc';
import { MemoryStorage } from '../storage/memory-storage';
import { askHandler } from '../handlers/ask-handler';

const router = Router();
let openaiService: OpenAIService | null = null;
const memoryStorage = new MemoryStorage();

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

// ARCANOS ask endpoint
router.post('/ask', askHandler);

// Chat endpoint with explicit fallback permission (requires explicit user consent)
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

  const { message, messages, explicitFallbackConsent } = req.body;

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

    // First try with fine-tuned model (never auto-fallback)
    const response = await service.chat(chatMessages, false);
    
    // If fallback is requested and user gave explicit consent, use fallback
    if (response.fallbackRequested && explicitFallbackConsent === true) {
      const fallbackResponse = await service.chatWithFallback(chatMessages);
      return res.json({
        response: fallbackResponse.message,
        model: fallbackResponse.model,
        error: fallbackResponse.error,
        fallbackUsed: true,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      response: response.message,
      model: response.model,
      error: response.error,
      fallbackRequested: response.fallbackRequested,
      fallbackUsed: false,
      timestamp: new Date().toISOString(),
      notice: response.fallbackRequested ? 'Add "explicitFallbackConsent": true to use fallback model' : undefined
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

// HRCCore-based ask endpoint
// This route provides the functionality that would be added by: app.post('/api/ask', ...)
router.post('/ask-hrc', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const hrc = new HRCCore();
  const validation = await hrc.validate(message, {});
  res.json({ success: true, response: message, hrc: validation });
});

// Memory storage endpoints  
// These routes provide the functionality that would be added by: app.post('/api/memory', ...) and app.get('/api/memory', ...)
router.post('/memory', async (req, res) => {
  const sessionId = (req as any).sessionID || 'default-session';
  const mem = await memoryStorage.storeMemory('user', sessionId, 'context', 'key', req.body.value);
  res.json({ success: true, memory: mem });
});

router.get('/memory', async (req, res) => {
  const list = await memoryStorage.getMemoriesByUser('user');
  res.json({ success: true, memories: list });
});

router.use('/api', askRoute);

export default router;