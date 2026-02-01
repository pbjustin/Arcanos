import { Express, Request, Response } from 'express';
import askRouter from './ask.js';
import arcanosRouter from './arcanos.js';
import arcanosPipelineRouter from './openai-arcanos-pipeline.js';
import aiEndpointsRouter from './ai-endpoints.js';
import sessionRoutes from './sessionRoutes.js';
import modulesRouter from './modules.js';
import workersRouter from './workers.js';
import orchestrationRouter from './orchestration.js';
import siriRouter from './siri.js';
import backstageRouter from './backstage.js';
import sdkRouter from './sdk/index.js';
import imageRouter from './image.js';
import ragRouter from './rag.js';
import hrcRouter from './hrc.js';
import gptRouter from './gptRouter.js';
import researchRouter from './research.js';
import reinforcementRouter from './reinforcement.js';
import bridgeRouter from './bridge.js';
import debugConfirmationRouter from './debug-confirmation.js';
import apiRouter from './api/index.js';
import healthGroupRouter from './healthGroup.js';
import { createFallbackTestRoute } from '../middleware/fallbackHandler.js';
import { runHealthCheck } from '../utils/diagnostics.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import devopsRouter from './devops.js';

/**
 * Mounts all application routes on the provided Express app.
 */
export function registerRoutes(app: Express): void {
  app.get('/', (_: Request, res: Response) => {
    res.send('ARCANOS is live');
  });

  app.get('/railway/healthcheck', (_: Request, res: Response) => {
    try {
      const report = runHealthCheck();
      const statusCode = report.status === 'ok' ? 200 : 503;

      res.status(statusCode).json({
        status: report.status,
        timestamp: new Date().toISOString(),
        components: report.components,
        summary: report.summary
      });
    } catch (error) {
      console.error('[Railway Healthcheck] Error generating health report', error);
      res.status(503).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        message: resolveErrorMessage(error)
      });
    }
  });

  app.use('/', healthGroupRouter);
  app.use('/', askRouter);
  app.use('/', apiRouter);
  app.use('/', arcanosRouter);
  app.use('/', arcanosPipelineRouter);
  app.use('/', aiEndpointsRouter);
  app.use('/', sessionRoutes);
  app.use('/', modulesRouter);
  app.use('/', workersRouter);
  app.use('/', orchestrationRouter);
  app.use('/', siriRouter);
  app.use('/gpt', gptRouter);
  app.use('/backstage', backstageRouter);
  app.use('/sdk', sdkRouter);
  app.use('/', bridgeRouter);
  app.use('/', debugConfirmationRouter);
  app.use('/', hrcRouter);
  app.use('/', imageRouter);
  app.use('/', ragRouter);
  app.use('/', researchRouter);
  app.use('/', reinforcementRouter);
  app.use('/', devopsRouter);
  
  // Add test endpoints for Railway health checks
  app.get('/api/test', (_: Request, res: Response) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      service: 'ARCANOS',
      version: '1.0.0'
    });
  });
  app.get('/api/fallback/test', createFallbackTestRoute());
}
