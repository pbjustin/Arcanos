import { Express, Request, Response } from 'express';
import cron from 'node-cron';
import { runHealthCheck } from "@platform/logging/diagnostics.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { config } from "@platform/runtime/config.js";
import { checkRedisHealth } from "@platform/resilience/unifiedHealth.js";
import { getDefaultModel } from "@services/openai.js";
import { getEnv } from "@platform/runtime/env.js";

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

  app.get('/health', async (_: Request, res: Response) => {
    const healthReport = await runHealthCheck();
    const redisHealth = await checkRedisHealth();
    const defaultModel = getDefaultModel();
    //audit Assumption: live `/health` should surface Redis dependency failures even though worker diagnostics remain healthy; failure risk: false-positive health responses when Redis is unavailable; expected invariant: unhealthy configured Redis degrades the endpoint status; handling strategy: fold Redis health into the final status code and payload.
    const routeStatus = healthReport.status === 'ok' && redisHealth.healthy ? 'ok' : 'degraded';
    const statusCode = routeStatus === 'ok' ? 200 : 503;
    const uptimeSeconds = healthReport.metrics.uptimeSeconds;
    const summary = redisHealth.healthy
      ? healthReport.summary
      : `${healthReport.summary} | Redis: ${redisHealth.error || 'unhealthy'}`;

    res.status(statusCode).json({
      status: routeStatus,
      timestamp: new Date().toISOString(),
      service: 'ARCANOS',
      // Use config layer for env access (adapter boundary pattern)
      // Note: npm_package_version is set by npm, not a standard env var
      version: getEnv('npm_package_version') || '1.0.0',
      summary,
      components: healthReport.components,
      dependencies: {
        redis: redisHealth
      },
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
