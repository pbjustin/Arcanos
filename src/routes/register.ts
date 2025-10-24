import { Express, Request, Response } from 'express';
import askRouter from './ask.js';
import arcanosRouter from './arcanos.js';
import arcanosPipelineRouter from './openai-arcanos-pipeline.js';
import aiEndpointsRouter from './ai-endpoints.js';
import sessionRoutes from './sessionRoutes.js';
import modulesRouter from './modules.js';
import workersRouter from './workers.js';
import heartbeatRouter from './heartbeat.js';
import orchestrationRouter from './orchestration.js';
import statusRouter from './status.js';
import siriRouter from './siri.js';
import railwayHealthRouter from './railway-health.js';
import backstageRouter from './backstage.js';
import apiArcanosRouter from './api-arcanos.js';
import apiSimRouter from './api-sim.js';
import apiMemoryRouter from './api-memory.js';
import sdkRouter from './sdk.js';
import imageRouter from './image.js';
import prAnalysisRouter from './pr-analysis.js';
import openaiRouter from './openai.js';
import ragRouter from './rag.js';
import hrcRouter from './hrc.js';
import gptRouter from './gptRouter.js';
import researchRouter from './research.js';
import { createFallbackTestRoute } from '../middleware/fallbackHandler.js';

/**
 * Mounts all application routes on the provided Express app.
 */
export function registerRoutes(app: Express): void {
  app.get('/', (_: Request, res: Response) => {
    res.send('ARCANOS is live');
  });

  app.use('/', askRouter);
  app.use('/', arcanosRouter);
  app.use('/', arcanosPipelineRouter);
  app.use('/', aiEndpointsRouter);
  app.use('/', sessionRoutes);
  app.use('/', modulesRouter);
  app.use('/', workersRouter);
  app.use('/', heartbeatRouter);
  app.use('/', railwayHealthRouter);
  app.use('/', orchestrationRouter);
  app.use('/', statusRouter);
  app.use('/', siriRouter);
  app.use('/gpt', gptRouter);
  app.use('/backstage', backstageRouter);
  app.use('/sdk', sdkRouter);
  app.use('/api/arcanos', apiArcanosRouter);
  app.use('/api/sim', apiSimRouter);
  app.use('/api/memory', apiMemoryRouter);
  app.use('/api/pr-analysis', prAnalysisRouter);
  app.use('/api/openai', openaiRouter);
  app.use('/', hrcRouter);
  app.use('/', imageRouter);
  app.use('/', ragRouter);
  app.use('/', researchRouter);
  
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
