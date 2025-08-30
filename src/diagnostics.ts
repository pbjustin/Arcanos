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
  cron.schedule('*/5 * * * *', async () => {
    const report = await runHealthCheck();
    logger.info('📡 ARCANOS:HEALTH', { summary: report.summary });
  });

  app.get('/health', async (_: Request, res: Response) => {
    const healthReport = await runHealthCheck();
    const defaultModel = getDefaultModel();

    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'ARCANOS',
      version: process.env.npm_package_version || '1.0.0',
      ai: {
        defaultModel: defaultModel,
        fallbackModel: config.ai.fallbackModel
      },
      system: {
        memory: healthReport.summary,
        uptime: `${process.uptime().toFixed(1)}s`,
        nodeVersion: process.version,
        environment: config.server.environment
      }
    });
  });
}
