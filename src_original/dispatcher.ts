// PATCH: AI-Enhanced Service Dispatcher with fallback prevention
// Implements AI-defined logic for service routing with manual override controls
// Ensures smooth routing for Codex, audit-mode diagnostics, and AI-bound services

import { Request, Response } from 'express';
import { handleCodexPrompt } from './services/codex.js';
import { handleAudit } from './services/audit.js';
import { diagnosticsService } from './services/diagnostics.js';
import { handleLogic as handleGenericLogic } from './routes/logic.js';
import { installNLPInterpreter, getNLPInterpreter } from './modules/nlp-interpreter.js';
import { installPagedOutputHandler, getPagedOutputHandler } from './modules/paged-output-handler.js';
import { installMemoryAuditStreamSerializer } from './modules/memory-audit-stream-serializer.js';
import dispatchService, { type ServiceTask, createManualOverrideTask, requiresAIRouting } from './services/ai-service-dispatcher.js';
import { runDeepResearch } from './modules/deepResearchHandler.js';

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

// Install memory & audit streaming serializer
installMemoryAuditStreamSerializer({
  streamChunks: true,
  maxChunkSize: 2048,
  useContinuationTokens: true,
});

export async function dispatcher(req: Request, res: Response) {
  try {
    const { type, mode = 'default', message = '', service, worker, manualOverride } = req.body || {};
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

    // Direct deep research routing
    if (mode === 'deepresearch') {
      try {
        const result = await runDeepResearch(message, req.body?.context);
        const pages = paged ? paged.paginate(typeof result === 'string' ? result : JSON.stringify(result)) : undefined;
        return res.json({
          status: '🔍 Deep research analysis complete',
          result,
          pages,
        });
      } catch (error: any) {
        return res.status(500).json({
          status: '❌ Deep research failed',
          error: error.message,
        });
      }
    }

    // Handle AI-bound service routing for memory and API services
    if (service && (service === 'memory' || service === 'api')) {
      // Disable fallback to defaultWorker unless manually triggered
      if (worker === 'defaultWorker' && !manualOverride) {
        return res.status(400).json({
          status: '❌ Fallback disabled',
          error: 'Fallback to defaultWorker is disabled. Define a specific worker.',
          service
        });
      }

      const serviceTask: ServiceTask = {
        service,
        worker,
        action: req.body.action,
        data: req.body.data || req.body,
        context: {
          userId: req.body.userId,
          sessionId: req.body.sessionId,
          manualOverride,
          bypassAI: req.body.bypassAI
        }
      };

      // Add manual override logic if needed
      if (manualOverride && worker === 'defaultWorker') {
        console.warn('[OVERRIDE] Executing fallback defaultWorker...');
        const overrideTask = createManualOverrideTask(service, req.body.data, req.body.userId);
        const result = await dispatchService(overrideTask);
        
        return res.json({
          status: '⚠️ Override executed',
          result: result.data,
          route: result.route,
          warning: 'DefaultWorker used via manual override',
          metadata: result.metadata
        });
      }

      // Route memory and API services through AI-bound flows
      const result = await dispatchService(serviceTask);
      const pages = paged ? paged.paginate(typeof result.data === 'string' ? result.data : JSON.stringify(result.data)) : undefined;

      return res.json({
        status: result.success ? '🤖 AI service routed' : '❌ AI routing failed',
        result: result.data,
        error: result.error,
        route: result.route,
        pages,
        metadata: result.metadata
      });
    }

    // Default routing for non-AI-bound services (codex, audit, diagnostic, logic)
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

      case 'memory': {
        // Route memory requests through AI dispatcher
        const serviceTask: ServiceTask = {
          service: 'memory',
          worker: worker || 'memoryWorker',
          action: req.body.action || 'retrieve',
          data: req.body.data || req.body,
          context: {
            userId: req.body.userId,
            sessionId: req.body.sessionId,
            manualOverride
          }
        };

        const result = await dispatchService(serviceTask);
        const pages = paged ? paged.paginate(typeof result.data === 'string' ? result.data : JSON.stringify(result.data)) : undefined;
        
        return res.json({
          status: '🧠 Memory service handled',
          result: result.data,
          route: result.route,
          pages,
          metadata: result.metadata
        });
      }

      case 'api': {
        // Route API requests through AI dispatcher  
        const serviceTask: ServiceTask = {
          service: 'api',
          worker: worker || 'apiWorker',
          action: req.body.action || 'request',
          data: req.body.data || req.body,
          context: {
            userId: req.body.userId,
            sessionId: req.body.sessionId,
            manualOverride
          }
        };

        const result = await dispatchService(serviceTask);
        const pages = paged ? paged.paginate(typeof result.data === 'string' ? result.data : JSON.stringify(result.data)) : undefined;
        
        return res.json({
          status: '🔗 API service handled',
          result: result.data,
          route: result.route,
          pages,
          metadata: result.metadata
        });
      }

      default: {
        // Handle any unrecognized service through error response
        if (service && !requiresAIRouting(service)) {
          return res.status(400).json({
            status: '❌ Service error',
            error: `Unrecognized service: ${service}`,
            availableServices: ['memory', 'api', 'codex', 'audit', 'diagnostic']
          });
        }

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
