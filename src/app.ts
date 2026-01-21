import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import config from './config/index.js';
import { requestLoggingMiddleware, logger } from './utils/structuredLogging.js';
import { setupDiagnostics } from './diagnostics.js';
import { registerRoutes } from './routes/register.js';
import { initOpenAI } from './init-openai.js';
import { createFallbackMiddleware, createHealthCheckMiddleware } from './middleware/fallbackHandler.js';

/**
 * Creates and configures the Express application.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors(config.cors));
  app.use(express.json({ limit: config.limits.jsonLimit }));
  app.use(express.urlencoded({ extended: true }));

  app.use(requestLoggingMiddleware);
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
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled application error', {
      module: 'app',
      operation: 'error-handler',
      error: err.message || 'Unknown error',
      status: err.status || 500,
      stack: config.server.environment === 'development' ? err.stack : undefined
    });
    const status = typeof err.status === 'number' ? err.status : 500;
    res.status(status).json({
      error: 'Internal server error',
      message: config.server.environment === 'development' ? err.message : 'Something went wrong'
    });
  });

  // 404 handler
  app.use((_: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  return app;
}
