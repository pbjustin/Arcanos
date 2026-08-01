import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from "@platform/runtime/config.js";
import { setupDiagnostics, writePublicHealthResponse } from "@core/diagnostics.js";
import { registerRoutes } from "@routes/register.js";
import { initOpenAI } from "@core/init-openai.js";
import { createFallbackMiddleware, createHealthCheckMiddleware } from "@transport/http/middleware/fallbackHandler.js";
import { unsafeExecutionGate } from "@transport/http/middleware/unsafeExecutionGate.js";
import errorHandler from "@transport/http/middleware/errorHandler.js";
import { noStoreResponse, requestContext, sendNotFound } from '@shared/http/index.js';
import { withJsonResponseBytes } from '@shared/http/clientResponseGuards.js';
import { arcanosMcpService } from '@services/arcanosMcp.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { startSelfHealingControlLoop } from '@services/selfImprove/controlLoop.js';
import { writeMetricsResponse } from '@platform/observability/appMetrics.js';
import { gamingIngressAudit } from '@transport/http/gamingIngressAudit.js';
import {
  ACTION_PLAN_EXECUTION_BODY_LIMIT,
  isActionPlanExecutionBoundedBodyRoute,
} from '@services/actionPlanExecution/http.js';
import {
  selfHealingControlHttpBoundary,
} from '@services/controlPlane/selfHealingControlHttpBoundary.js';
import {
  selfHealingControlBodyParser,
} from '@services/controlPlane/selfHealingControlBodyParser.js';
import {
  diagnosticExecutionHttpBoundary,
} from '@services/controlPlane/diagnosticExecutionHttpBoundary.js';
import {
  diagnosticExecutionBodyParser,
} from '@services/controlPlane/diagnosticExecutionBodyParser.js';
import {
  legacyOperatorHttpBoundary,
} from '@services/controlPlane/legacyOperatorHttpBoundary.js';
import {
  legacyOperatorBodyParser,
} from '@services/controlPlane/legacyOperatorBodyParser.js';
import {
  systemStateHttpBoundary,
} from '@services/controlPlane/systemStateHttpBoundary.js';
import {
  systemStateBodyParser,
} from '@services/controlPlane/systemStateBodyParser.js';
import {
  ragHttpBoundary,
} from '@services/controlPlane/ragHttpBoundary.js';
import {
  ragBodyParser,
} from '@services/controlPlane/ragBodyParser.js';
import {
  reinforcementHttpBoundary,
} from '@services/controlPlane/reinforcementHttpBoundary.js';
import {
  reinforcementBodyParser,
} from '@services/controlPlane/reinforcementBodyParser.js';
import {
  afolHttpBoundary,
} from '@services/controlPlane/afolHttpBoundary.js';
import {
  afolBodyParser,
} from '@services/controlPlane/afolBodyParser.js';
import {
  assistantRegistryHttpBoundary,
} from '@services/controlPlane/assistantRegistryHttpBoundary.js';
import {
  assistantRegistryBodyParser,
} from '@services/controlPlane/assistantRegistryBodyParser.js';
import {
  dagHttpBoundary,
} from '@services/controlPlane/dagHttpBoundary.js';
import {
  dispatchDagCompatibilityBoundary,
} from '@services/controlPlane/dispatchDagCompatibilityBoundary.js';
import {
  cefHttpBoundary,
} from '@services/controlPlane/cefHttpBoundary.js';
import {
  cefBodyParser,
} from '@services/controlPlane/cefBodyParser.js';
import { requireMemoryPlaneAuth } from '@transport/http/middleware/memoryPlaneAuth.js';
import { publicProviderAdmission } from '@transport/http/middleware/publicProviderAdmission.js';
import { canonicalGptIdentifierBoundary } from '@transport/http/middleware/canonicalGptIdentifierBoundary.js';
import { startConfiguredWorkerRuntime } from '@platform/runtime/workerConfig.js';
import {
  configureDefaultAppMetricsRuntimeProviders
} from '@services/appMetricsRuntimeProviders.js';
import {
  configureDefaultArcanosCoreRuntimeProviders
} from '@services/arcanosCoreRuntimeProviders.js';

const SERVICE_NAME = 'arcanos-backend';
const SERVICE_VERSION = '1.0.0';
const startedRuntimeApps = new WeakSet<Express>();

/**
 * Start background application runtime exactly once after startup readiness.
 * Route construction stays side-effect free with respect to external
 * dependencies, allowing the HTTP listener to bind before dependency recovery.
 */
export function startAppRuntimeOnce(app: Express): boolean {
  if (startedRuntimeApps.has(app)) {
    return false;
  }

  startedRuntimeApps.add(app);
  void startConfiguredWorkerRuntime();
  startSelfHealingControlLoop(app);
  void runtimeDiagnosticsService.logStartupSummary(app);
  return true;
}

/**
 * Creates and configures the Express application.
 */
export function createApp(): Express {
  configureDefaultAppMetricsRuntimeProviders();
  configureDefaultArcanosCoreRuntimeProviders();
  const app = express();
  const gptFallbackBodyParser = express.text({
    type: () => true,
    limit: config.limits.jsonLimit
  });
  const actionPlanExecutionBodyParser = express.json({
    limit: ACTION_PLAN_EXECUTION_BODY_LIMIT,
    strict: true,
  });

  app.use(requestContext);
  app.use('/jobs', noStoreResponse);
  // CORS answers preflight requests without calling later middleware. Establish
  // the exact CEF trust boundary first so OPTIONS cannot bypass authentication;
  // authorized, supported requests continue through the shared CORS policy.
  app.use('/api/commands', cefHttpBoundary);
  app.use('/api/agent', cefHttpBoundary);
  app.use('/api/commands', cefBodyParser);
  app.use('/api/agent', cefBodyParser);
  // Feedback ingestion and reinforcement-memory inspection are operator-only.
  // Establish identity, scope, and strict route-specific body bounds before
  // CORS or either broad application parser can handle these exact namespaces.
  app.use('/reinforce', reinforcementHttpBoundary);
  app.use('/audit', reinforcementHttpBoundary);
  app.use('/reinforcement', reinforcementHttpBoundary);
  app.use('/memory', reinforcementHttpBoundary);
  app.use('/reinforce', reinforcementBodyParser);
  app.use('/audit', reinforcementBodyParser);
  app.use('/reinforcement', reinforcementBodyParser);
  app.use('/memory', reinforcementBodyParser);
  // AFOL inspection and provider-backed decisions are operator-only. Establish
  // identity, operation scope, and the strict decision body cap before CORS or
  // the broad application parsers can allocate or expose retained records.
  app.use('/api/afol', afolHttpBoundary);
  app.use('/api/afol', afolBodyParser);
  // Assistant-registry reads and the confirmed provider-backed synchronization
  // are direct control-plane operations. Authenticate and strictly bound the
  // exact namespace before CORS or broad application parsing.
  app.use('/api/assistants', assistantRegistryHttpBoundary);
  app.use('/api/assistants', assistantRegistryBodyParser);
  app.use(cors(config.cors));
  // Memory and durable-session payloads share one trust domain. Authenticate
  // every HTTP prefix before broad parsers can allocate or expose stored data.
  app.use('/api/memory', requireMemoryPlaneAuth);
  app.use('/api/save-conversation', requireMemoryPlaneAuth);
  app.use('/api/sessions', requireMemoryPlaneAuth);
  // Model- and subprocess-backed diagnostics are operator control-plane work.
  // Authenticate, authorize, throttle, and serialize them before body parsing.
  app.use('/devops/self-test', diagnosticExecutionHttpBoundary);
  app.use('/devops/daily-summary', diagnosticExecutionHttpBoundary);
  app.use('/api/pr-analysis/analyze', diagnosticExecutionHttpBoundary);
  app.use('/devops/self-test', diagnosticExecutionBodyParser);
  app.use('/devops/daily-summary', diagnosticExecutionBodyParser);
  app.use('/api/pr-analysis/analyze', diagnosticExecutionBodyParser);
  // Legacy SDK and orchestration routes retain confirmation as approval only;
  // caller identity and scope are established before their request bodies.
  app.use('/sdk', legacyOperatorHttpBoundary);
  app.use('/orchestration/reset', legacyOperatorHttpBoundary);
  app.use('/orchestration/purge', legacyOperatorHttpBoundary);
  app.use('/orchestration/status', legacyOperatorHttpBoundary);
  app.use('/sdk', legacyOperatorBodyParser);
  app.use('/orchestration/reset', legacyOperatorBodyParser);
  app.use('/orchestration/purge', legacyOperatorBodyParser);
  // System-state is a direct control-plane surface. Establish operator identity,
  // method-specific scope, and a bounded body before the broad application parser.
  app.use('/system-state', systemStateHttpBoundary);
  app.use('/system-state', systemStateBodyParser);
  // Direct RAG traffic can fetch, persist, retrieve, and invoke paid providers.
  // Establish operator trust and operation-specific bounds before broad parsing.
  app.use('/rag', ragHttpBoundary);
  app.use('/rag', ragBodyParser);
  // DAG runs are paid, persistent control-plane work. Establish the operator
  // principal and method-specific scope before the broad application parser.
  app.use('/api/arcanos/dag', dagHttpBoundary);
  // Self-healing control traffic is authenticated and client-throttled before
  // the broad JSON parser can allocate for an unauthenticated request body.
  app.use('/api/self-heal', selfHealingControlHttpBoundary);
  app.use('/api/self-improve', selfHealingControlHttpBoundary);
  app.use('/status/safety/self-heal', selfHealingControlHttpBoundary);
  app.use('/status/safety/quarantine', selfHealingControlHttpBoundary);
  app.use('/api/self-heal/decide', selfHealingControlBodyParser);
  app.use('/api/self-improve', selfHealingControlBodyParser);
  app.use('/status/safety/quarantine', selfHealingControlBodyParser);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isActionPlanExecutionBoundedBodyRoute(req.method, req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const contentLength = req.header('content-length');
    const hasBody = req.header('transfer-encoding') !== undefined
      || (contentLength !== undefined && Number(contentLength) > 0);
    const contentType = req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (hasBody && contentType !== 'application/json') {
      res.status(400).json({
        ok: false,
        error: {
          code: 'ACTION_PLAN_EXECUTION_REQUEST_INVALID',
          message: 'ActionPlan execution request is invalid.',
        },
        ...(req.requestId ? { request_id: req.requestId } : {}),
        ...(req.traceId ? { trace_id: req.traceId } : {}),
      });
      return;
    }
    actionPlanExecutionBodyParser(req, res, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }

      const parserStatus = error && typeof error === 'object'
        ? (error as { status?: unknown; statusCode?: unknown; type?: unknown })
        : {};
      const statusCode = parserStatus.type === 'entity.too.large'
        || parserStatus.status === 413
        || parserStatus.statusCode === 413
        ? 413
        : 400;

      try {
        req.logger?.warn('action_plan_execution.request_rejected', {
          errorCode: 'ACTION_PLAN_EXECUTION_REQUEST_INVALID',
          statusCode,
          requestId: req.requestId,
          traceId: req.traceId,
        });
      } catch {
        // Diagnostics must not alter the fixed public parser response.
      }

      res.status(statusCode).json({
        ok: false,
        error: {
          code: 'ACTION_PLAN_EXECUTION_REQUEST_INVALID',
          message: 'ActionPlan execution request is invalid.',
        },
        ...(req.requestId ? { request_id: req.requestId } : {}),
        ...(req.traceId ? { trace_id: req.traceId } : {}),
      });
    });
  });
  app.use(express.json({ limit: config.limits.jsonLimit }));
  app.use(express.urlencoded({ extended: true }));
  app.post('/dispatch', dispatchDagCompatibilityBoundary);
  app.use('/gpt', (req: Request, res: Response, next: NextFunction) => {
    if (req.body !== undefined) {
      next();
      return;
    }

    gptFallbackBodyParser(req, res, next);
  });
  app.use('/gpt', (req: Request, _res: Response, next: NextFunction) => {
    if (req.body === undefined) {
      req.body = {};
    }
    next();
  });
  app.post('/gpt/:gptId', canonicalGptIdentifierBoundary);
  app.use(publicProviderAdmission);
  app.post('/gpt/arcanos-gaming', gamingIngressAudit);

  app.use(unsafeExecutionGate);
  app.use(createHealthCheckMiddleware());
  initOpenAI(app);
  Object.defineProperty(app.locals, 'openai', {
    writable: false,
    configurable: false,
  });
  Object.defineProperty(app.locals, 'arcanosMcp', {
    value: arcanosMcpService,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  app.get('/healthz', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await writePublicHealthResponse(req, res);
    } catch (error) {
      //audit Assumption: health endpoint should fail loudly when registry load fails; failure risk: hidden misconfiguration; expected invariant: health check reflects startup/runtime integrity; handling strategy: delegate to global error middleware.
      next(error);
    }
  });

  app.get('/diag/ping', (req: Request, res: Response) => {
    const payload = withJsonResponseBytes({
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
      version: SERVICE_VERSION,
    });
    req.logger?.info('diag.ping.response', {
      responseBytes: payload.response_bytes,
    });
    res.setHeader('x-response-bytes', String(payload.response_bytes));
    res.json(payload);
  });

  app.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await writeMetricsResponse(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.post('/diag/echo', (req: Request, res: Response) => {
    const body = typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};

    const gptId = typeof body.gptId === 'string' ? body.gptId : null;

    res.json({
      ok: true,
      bodyKeys: Object.keys(body),
      gptId,
      requestId: req.requestId ?? null
    });
  });

  setupDiagnostics(app);
  registerRoutes(app);

  app.use(createFallbackMiddleware());
  app.use(errorHandler);

  app.use((req: Request, res: Response) => {
    //audit Assumption: missing `/api/*` endpoints must return machine-verifiable JSON instead of narrative fallbacks; failure risk: clients infer nonexistent features from generic HTML/text errors; expected invariant: API misses always produce explicit JSON; handling strategy: emit a structured missing payload for `/api/*` and preserve the legacy fallback elsewhere.
    if (req.path.startsWith('/api/')) {
      res.status(404).json({
        error: 'Route Not Found',
        code: 404
      });
      return;
    }

    sendNotFound(res, 'Endpoint not found');
  });

  return app;
}

export const app = createApp();
