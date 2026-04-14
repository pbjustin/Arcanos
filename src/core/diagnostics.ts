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
import { getGptRegistrySnapshot } from '@platform/runtime/gptRouterConfig.js';
import { withJsonResponseBytes } from '@shared/http/clientResponseGuards.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';

const SERVICE_NAME = 'arcanos-backend';
const SERVICE_VERSION = '1.0.0';

function hasConfiguredOpenAIKey(): boolean {
  const key = getEnv('OPENAI_API_KEY');
  return typeof key === 'string' && key.trim().length > 0;
}

export async function writePublicHealthResponse(req: Request, res: Response): Promise<void> {
  const baseSnapshot = runtimeDiagnosticsService.getHealthSnapshot();
  const { validation } = await getGptRegistrySnapshot();
  const status = validation.missingGptIds.length === 0 ? 'ok' : 'unhealthy';
  const payload = withJsonResponseBytes({
    ...baseSnapshot,
    status,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    gpt_routes: validation.registeredGptCount,
    required_gpts: {
      required: validation.requiredGptIds,
      missing: validation.missingGptIds
    },
    openai_configured: hasConfiguredOpenAIKey(),
  });

  req.logger?.info?.('health.response', {
    responseBytes: payload.response_bytes,
    gptRoutes: payload.gpt_routes,
    missingRequiredGpts: validation.missingGptIds,
  });

  res.set('cache-control', 'no-store, max-age=0');
  res.setHeader('x-response-bytes', String(payload.response_bytes));
  res.status(status === 'ok' ? 200 : 503).json(payload);
}

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

  app.get('/health', async (req: Request, res: Response) => {
    try {
      await writePublicHealthResponse(req, res);
    } catch (error) {
      logger.error('health.response.failed', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
      sendBoundedJsonResponse(req, res, {
        error: 'Health check unavailable'
      }, {
        logEvent: 'health.error.response',
        statusCode: 500,
      });
    }
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
      sendBoundedJsonResponse(req, res, diagnostics, {
        logEvent: 'diagnostics.response',
      });
    } catch (error) {
      logger.error('diagnostics.response.failed', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
      sendBoundedJsonResponse(req, res, {
        error: 'Diagnostics unavailable'
      }, {
        logEvent: 'diagnostics.error.response',
        statusCode: 500,
      });
    }
  });
}

export function getDiagnosticsSnapshot(app: Application): Promise<DiagnosticsSnapshot> {
  return runtimeDiagnosticsService.getDiagnosticsSnapshot(app);
}
