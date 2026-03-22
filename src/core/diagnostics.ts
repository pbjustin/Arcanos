import type { Application, Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import cron from 'node-cron';
import { runHealthCheck } from "@platform/logging/diagnostics.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { config } from "@platform/runtime/config.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  isDiagnosticsProtected,
  type DiagnosticsSnapshot,
  runtimeDiagnosticsService
} from '@services/runtimeDiagnosticsService.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

export interface DiagnosticsAccessDecision {
  authorized: boolean;
  protected: boolean;
}

/**
 * Registers health check endpoint and monitoring cron job.
 */
export function setupDiagnostics(app: Express): void {
  // Use config layer for env access (adapter boundary pattern)
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
    const access = authorizeDiagnosticsRequest(req);
    if (!access.authorized) {
      res.status(404).json({
        error: 'Not Found'
      });
      return;
    }

    try {
      const diagnostics = await getDiagnosticsSnapshot(app);
      req.logger?.info?.('diagnostics.response', {
        protected: isDiagnosticsProtected(),
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

export function authorizeDiagnosticsRequest(
  req: Pick<Request, 'header' | 'logger'>
): DiagnosticsAccessDecision {
  const expectedToken =
    getEnv('DIAGNOSTICS_BEARER_TOKEN')?.trim() ||
    getEnv('MCP_BEARER_TOKEN')?.trim() ||
    getEnv('DEBUG_WATCHDOG_KEY')?.trim();
  const bearerHeader = req.header('authorization');
  const headerToken = req.header('x-diagnostics-token')?.trim();
  const providedBearerToken =
    bearerHeader && bearerHeader.startsWith('Bearer ')
      ? bearerHeader.slice('Bearer '.length).trim()
      : null;
  const providedToken = providedBearerToken || headerToken || '';

  if (expectedToken && !timingSafeStringEqual(providedToken, expectedToken)) {
    req.logger?.warn?.('diagnostics.access.denied', {
      protected: true
    });
    return {
      authorized: false,
      protected: true
    };
  }

  if (!expectedToken && config.server.environment === 'production') {
    req.logger?.warn?.('diagnostics.access.public', {
      protected: false
    });
  }

  return {
    authorized: true,
    protected: Boolean(expectedToken)
  };
}

export function getDiagnosticsSnapshot(app: Application): Promise<DiagnosticsSnapshot> {
  return runtimeDiagnosticsService.getDiagnosticsSnapshot(app);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
