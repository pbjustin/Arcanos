import { Router } from 'express';
import { modelControlHooks } from '../services/model-control-hooks.js';
import { diagnosticsService } from '../services/diagnostics.js';
import { workerStatusService } from '../services/worker-status.js';
import { sendEmail, verifyEmailConnection, getEmailSender, getEmailTransportType } from '../services/email.js';
import { sendEmailIntent } from '../intents/send_email.js';
import { sendEmailAndRespond } from '../intents/send_email_and_respond.js';
import { runValidationPipeline } from '../services/ai-validation-pipeline.js'; // [AI-PATCH: RAG+HRC+CLEAR]
import { handleInternetResult } from '../utils/internet-lookup.js';
import assistantsRouter from './assistants.js';

const router = Router();

// AI-controlled welcome endpoint
router.get('/', async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      '/api',
      'GET',
      {},
      {
        userId: req.headers['x-user-id'] as string || 'anonymous',
        sessionId: req.headers['x-session-id'] as string || 'default',
        source: 'api'
      }
    );

    if (result.success) {
      res.json({
        message: result.response || 'Welcome to ARCANOS API - AI Controlled',
        timestamp: new Date().toISOString(),
        aiControlled: true
      });
    } else {
      res.json({
        message: 'Welcome to ARCANOS API - AI Controlled',
        timestamp: new Date().toISOString(),
        aiControlled: true,
        version: '1.0.0'
      });
    }
  } catch (error) {
    res.json({
      message: 'Welcome to ARCANOS API - AI Controlled',
      timestamp: new Date().toISOString(),
      aiControlled: true,
      version: '1.0.0'
    });
  }
});

// AI-controlled ask endpoint
router.post('/ask', async (req, res) => {
  try {
    const { query, payload = {} } = req.body || {};
    const prompt = payload.prompt || query;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required', aiControlled: true });
    }

    const result = await runValidationPipeline(prompt); // [AI-PATCH: RAG+HRC+CLEAR]

    (req as any).meta = (req as any).meta || {}; // [AI-PATCH: RAG+HRC+CLEAR]
    (req as any).meta.audit = result.audit; // [AI-PATCH: RAG+HRC+CLEAR]
    res.locals.audit = result.audit; // [AI-PATCH: RAG+HRC+CLEAR]

    res.json({
      response: result.output,
      audit: result.audit,
      flagged: result.flagged,
      aiControlled: true,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      aiControlled: true,
      timestamp: new Date().toISOString()
    });
  }
});

// AI-controlled diagnostics endpoint
router.post('/diagnostics', async (req, res) => {
  try {
    const { command, message } = req.body;
    const diagnosticCommand = command || message;
    
    if (!diagnosticCommand) {
      return res.status(400).json({
        error: 'Diagnostic command is required',
        examples: ['Check memory', 'CPU status', 'System health'],
        aiControlled: true
      });
    }

    const result = await diagnosticsService.executeDiagnosticCommand(diagnosticCommand);
    res.json({
      ...result,
      aiControlled: true
    });
    
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      aiControlled: true,
      timestamp: new Date().toISOString()
    });
  }
});

// AI-controlled worker status endpoint
router.get('/workers/status', async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      '/api/workers/status',
      'GET',
      {},
      {
        userId: req.headers['x-user-id'] as string || 'system',
        sessionId: req.headers['x-session-id'] as string || 'default',
        source: 'api'
      }
    );

    if (result.success) {
      const workersStatus = await workerStatusService.getAllWorkersStatus();
      res.json({
        status: workersStatus,
        aiControlled: true,
        aiResponse: result.response,
        timestamp: new Date().toISOString()
      });
    } else {
      const workersStatus = await workerStatusService.getAllWorkersStatus();
      res.json({
        status: workersStatus,
        aiControlled: true,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      aiControlled: true,
      timestamp: new Date().toISOString()
    });
  }
});

// Email service endpoints
router.get('/email/status', async (req, res) => {
  try {
    const isConnected = await verifyEmailConnection();
    const sender = getEmailSender();
    const transportType = getEmailTransportType();
    
    res.json({
      connected: isConnected,
      sender: sender,
      transportType: transportType,
      configured: sender !== 'Not configured',
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      connected: false,
      transportType: 'Unknown',
      timestamp: new Date().toISOString()
    });
  }
});

router.post('/email/send', async (req, res) => {
  try {
    const { to, subject, html, from } = req.body;
    
    if (!to || !subject || !html) {
      return res.status(400).json({
        error: 'Missing required fields: to, subject, html',
        timestamp: new Date().toISOString()
      });
    }

    const result = await sendEmail(to, subject, html, from);
    
    if (result.success) {
      res.json({
        success: true,
        messageId: result.messageId,
        verified: result.verified,
        transportType: result.transportType,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        verified: result.verified,
        transportType: result.transportType,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// External lookup endpoint with RAG + HRC + CLEAR post-processing
router.get('/lookup', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url query parameter is required' });
    }

    const content = await fetch(url).then(r => r.text());
    const result = handleInternetResult(content);
    res.json({ answer: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Intent endpoints
router.post('/intent/send_email', sendEmailIntent);
router.post('/intent/send_email_and_respond', sendEmailAndRespond);

// Mount assistant routes
router.use('/', assistantsRouter);

// Catch-all route - delegate everything to AI
router.use('*', async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      req.originalUrl,
      req.method,
      req.body,
      {
        userId: req.headers['x-user-id'] as string || 'default',
        sessionId: req.headers['x-session-id'] as string || 'default',
        source: 'api',
        metadata: { headers: req.headers }
      }
    );

    if (result.success) {
      res.json({
        response: result.response,
        aiControlled: true,
        endpoint: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(404).json({
        error: 'Endpoint not found or AI processing failed',
        details: result.error,
        aiControlled: true,
        endpoint: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error: any) {
    res.status(500).json({
      error: 'AI processing error',
      details: error.message,
      aiControlled: true,
      endpoint: req.originalUrl,
      method: req.method,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;