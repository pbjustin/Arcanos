import { Request, Response } from 'express';
import { saveMessage, getChannel, getConversation } from '../services/sessionMemoryService.js';
import { requireField } from '../utils/validation.js';
import memoryStore from '../memory/store.js';

export const sessionMemoryController = {
  saveDual: async (req: Request, res: Response) => {
    const { sessionId, message } = req.body;
    if (!requireField(res, sessionId, 'sessionId') || !requireField(res, message, 'message')) {
      return;
    }

    const clean =
      typeof message === 'string'
        ? { role: 'user', content: message.trim() }
        : {
            role: message.role || 'user',
            content: (message.content || '').trim(),
          };

    if (!clean.content) {
      res.status(400).json({ error: 'message content is required' });
      return;
    }

    const timestamp = Date.now();
    const meta = {
      tokens: typeof message === 'object' && message.tokens ? message.tokens : 0,
      audit_tag: typeof message === 'object' && message.tag ? message.tag : 'unspecified',
      timestamp,
    };

    await saveMessage(sessionId, 'conversations_core', { ...clean, timestamp });
    await saveMessage(sessionId, 'system_meta', meta);

    // Keep in-memory session store in sync for semantic resolution
    const conversations_core = await getChannel(sessionId, 'conversations_core');
    memoryStore.saveSession({ sessionId, conversations_core });

    res.status(200).json({ status: 'saved' });
  },

  getCore: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const data = await getChannel(sessionId, 'conversations_core');
    res.json(data);
  },

  getMeta: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const data = await getChannel(sessionId, 'system_meta');
    res.json(data);
  },

  getFull: async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const data = await getConversation(sessionId);
    res.json(data);
  }
};
