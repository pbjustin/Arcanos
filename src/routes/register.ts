import { Express, Request, Response } from 'express';
import askRouter from './ask.js';
import jobsRouter from './jobs.js';
import queryFinetuneRouter from './queryFinetune.js';
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
import reusableCodeRouter from './api-reusable-code.js';
import safetyRouter from './safety.js';
import plansRouter from './plans.js';
import clearRouter from './clear.js';
import agentsRouter from './agents.js';
import { createFallbackTestRoute } from "@transport/http/middleware/fallbackHandler.js";
import { runHealthCheck } from "@platform/logging/diagnostics.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import devopsRouter from './devops.js';
import { sendTimestampedStatus } from "@platform/resilience/serviceUnavailable.js";

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

      sendTimestampedStatus(res, statusCode, {
        status: report.status,
        components: report.components,
        summary: report.summary
      });
    } catch (error) {
      console.error('[Railway Healthcheck] Error generating health report', error);
      sendTimestampedStatus(res, 503, {
        status: 'error',
        message: resolveErrorMessage(error)
      });
    }
  });

  app.use('/', healthGroupRouter);
  app.use('/', safetyRouter);
  app.use('/', jobsRouter);
  app.use('/', askRouter);
  app.use('/', queryFinetuneRouter);
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
  app.use('/', reusableCodeRouter);
  app.use('/', hrcRouter);
  app.use('/', imageRouter);
  app.use('/', ragRouter);
  app.use('/', researchRouter);
  app.use('/', reinforcementRouter);
  app.use('/', devopsRouter);

  // ActionPlan orchestration + CLEAR 2.0 governance
  app.use('/', plansRouter);
  app.use('/', clearRouter);
  app.use('/', agentsRouter);

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

