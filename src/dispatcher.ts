// PATCH: Improve dispatcher fallback handling and Codex async stability
// Ensures smooth routing for Codex and audit-mode diagnostics

import { Request, Response } from 'express';
import { handleCodexPrompt } from './services/codex';
import { handleAudit } from './services/audit';
import { diagnosticsService } from './services/diagnostics';
import { handleLogic as handleGenericLogic } from './routes/logic';
import { installNLPInterpreter, getNLPInterpreter } from './modules/nlp-interpreter';
import { installPagedOutputHandler, getPagedOutputHandler } from './modules/paged-output-handler';

// Install NLP interpreter with default configuration
installNLPInterpreter({
  enablePromptTranslation: true,
  autoResolveIntents: true,
  fallbackToStructuredMode: true,
});

// Install paged output handler for chunked responses
installPagedOutputHandler({
  maxPayloadSize: 2048,
  chunkPrefix: '[LOG]',
  enableContinuationFlag: true,
  syncContextMemory: true,
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

    const paged = getPagedOutputHandler();

    switch (routeType) {
      case 'codex': {
        const result = await handleCodexPrompt(req.body);
        const pages = paged ? paged.paginate(typeof result === 'string' ? result : JSON.stringify(result)) : undefined;
        return res.json({
          status: '✅ Codex handled',
          result,
          pages,
        });
      }

      case 'audit': {
        const result = await handleAudit(req.body);
        const pages = paged ? paged.paginate(typeof result === 'string' ? result : JSON.stringify(result)) : undefined;
        return res.json({
          status: '🧠 Audit processed',
          result,
          pages,
        });
      }

      case 'diagnostic': {
        const result = await diagnosticsService.executeDiagnosticCommand(message || 'system health');
        const pages = paged ? paged.paginate(typeof result === 'string' ? result : JSON.stringify(result)) : undefined;
        return res.json({
          status: '🩺 Diagnostic processed',
          result,
          pages,
        });
      }

      default: {
        const result = await handleGenericLogic(req.body);
        const pages = paged ? paged.paginate(typeof result === 'string' ? result : JSON.stringify(result)) : undefined;
        return res.json({
          status: '⚙️ Default logic mode triggered',
          result,
          pages,
        });
      }
    }
  } catch (err: any) {
    return res.status(500).json({
      status: '❌ Dispatcher failure',
      message: err.message,
      trace: err.stack,
    });
  }
}
