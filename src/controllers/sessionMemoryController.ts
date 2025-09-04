import { Request, Response } from 'express';
import { saveMessage, getChannel } from '../services/sessionMemoryService.js';
import { requireField } from '../utils/validation.js';

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
