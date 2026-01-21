import { Express, Request, Response } from 'express';
import cron from 'node-cron';
import { runHealthCheck } from './utils/diagnostics.js';
import { logger } from './utils/structuredLogging.js';
import config from './config/index.js';
import { getDefaultModel } from './services/openai.js';

/**
 * Registers health check endpoint and monitoring cron job.
 */
export function setupDiagnostics(app: Express): void {
  const diagnosticsEnabled =
    config.server.environment !== 'test' &&
    process.env.DISABLE_DIAGNOSTICS_CRON !== 'true';

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

  app.get('/health', async (_: Request, res: Response) => {
    const healthReport = await runHealthCheck();
    const defaultModel = getDefaultModel();
    const statusCode = healthReport.status === 'ok' ? 200 : 503;
    const uptimeSeconds = healthReport.metrics.uptimeSeconds;

    res.status(statusCode).json({
      status: healthReport.status,
      timestamp: new Date().toISOString(),
      service: 'ARCANOS',
      version: process.env.npm_package_version || '1.0.0',
      summary: healthReport.summary,
      components: healthReport.components,
      ai: {
        defaultModel: defaultModel,
        fallbackModel: config.ai.fallbackModel,
        resilience: healthReport.resilience.circuitBreaker
      },
      system: {
        memory: healthReport.components.memory,
        uptime: `${uptimeSeconds.toFixed(1)}s`,
        loadAverage: healthReport.metrics.loadAverage,
        nodeVersion: process.version,
        environment: config.server.environment,
        security: healthReport.security,
        workers: healthReport.components.workers
      },
      observability: healthReport.telemetry
    });
  });
}
