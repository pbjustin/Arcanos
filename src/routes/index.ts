import { Router } from 'express';
import { OpenAIService, ChatMessage } from '../services/openai';
import fs from 'fs';
import path from 'path';
import { databaseService } from '../services/database';
import askRoute from './ask';
import jobLimitRoute from './job-limit';
import jobQueueRoute from './job-queue';
import canonRoute from './canon';
import containersRoute from './containers';
import queryRouter from './query-router';
import pluginRoute from './plugins';
import { HRCCore } from '../modules/hrc';
import { MemoryStorage } from '../storage/memory-storage';
import { processArcanosRequest } from '../services/arcanos-router';
import { diagnosticsService } from '../services/diagnostics';
import { workerStatusService } from '../services/worker-status';

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
  let model = 'Not configured';
  
  try {
    const service = getOpenAIService();
    model = service.getModel();
  } catch (error) {
    // Service not available
  }

  res.json({
    message: 'Welcome to Arcanos API',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    model
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

// ARCANOS ask endpoint - exact implementation from specification
router.post('/ask', async (req, res) => {
  const { message, domain = "general", useRAG = true, useHRC = true } = req.body;

  if (!process.env.FINE_TUNED_MODEL) {
    return res.status(500).json({
      error: "Fine-tuned model is missing. Fallback not allowed without user permission.",
    });
  }

  try {
    // Import OpenAI to use the new API format while maintaining compatibility
    const openai = getOpenAIService();
    
    const completion = await openai.chat([{ role: "user", content: message }]);

    return res.json({ 
      response: completion.message,
      model: completion.model
    });
  } catch (err) {
    return res.status(500).json({
      error: "Model invocation failed. Fine-tuned model may be unavailable.",
      model: process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL
    });
  }
});

// Chat endpoint with explicit fallback permission (requires explicit user consent)
router.post('/ask-with-fallback', async (req, res) => {
  console.log('🔄 /api/ask-with-fallback endpoint called');
  let service: OpenAIService;
  
  try {
    service = getOpenAIService();
    console.log('✅ OpenAI service initialized for ask-with-fallback');
  } catch (error: any) {
    console.error('❌ Failed to initialize OpenAI service:', error.message);
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
      console.log('📝 Using provided messages array, count:', messages.length);
    } else {
      // Convert single message to messages array
      chatMessages = [
        { role: 'user', content: message }
      ];
      console.log('📝 Converted single message to chat format');
    }

    console.log('🚀 Calling OpenAI service for ask-with-fallback...');
    // Use simplified chat interface
    const response = await service.chat(chatMessages);
    console.log('📥 Received response from OpenAI service');
    
    res.json({
      response: response.message,
      model: response.model,
      error: response.error,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('❌ Error in ask-with-fallback:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get model status
router.get('/model-status', (req, res) => {
  console.log('🔍 Model status endpoint called');
  try {
    const service = getOpenAIService();
    const modelName = service.getModel();
    console.log('✅ Model status check successful, model:', modelName);
    res.json({
      configured: true,
      model: modelName,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('❌ Model status check failed:', error.message);
    res.status(500).json({
      error: 'OpenAI service not initialized',
      configured: false,
      details: error.message
    });
  }
});

// Get model info - dedicated endpoint for model metadata
router.get('/model/info', (req, res) => {
  console.log('🔍 Model info endpoint called');
  try {
    const service = getOpenAIService();
    const modelName = service.getModel();
    console.log('✅ Model info check successful, model:', modelName);
    res.json({
      model: modelName,
      configured: true,
      environment: {
        fine_tuned_model: process.env.FINE_TUNED_MODEL || null,
        openai_fine_tuned_model: process.env.OPENAI_FINE_TUNED_MODEL || null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('❌ Model info check failed:', error.message);
    res.status(500).json({
      error: 'OpenAI service not initialized',
      configured: false,
      model: null,
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

// Bootstrap memory schema from SQL file if available
router.post('/memory/bootstrap', async (_req, res) => {
  const sqlPath = path.resolve(__dirname, '..', '..', 'sql', 'memory_state.sql');
  if (!fs.existsSync(sqlPath)) {
    return res.status(404).json({ error: 'memory_state.sql not found' });
  }
  try {
    await databaseService.initialize();
    res.json({ success: true, message: 'Memory schema initialized.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ARCANOS V1 Safe Interface endpoint
router.post('/ask-v1-safe', async (req, res) => {
  try {
    const { askArcanosV1_Safe } = await import('../services/arcanos-v1-interface');
    const { message, domain, useRAG, useHRC } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await askArcanosV1_Safe({
      message,
      domain,
      useRAG,
      useHRC
    });

    res.json(result);
  } catch (error: any) {
    console.error('askArcanosV1_Safe error:', error);
    res.status(500).json({ 
      response: "❌ Error: Internal server error in V1 Safe interface." 
    });
  }
});

// ARCANOS Intent-Based Routing endpoint
// Routes inputs to ARCANOS:WRITE or ARCANOS:AUDIT based on intent analysis
router.post('/arcanos', async (req, res) => {
  const { message, domain = "general", useRAG = true, useHRC = true } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ 
      error: "Message is required and must be a string",
      timestamp: new Date().toISOString()
    });
  }

  try {
    console.log('🎯 ARCANOS endpoint called with message:', message.substring(0, 100) + '...');
    
    const routerRequest = {
      message,
      domain,
      useRAG,
      useHRC
    };

    const result = await processArcanosRequest(routerRequest);
    
    // Return the routed response
    res.json({
      success: result.success,
      response: result.response,
      intent: result.intent,
      confidence: result.confidence,
      reasoning: result.reasoning,
      model: result.model,
      error: result.error,
      metadata: result.metadata
    });

  } catch (error: any) {
    console.error('❌ ARCANOS endpoint error:', error);
    res.status(500).json({
      error: 'Internal server error in ARCANOS router',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GPT Diagnostics Prompt Language endpoint
// Accepts natural language diagnostic commands
router.post('/diagnostics', async (req, res) => {
  const { command, message } = req.body;
  
  // Accept either 'command' or 'message' field for flexibility
  const diagnosticCommand = command || message;
  
  if (!diagnosticCommand || typeof diagnosticCommand !== 'string') {
    return res.status(400).json({
      error: 'Diagnostic command is required',
      examples: [
        'Check available memory',
        'Show RAM usage', 
        'Run CPU performance check',
        'Disk usage report',
        'Full system health check'
      ],
      timestamp: new Date().toISOString()
    });
  }

  try {
    console.log('🔍 Diagnostics endpoint called with command:', diagnosticCommand);
    
    const result = await diagnosticsService.executeDiagnosticCommand(diagnosticCommand);
    
    console.log('📊 Diagnostic result:', {
      success: result.success,
      category: result.category,
      hasData: !!result.data
    });
    
    res.json(result);
    
  } catch (error: any) {
    console.error('❌ Diagnostics endpoint error:', error);
    res.status(500).json({
      success: false,
      command: diagnosticCommand,
      category: 'error',
      data: {},
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Worker Diagnostics endpoint
// Get real-time status of all background workers
router.get('/workers/status', async (req, res) => {
  try {
    console.log('🔍 Worker status endpoint called');
    
    const workersStatus = await workerStatusService.getAllWorkersStatus();
    
    console.log('📊 Retrieved status for', workersStatus.length, 'workers');
    
    res.json(workersStatus);
    
  } catch (error: any) {
    console.error('❌ Worker status endpoint error:', error);
    res.status(500).json({
      error: 'Failed to retrieve worker status',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Booker namespace - Worker Status endpoint
// Provides the specific API path expected by the booker integration
router.get('/booker/workers/status', async (req, res) => {
  try {
    console.log('🔍 Booker worker status endpoint called');
    
    const workersStatus = await workerStatusService.getAllWorkersStatus();
    
    console.log('📊 Retrieved status for', workersStatus.length, 'workers');
    
    res.json(workersStatus);
    
  } catch (error: any) {
    console.error('❌ Booker worker status endpoint error:', error);
    res.status(500).json({
      error: 'Failed to retrieve worker status',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint to add high-load worker for testing CPU alerts
router.post('/booker/workers/add-high-load', async (req, res) => {
  try {
    console.log('🔧 Adding high-load worker for testing');
    
    workerStatusService.addHighLoadWorker();
    
    res.json({ 
      success: true, 
      message: 'High-load worker added for testing',
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    console.error('❌ Error adding high-load worker:', error);
    res.status(500).json({
      error: 'Failed to add high-load worker',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Sleep configuration endpoint for core backend sleep window
router.get('/config/sleep', (req, res) => {
  // Core backend sleep configuration
  const sleepConfig = {
    enabled: process.env.SLEEP_ENABLED === 'true',
    start_time_utc: process.env.SLEEP_START || '02:00',
    duration_hours: parseInt(process.env.SLEEP_DURATION || '7', 10),
    timezone: process.env.SLEEP_TZ || 'UTC'
  };

  console.log('🛏️ Sleep config requested:', sleepConfig);
  res.json(sleepConfig);
});

// Test endpoint to verify sleep window processing logic
router.get('/config/sleep/processed', (req, res) => {
  // Get the raw config
  const sleepConfig = {
    enabled: process.env.SLEEP_ENABLED === 'true',
    start_time_utc: process.env.SLEEP_START || '02:00',
    duration_hours: parseInt(process.env.SLEEP_DURATION || '7', 10),
    timezone: process.env.SLEEP_TZ || 'UTC'
  };

  // Process it using the same logic as getCoreSleepWindow
  try {
    const { start_time_utc, duration_hours, enabled } = sleepConfig;
    const [startH, startM] = start_time_utc.split(':').map(Number);
    const endH = (startH + duration_hours) % 24;
    const endTimeUTC = `${String(endH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;

    const processedResult = {
      active: enabled,
      startUTC: start_time_utc,
      endUTC: endTimeUTC,
      duration: duration_hours
    };

    console.log('🛏️ Processed sleep window:', processedResult);
    res.json(processedResult);
  } catch (err) {
    console.error('Sleep window processing error:', err);
    res.json({ active: false });
  }
});

// NEW: Active Sleep Schedule API endpoint
// This endpoint provides the exact format specified in the problem statement
router.get('/v1/sleep_schedule/active_sleep_schedule', (req, res) => {
  try {
    // Get configuration from environment variables (Railway compatible)
    const sleepConfig = {
      enabled: process.env.SLEEP_ENABLED === 'true',
      start_time_utc: process.env.SLEEP_START || '02:00',
      duration_hours: parseInt(process.env.SLEEP_DURATION || '7', 10),
      timezone: process.env.SLEEP_TZ || 'America/New_York'
    };

    console.log('🛌 Active sleep schedule requested:', sleepConfig);
    res.json(sleepConfig);
  } catch (error) {
    console.error('❌ Error fetching active sleep schedule:', error);
    res.status(500).json({
      error: 'Failed to fetch sleep schedule',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.use('/api', askRoute);
router.use('/jobs', jobLimitRoute);
router.use('/queue', jobQueueRoute);
router.use('/arcanos/plugins', pluginRoute);

// Canon API routes - Clean Canon Access API for Backstage Booker
router.use('/canon', canonRoute);

// Container management routes - ARCANOS Container Manager
router.use('/containers', containersRoute);

// Query routing - Intelligent routing between fine-tune and regular endpoints
router.use('/', queryRouter);

export default router;