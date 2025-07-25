// ARCANOS AI Routes - AI-controlled endpoints extracted for modularity
import { Router } from 'express';
import path from 'path';
import { modelControlHooks } from '../services/model-control-hooks';
import { sendErrorResponse, sendSuccessResponse, handleServiceResult, handleCatchError } from '../utils/response';
import { codeInterpreterService } from '../services/code-interpreter';


const router = Router();

// Fine-tune routing status endpoint
router.get('/finetune-status', async (req, res) => {
  const userId = req.headers['x-user-id'] as string || 'default';
  const sessionId = req.headers['x-session-id'] as string || 'default';
  
  try {
    const { fineTuneRoutingService } = await import('../services/finetune-routing');
    
    const isActive = await fineTuneRoutingService.isFineTuneRoutingActive(userId, sessionId);
    const statusMessage = await fineTuneRoutingService.getStatusMessage(userId, sessionId);
    
    sendSuccessResponse(res, 'Fine-tune routing status retrieved', {
      active: isActive,
      message: statusMessage,
      userId,
      sessionId,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    sendErrorResponse(res, 500, 'Failed to get fine-tune routing status', error.message);
  }
});

// GitHub webhook endpoint - AI controlled
router.post('/webhook', async (req, res) => {
  try {
    console.log('🔗 GitHub webhook received - routing to AI dispatcher');
    
    const result = await modelControlHooks.handleApiRequest(
      '/webhook',
      'POST',
      req.body,
      {
        userId: 'github',
        sessionId: 'webhook',
        source: 'api',
        metadata: { headers: req.headers }
      }
    );

    handleServiceResult(res, result, 'Webhook processed successfully');

  } catch (err: any) {
    handleCatchError(res, err, 'Webhook');
  }
});

// Simplified diagnostic endpoint - AI controlled
router.get('/sync/diagnostics', async (req, res) => {
  const token = req.headers['authorization'];
  const gptToken = `Bearer ${process.env.GPT_TOKEN}`;
  const apiToken = `Bearer ${process.env.ARCANOS_API_TOKEN}`;
  if (token !== gptToken && token !== apiToken) {
    return sendErrorResponse(res, 403, "Unauthorized access");
  }

  try {
    const result = await modelControlHooks.checkSystemHealth({
      userId: 'diagnostics',
      sessionId: 'sync',
      source: 'api',
      metadata: { headers: req.headers }
    });

    if (result.success) {
      // Parse response if it's JSON string, otherwise create basic diagnostic
      let diagnosticData;
      try {
        diagnosticData = JSON.parse(result.response || '{}');
      } catch {
        // Fallback diagnostic
        const memory = process.memoryUsage();
        const uptime = process.uptime();
        diagnosticData = {
          status: 'healthy',
          env: process.env.NODE_ENV,
          memory: {
            rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
            heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB'
          },
          uptime: Math.round(uptime) + 's',
          timestamp: new Date().toISOString(),
          aiControlled: true
        };
      }

      res.json(diagnosticData);
    } else {
      sendErrorResponse(res, 500, result.error || 'Diagnostics failed');
    }
  } catch (error: any) {
    handleCatchError(res, error, 'Diagnostics');
  }
});

// POST /code-interpreter - Run Python code using OpenAI's tool calling
router.post('/code-interpreter', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return sendErrorResponse(res, 400, 'Prompt is required');
  }
  try {
    const result = await codeInterpreterService.run(prompt);
    sendSuccessResponse(res, 'Code interpreter executed', result);
  } catch (error: any) {
    handleCatchError(res, error, 'Code interpreter');
  }
});



// POST /query-finetune endpoint - AI dispatcher controlled
router.post('/query-finetune', async (req, res) => {
  console.log('🎯 /query-finetune endpoint called - routing to AI dispatcher');
  
  try {
    const result = await modelControlHooks.handleApiRequest(
      '/query-finetune',
      'POST',
      req.body,
      {
        userId: req.headers['x-user-id'] as string || 'default',
        sessionId: req.headers['x-session-id'] as string || 'default',
        source: 'api',
        metadata: { headers: req.headers }
      }
    );

    if (result.success) {
      // Try to parse structured response
      try {
        const parsed = JSON.parse(result.response || '{}');
        res.json(parsed);
      } catch {
        res.json({
          response: result.response,
          success: true,
          timestamp: new Date().toISOString(),
          aiControlled: true
        });
      }
    } else {
      sendErrorResponse(res, 500, result.error || 'Query finetune failed');
    }

  } catch (error: any) {
    handleCatchError(res, error, 'Query finetune');
  }
});

// POST /ask endpoint - AI dispatcher controlled (fallback route)
router.post('/ask', async (req, res) => {
  console.log('📝 /ask endpoint called - routing to AI dispatcher');
  
  try {
    const result = await modelControlHooks.handleApiRequest(
      '/ask',
      'POST',
      req.body,
      {
        userId: req.headers['x-user-id'] as string || 'default',
        sessionId: req.headers['x-session-id'] as string || 'default',
        source: 'api',
        metadata: { headers: req.headers }
      }
    );

    handleServiceResult(res, result, 'Ask endpoint processed successfully');

  } catch (error: any) {
    handleCatchError(res, error, 'Ask endpoint');
  }
});

// POST endpoint for natural language inputs - AI dispatcher controlled
router.post('/', async (req, res) => {
  console.log('🚀 Main endpoint called - routing to AI dispatcher');
  
  const { message } = req.body;
  const userId = req.headers['x-user-id'] as string || 'default';
  const sessionId = req.headers['x-session-id'] as string || 'default';
  
  if (!message) {
    return sendErrorResponse(res, 400, 'Message is required');
  }

  try {
    // Route all requests through AI dispatcher
    const result = await modelControlHooks.handleApiRequest(
      '/',
      'POST',
      req.body,
      {
        userId,
        sessionId,
        source: 'api',
        metadata: { headers: req.headers }
      }
    );

    if (result.success) {
      res.send(result.response);
    } else {
      sendErrorResponse(res, 500, result.error || 'AI dispatcher error', `Echo: ${message}`);
    }
    
  } catch (error: any) {
    console.error('❌ Error processing message:', error);
    sendErrorResponse(res, 500, 'AI dispatcher error', `Echo: ${message}`);
  }
});

// Root route - serve dashboard index (this should be last to avoid conflicts)
router.get('/', (_req, res) => {
  const publicDir = path.join(__dirname, '../../public');
  res.sendFile(path.join(publicDir, 'index.html'));
});

export default router;