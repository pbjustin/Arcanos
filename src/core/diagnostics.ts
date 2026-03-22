import type { Application, Express, Request, Response } from 'express';
import cron from 'node-cron';
import { runHealthCheck } from "@platform/logging/diagnostics.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { config } from "@platform/runtime/config.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  type DiagnosticsSnapshot,
  runtimeDiagnosticsService
} from '@services/runtimeDiagnosticsService.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

/**
 * Registers health check endpoint and monitoring cron job.
 */
export function setupDiagnostics(app: Express): void {
  const diagnosticsEnabled =
    config.server.environment !== 'test' &&
    getEnv('DISABLE_DIAGNOSTICS_CRON') !== 'true';

  if (diagnosticsEnabled) {
    cron.schedule('*/5 * * * *', async () => {
      const report = await runHealthCheck();
      logger.info(
        '📡 ARCANOS:HEALTH',
        {
          summary: report.summary,
          status: report.status
        },
        {
          memory: report.components.memory,
          workers: report.components.workers,
          security: report.security,
          metrics: report.metrics,
          telemetry: report.telemetry.metrics,
          resilience: report.resilience.circuitBreaker
        }
      );
    });
  } else {
    logger.debug('Skipping diagnostics cron registration', {
      environment: config.server.environment,
      diagnosticsEnabled,
    });
  }

  app.get('/health', (_req: Request, res: Response) => {
    const payload = runtimeDiagnosticsService.getHealthSnapshot();
    res.set('cache-control', 'no-store, max-age=0');
    res.json(payload);
  });

  app.get('/diagnostics', async (req: Request, res: Response) => {
    try {
      const diagnostics = await getDiagnosticsSnapshot(app);
      req.logger?.info?.('diagnostics.response', {
        protected: false,
        registeredGpts: Array.isArray(diagnostics.registered_gpts)
          ? diagnostics.registered_gpts.length
          : diagnostics.registered_gpts,
        routeCount: Array.isArray(diagnostics.active_routes)
          ? diagnostics.active_routes.length
          : diagnostics.active_routes
      });
      res.set('cache-control', 'no-store, max-age=0');
      res.json(diagnostics);
    } catch (error) {
      logger.error('diagnostics.response.failed', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
      res.status(500).json({
        error: 'Diagnostics unavailable'
      });
    }
  });
}

export function getDiagnosticsSnapshot(app: Application): Promise<DiagnosticsSnapshot> {
  return runtimeDiagnosticsService.getDiagnosticsSnapshot(app);
}
