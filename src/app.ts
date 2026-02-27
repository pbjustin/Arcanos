import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from "@platform/runtime/config.js";
import { setupDiagnostics } from "@core/diagnostics.js";
import { registerRoutes } from "@routes/register.js";
import { initOpenAI } from "@core/init-openai.js";
import { createFallbackMiddleware, createHealthCheckMiddleware } from "@transport/http/middleware/fallbackHandler.js";
import { unsafeExecutionGate } from "@transport/http/middleware/unsafeExecutionGate.js";
import errorHandler from "@transport/http/middleware/errorHandler.js";
import requestContext from './middleware/requestContext.js';
import getGptModuleMap from '@platform/runtime/gptRouterConfig.js';
import { getEnv } from '@platform/runtime/env.js';

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
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(unsafeExecutionGate);
  app.use(createHealthCheckMiddleware());
  initOpenAI(app);
  Object.defineProperty(app.locals, 'openai', {
    writable: false,
    configurable: false,
  });

  app.get('/healthz', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const gptMap = await getGptModuleMap();
      res.json({
        ok: true,
        gptMapSize: Object.keys(gptMap).length,
        hasOpenAIKey: hasConfiguredOpenAIKey(),
        env: getEnv('NODE_ENV') || 'development'
      });
    } catch (error) {
      //audit Assumption: health endpoint should fail loudly when registry load fails; failure risk: hidden misconfiguration; expected invariant: health check reflects startup/runtime integrity; handling strategy: delegate to global error middleware.
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

  app.use((_: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  return app;
}

export const app = createApp();
