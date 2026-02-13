import { Request, Response } from 'express';
import { saveMessage, getChannel, getConversation, type SessionMessage } from "@services/sessionMemoryService.js";
import { requireField } from "@shared/validation.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

/**
 * Helper function to normalize message input
 */
function normalizeMessage(message: SessionMessage): { role: string; content: string } | null {
  const clean = typeof message === 'string'
    ? { role: 'user', content: message.trim() }
    : {
        role: typeof message.role === 'string' ? message.role : 'user',
        content: typeof message.content === 'string' ? message.content.trim() : '',
      };

  return clean.content ? clean : null;
}

/**
 * Helper function to extract message metadata
 */
function extractMessageMeta(message: SessionMessage, timestamp: number): Record<string, unknown> {
  return {
    tokens: typeof message === 'object' && message && typeof message.tokens === 'number' ? message.tokens : 0,
    audit_tag: typeof message === 'object' && message && typeof message.tag === 'string' ? message.tag : 'unspecified',
    timestamp,
  };
}

/**
 * Helper function to handle session memory save validation
 */
function validateSaveRequest(req: Request, res: Response): { sessionId: string; message: SessionMessage } | null {
  const { sessionId, message } = req.body as { sessionId?: string; message?: SessionMessage };
  
  if (!requireField(res, sessionId, 'sessionId') || !requireField(res, message, 'message')) {
    return null;
  }
  // requireField ensures truthy; TS doesn't narrow from it
  return { sessionId: sessionId!, message: message! };
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
    } catch (error: unknown) {
      logger.error('Failed to save session memory', {
        module: 'sessionMemory',
        operation: 'saveDual',
        sessionId,
        error: resolveErrorMessage(error)
      });

      res.status(500).json({ error: 'Failed to save message' });
    }
  },

  getCore: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    
    try {
      const data = await getChannel(sessionId, 'conversations_core');
      res.json(data);
    } catch (error: unknown) {
      logger.error('Failed to get core session data', {
        module: 'sessionMemory',
        operation: 'getCore',
        sessionId,
        error: resolveErrorMessage(error)
      });

      res.status(500).json({ error: 'Failed to retrieve core data' });
    }
  },

  getMeta: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    
    try {
      const data = await getChannel(sessionId, 'system_meta');
      res.json(data);
    } catch (error: unknown) {
      logger.error('Failed to get meta session data', {
        module: 'sessionMemory',
        operation: 'getMeta',
        sessionId,
        error: resolveErrorMessage(error)
      });

      res.status(500).json({ error: 'Failed to retrieve meta data' });
    }
  },

  getFull: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    
    try {
      const data = await getConversation(sessionId);
      res.json(data);
    } catch (error: unknown) {
      logger.error('Failed to get full conversation', {
        module: 'sessionMemory',
        operation: 'getFull',
        sessionId,
        error: resolveErrorMessage(error)
      });

      res.status(500).json({ error: 'Failed to retrieve conversation' });
    }
  }
};
