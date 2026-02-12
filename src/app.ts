import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from "@platform/runtime/config.js";
import { requestLoggingMiddleware, logger } from "@platform/logging/structuredLogging.js";
import { setupDiagnostics } from "@core/diagnostics.js";
import { registerRoutes } from "@routes/register.js";
import { initOpenAI } from "@core/init-openai.js";
import { createFallbackMiddleware, createHealthCheckMiddleware } from "@transport/http/middleware/fallbackHandler.js";
import errorHandler from "@transport/http/middleware/errorHandler.js";

/**
 * Creates and configures the Express application.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors(config.cors));
  app.use(express.json({ limit: config.limits.jsonLimit }));
  app.use(express.urlencoded({ extended: true }));

  app.use(requestLoggingMiddleware);
  app.use(unsafeExecutionGate);
  app.use(createHealthCheckMiddleware()); // Add health check middleware for AI endpoints
  initOpenAI(app);
  Object.defineProperty(app.locals, 'openai', {
    writable: false,
    configurable: false,
  });

  setupDiagnostics(app);
  registerRoutes(app);

  // Add fallback middleware before global error handler
  app.use(createFallbackMiddleware());

  // Global error handler
  app.use(errorHandler);

  // 404 handler
  app.use((_: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  return app;
}
