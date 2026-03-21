import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from "@platform/runtime/config.js";
import { setupDiagnostics } from "@core/diagnostics.js";
import { registerRoutes } from "@routes/register.js";
import { initOpenAI } from "@core/init-openai.js";
import { createFallbackMiddleware, createHealthCheckMiddleware } from "@transport/http/middleware/fallbackHandler.js";
import { unsafeExecutionGate } from "@transport/http/middleware/unsafeExecutionGate.js";
import errorHandler from "@transport/http/middleware/errorHandler.js";
import { requestContext, sendNotFound } from '@shared/http/index.js';
import { withJsonResponseBytes } from '@shared/http/clientResponseGuards.js';
import getGptModuleMap from '@platform/runtime/gptRouterConfig.js';
import { getEnv } from '@platform/runtime/env.js';
import { arcanosMcpService } from '@services/arcanosMcp.js';

const SERVICE_NAME = 'arcanos-backend';
const SERVICE_VERSION = '1.0.0';

function hasConfiguredOpenAIKey(): boolean {
  const key = getEnv('OPENAI_API_KEY');
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * Creates and configures the Express application.
 */
export function createApp(): Express {
  const app = express();

  app.use(requestContext);
  app.use(cors(config.cors));
  app.use(express.json({ limit: config.limits.jsonLimit }));
  app.use(express.urlencoded({ extended: true }));

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
      const gptMap = await getGptModuleMap();
      const payload = withJsonResponseBytes({
        status: 'ok',
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
        version: SERVICE_VERSION,
        gpt_routes: Object.keys(gptMap).length,
        openai_configured: hasConfiguredOpenAIKey(),
      });
      req.logger?.info('healthz.response', {
        responseBytes: payload.response_bytes,
        gptRoutes: payload.gpt_routes,
      });
      res.setHeader('x-response-bytes', String(payload.response_bytes));
      res.json(payload);
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
