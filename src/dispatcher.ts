// PATCH: Improve dispatcher fallback handling and Codex async stability
// Ensures smooth routing for Codex and audit-mode diagnostics

import { Request, Response } from 'express';
import { handleCodexPrompt } from './services/codex';
import { handleAudit } from './services/audit';
import { diagnosticsService } from './services/diagnostics';
import { handleLogic as handleGenericLogic } from './routes/logic';
import { installNLPInterpreter, getNLPInterpreter } from './modules/nlp-interpreter';

// Install NLP interpreter with default configuration
installNLPInterpreter({
  enablePromptTranslation: true,
  autoResolveIntents: true,
  fallbackToStructuredMode: true,
});

export async function dispatcher(req: Request, res: Response) {
  try {
    const { type, mode = 'default', message = '' } = req.body || {};
    let routeType = type;

    if (!routeType) {
      const nlp = getNLPInterpreter();
      if (nlp) {
        const parsed = nlp.parse(message);
        routeType = parsed.intent !== 'unknown' ? parsed.intent : 'logic';
      } else {
        routeType = 'logic';
      }
    }

    switch (routeType) {
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

      case 'diagnostic':
        return res.json({
          status: '🩺 Diagnostic processed',
          result: await diagnosticsService.executeDiagnosticCommand(message || 'system health'),
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
      trace: err.stack,
    });
  }
}
