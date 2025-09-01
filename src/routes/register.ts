import { Express, Request, Response } from 'express';
import askRouter from './ask.js';
import arcanosRouter from './arcanos.js';
import arcanosPipelineRouter from './openai-arcanos-pipeline.js';
import aiEndpointsRouter from './ai-endpoints.js';
import memoryRouter from './memory.js';
import modulesRouter from './modules.js';
import workersRouter from './workers.js';
import heartbeatRouter from './heartbeat.js';
import orchestrationRouter from './orchestration.js';
import statusRouter from './status.js';
import siriRouter from './siri.js';
import backstageRouter from './backstage.js';
import apiArcanosRouter from './api-arcanos.js';
import sdkRouter from './sdk.js';

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
  app.use('/', memoryRouter);
  app.use('/', modulesRouter);
  app.use('/', workersRouter);
  app.use('/', heartbeatRouter);
  app.use('/', orchestrationRouter);
  app.use('/', statusRouter);
  app.use('/', siriRouter);
  app.use('/backstage', backstageRouter);
  app.use('/sdk', sdkRouter);
  app.use('/api/arcanos', apiArcanosRouter);
}
