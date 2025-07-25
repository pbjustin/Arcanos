// ARCANOS AI Routes - AI-controlled endpoints extracted for modularity
import { Router } from 'express';
import path from 'path';
import { modelControlHooks } from '../services/model-control-hooks';
import { requireArcanosToken } from '../middleware/api-token';

const router = Router();

// Fine-tune routing status endpoint
router.get('/finetune-status', async (req, res) => {
  const userId = req.headers['x-user-id'] as string || 'default';
  const sessionId = req.headers['x-session-id'] as string || 'default';
  
  try {
    const { fineTuneRoutingService } = await import('../services/finetune-routing');
    
    const isActive = await fineTuneRoutingService.isFineTuneRoutingActive(userId, sessionId);
    const statusMessage = await fineTuneRoutingService.getStatusMessage(userId, sessionId);
    
    res.json({
      active: isActive,
      message: statusMessage,
      userId,
      sessionId,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to get fine-tune routing status',
      details: error.message
    });
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

    if (result.success) {
      res.status(200).json({ 
        success: true, 
        message: result.response 
      });
    } else {
      res.status(500).json({ 
        error: result.error,
        success: false 
      });
    }

  } catch (err: any) {
    console.error('❌ Webhook error:', err);
    res.status(500).json({ 
      error: 'Internal webhook error',
      details: err.message 
    });
  }
});

// Simplified diagnostic endpoint - AI controlled
router.get('/sync/diagnostics', async (req, res) => {
  const token = req.headers['authorization'];
  const gptToken = `Bearer ${process.env.GPT_TOKEN}`;
  const apiToken = `Bearer ${process.env.ARCANOS_API_TOKEN}`;
  if (token !== gptToken && token !== apiToken) {
    return res.status(403).json({ error: "Unauthorized access" });
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
      res.status(500).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('❌ Diagnostics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /query-finetune endpoint - AI dispatcher controlled (requires ARCANOS token)
router.post('/query-finetune', requireArcanosToken, async (req, res) => {
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
      res.status(500).json({
        error: result.error,
        success: false,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error: any) {
    console.error('❌ Error in /query-finetune:', error.message);
    res.status(500).json({
      error: 'AI dispatcher error',
      details: error.message,
      success: false,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /ask endpoint - AI dispatcher controlled (requires ARCANOS token)
router.post('/ask', requireArcanosToken, async (req, res) => {
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

    if (result.success) {
      res.json({ response: result.response });
    } else {
      res.status(500).json({ error: result.error });
    }

  } catch (error: any) {
    console.error('❌ Error in /ask:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST endpoint for natural language inputs - AI dispatcher controlled
router.post('/', async (req, res) => {
  console.log('🚀 Main endpoint called - routing to AI dispatcher');
  
  const { message } = req.body;
  const userId = req.headers['x-user-id'] as string || 'default';
  const sessionId = req.headers['x-session-id'] as string || 'default';
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
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
      res.status(500).json({ 
        error: result.error,
        response: `Echo: ${message}` // Fallback response
      });
    }
    
  } catch (error: any) {
    console.error('❌ Error processing message:', error);
    res.status(500).json({ 
      error: 'AI dispatcher error',
      response: `Echo: ${message}` // Fallback response
    });
  }
});

// Root route - serve dashboard index (this should be last to avoid conflicts)
router.get('/', (_req, res) => {
  const publicDir = path.join(__dirname, '../../public');
  res.sendFile(path.join(publicDir, 'index.html'));
});

export default router;