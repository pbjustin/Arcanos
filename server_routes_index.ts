import type { Application } from 'express';
import type { MemoryStorage } from '../storage/memory-storage';
import type { ArcanosRAG } from '../modules/rag';
import type { HRCCore } from '../modules/hrc';
import type { ArcanosConfig } from '../config/arcanos-config';
import { requireAuth, requireRole } from '../middleware/index';

interface ServerComponents {
  memoryStorage: MemoryStorage;
  arcanosConfig: ArcanosConfig;
  ragModule: ArcanosRAG;
  hrcCore: HRCCore;
}

export function registerRoutes(app: Application, components: ServerComponents) {
  const { memoryStorage, arcanosConfig, ragModule, hrcCore } = components;

  // Authentication routes
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const user = await memoryStorage.authenticateUser(username, password);
      if (user) {
        req.login(user, (err) => {
          if (err) {
            return res.status(500).json({ error: 'Login failed' });
          }
          res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
        });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    } catch (error) {
      res.status(500).json({ error: 'Authentication error' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  // Main ARCANOS endpoint
  app.post('/api/ask', async (req, res) => {
    const { message, domain = 'general', useRAG = true, useHRC = true } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    try {
      let response = message;
      let ragContext = null;
      let hrcValidation = null;

      // RAG enhancement
      if (useRAG && ragModule.status === 'active') {
        const ragResponse = await ragModule.query({
          query: message,
          domain,
          userId: req.user?.id,
          sessionId: req.sessionID
        });
        if (ragResponse.success) {
          ragContext = ragResponse.data;
          response = ragResponse.data.answer;
        }
      }

      // HRC validation
      if (useHRC && hrcCore.status === 'active') {
        const validation = await hrcCore.validate(response, {
          query: message,
          domain,
          userId: req.user?.id,
          sessionId: req.sessionID
        });
        if (validation.success) {
          hrcValidation = validation.data;
        }
      }

      // Log the request
      await memoryStorage.logRequest({
        method: req.method,
        endpoint: req.originalUrl,
        userId: req.user?.id,
        sessionId: req.sessionID,
        timestamp: new Date(),
        responseTime: 0,
        statusCode: 200,
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip,
        requestSize: JSON.stringify(req.body).length,
        responseSize: 0,
        cached: false
      });

      res.json({
        success: true,
        response,
        metadata: {
          timestamp: new Date().toISOString(),
          domain,
          ragUsed: !!ragContext,
          hrcUsed: !!hrcValidation,
          ragContext,
          hrcValidation
        }
      });
    } catch (error) {
      console.error('[API] Error processing request:', error);
      res.status(500).json({ error: 'Failed to process request' });
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({
      system: 'ARCANOS',
      status: 'active',
      version: '1.0.0',
      modules: {
        config: arcanosConfig.status,
        rag: ragModule.status,
        hrc: hrcCore.status
      },
      stats: memoryStorage.getStorageStats(),
      timestamp: new Date().toISOString()
    });
  });

  // Memory management
  app.get('/api/memory', requireAuth, async (req, res) => {
    try {
      const memories = await memoryStorage.getMemoriesByUser(req.user.id);
      res.json({ success: true, memories });
    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve memories' });
    }
  });

  app.post('/api/memory', requireAuth, async (req, res) => {
    const { key, value, type = 'context', tags = [], ttl } = req.body;
    try {
      const memory = await memoryStorage.storeMemory(
        req.user.id,
        req.sessionID,
        type,
        key,
        value,
        tags,
        ttl
      );
      res.json({ success: true, memory });
    } catch (error) {
      res.status(500).json({ error: 'Failed to store memory' });
    }
  });

  // Configuration endpoints
  app.get('/api/config', requireAuth, requireRole('admin'), (req, res) => {
    res.json({
      success: true,
      config: arcanosConfig.getConfig()
    });
  });

  app.post('/api/config', requireAuth, requireRole('admin'), (req, res) => {
    const { config, reason = 'API update' } = req.body;
    const result = arcanosConfig.updateConfig(config, reason);
    res.json(result);
  });

  // RAG endpoints
  app.post('/api/rag/query', async (req, res) => {
    const { query, domain } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    const result = await ragModule.query({
      query,
      domain,
      userId: req.user?.id,
      sessionId: req.sessionID
    });
    res.json(result);
  });

  app.post('/api/rag/documents', requireAuth, requireRole('admin'), async (req, res) => {
    const { content, metadata } = req.body;
    const result = await ragModule.addDocument(content, metadata);
    res.json(result);
  });

  // HRC endpoints
  app.post('/api/hrc/validate', async (req, res) => {
    const { text, context, options } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const result = await hrcCore.validate(text, context, options);
    res.json(result);
  });

  // Logs and analytics
  app.get('/api/logs', requireAuth, requireRole('admin'), async (req, res) => {
    const { limit = 100 } = req.query;
    try {
      const requests = await memoryStorage.getRequests(Number(limit));
      res.json({ success: true, requests });
    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve logs' });
    }
  });

  // Admin endpoints
  app.get('/api/admin/stats', requireAuth, requireRole('admin'), (req, res) => {
    res.json({
      success: true,
      stats: memoryStorage.getStorageStats(),
      modules: {
        config: {
          name: arcanosConfig.name,
          status: arcanosConfig.status,
          enabledModules: arcanosConfig.getEnabledModules()
        },
        rag: {
          name: ragModule.name,
          status: ragModule.status
        },
        hrc: {
          name: hrcCore.name,
          status: hrcCore.status
        }
      }
    });
  });
}