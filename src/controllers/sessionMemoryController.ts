import { Request, Response } from 'express';
import { saveMessage, getChannel, getConversation } from '../services/sessionMemoryService.js';
import { requireField } from '../utils/validation.js';
import { logger } from '../utils/structuredLogging.js';

/**
 * Helper function to normalize message input
 */
function normalizeMessage(message: any): { role: string; content: string } | null {
  const clean = typeof message === 'string'
    ? { role: 'user', content: message.trim() }
    : {
        role: message.role || 'user',
        content: (message.content || '').trim(),
      };

  return clean.content ? clean : null;
}

/**
 * Helper function to extract message metadata
 */
function extractMessageMeta(message: any, timestamp: number): Record<string, any> {
  return {
    tokens: typeof message === 'object' && message.tokens ? message.tokens : 0,
    audit_tag: typeof message === 'object' && message.tag ? message.tag : 'unspecified',
    timestamp,
  };
}

/**
 * Helper function to handle session memory save validation
 */
function validateSaveRequest(req: Request, res: Response): { sessionId: string; message: any } | null {
  const { sessionId, message } = req.body;
  
  if (!requireField(res, sessionId, 'sessionId') || !requireField(res, message, 'message')) {
    return null;
  }

  return { sessionId, message };
}

export const sessionMemoryController = {
  saveDual: async (req: Request, res: Response) => {
    const validation = validateSaveRequest(req, res);
    if (!validation) return;

    const { sessionId, message } = validation;
    const normalizedMessage = normalizeMessage(message);
    
    if (!normalizedMessage) {
      res.status(400).json({ error: 'message content is required' });
      return;
    }

    const timestamp = Date.now();
    const meta = extractMessageMeta(message, timestamp);

    try {
      await saveMessage(sessionId, 'conversations_core', { ...normalizedMessage, timestamp });
      await saveMessage(sessionId, 'system_meta', meta);

      logger.info('Session memory saved', {
        module: 'sessionMemory',
        operation: 'saveDual',
        sessionId,
        role: normalizedMessage.role,
        contentLength: normalizedMessage.content.length
      });

      res.status(200).json({ status: 'saved' });
    } catch (error) {
      logger.error('Failed to save session memory', {
        module: 'sessionMemory',
        operation: 'saveDual',
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      res.status(500).json({ error: 'Failed to save message' });
    }
  },

  getCore: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    
    try {
      const data = await getChannel(sessionId, 'conversations_core');
      res.json(data);
    } catch (error) {
      logger.error('Failed to get core session data', {
        module: 'sessionMemory',
        operation: 'getCore',
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      res.status(500).json({ error: 'Failed to retrieve core data' });
    }
  },

  getMeta: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    
    try {
      const data = await getChannel(sessionId, 'system_meta');
      res.json(data);
    } catch (error) {
      logger.error('Failed to get meta session data', {
        module: 'sessionMemory',
        operation: 'getMeta',
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      res.status(500).json({ error: 'Failed to retrieve meta data' });
    }
  },

  getFull: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    
    try {
      const data = await getConversation(sessionId);
      res.json(data);
    } catch (error) {
      logger.error('Failed to get full conversation', {
        module: 'sessionMemory',
        operation: 'getFull',
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      res.status(500).json({ error: 'Failed to retrieve conversation' });
    }
  }
};
