// PATCH: Improve dispatcher fallback handling and Codex async stability
// Ensures smooth routing for Codex and audit-mode diagnostics

import { Request, Response } from 'express';
import { handleCodexPrompt } from './services/codex';
import { handleAudit } from './services/audit';
import { handleLogic as handleGenericLogic } from './routes/logic';

export async function dispatcher(req: Request, res: Response) {
  try {
    const { type = 'logic', mode = 'default' } = req.body || {};

    switch (type) {
      case 'codex':
        return res.json({
          status: '✅ Codex handled',
          result: await handleCodexPrompt(req.body),
        });

      case 'audit':
        return res.json({
          status: '🧠 Audit processed',
          result: await handleAudit(req.body),
        });

      default:
        return res.json({
          status: '⚙️ Default logic mode triggered',
          result: await handleGenericLogic(req.body),
        });
    }
  } catch (err: any) {
    return res.status(500).json({
      status: '❌ Dispatcher failure',
      message: err.message,
      stack: err.stack,
    });
  }
}
