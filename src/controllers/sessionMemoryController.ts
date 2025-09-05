import { Request, Response } from 'express';
import { saveMessage, getChannel } from '../services/sessionMemoryService.js';
import { requireField } from '../utils/validation.js';
import memoryStore from '../memory/store.js';

export const sessionMemoryController = {
  saveDual: async (req: Request, res: Response) => {
    const { sessionId, message } = req.body;
    if (!requireField(res, sessionId, 'sessionId') || !requireField(res, message, 'message')) {
      return;
    }

    const clean = {
      role: message.role,
      content: (message.content || '').trim(),
    };

    const meta = {
      tokens: message.tokens || 0,
      audit_tag: message.tag || 'unspecified',
      timestamp: Date.now(),
    };

    await saveMessage(sessionId, 'conversations_core', clean);
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
  }
};
