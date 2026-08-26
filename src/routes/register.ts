import { Express, Request, Response } from 'express';
import askRouter from './ask.js';
import backstageBookerAsyncResultRouter from './backstageBookerAsyncResult.js';
import jobsRouter from './jobs.js';
import queryFinetuneRouter from './queryFinetune.js';
import arcanosRouter from './arcanos.js';
import arcanosPipelineRouter from './openai-arcanos-pipeline.js';
import aiEndpointsRouter from './ai-endpoints.js';
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
import dispatchRouter from './dispatch.js';
import mcpRouter from './mcp.js';
import gptAccessRouter from './gpt-access.js';
import controlPlaneRouter from './control-plane.js';
import systemStateRouter from './system-state.js';
import apiRouter from './api/index.js';
import healthGroupRouter from './healthGroup.js';
import safetyRouter from './safety.js';
import plansRouter from './plans.js';
import clearRouter from './clear.js';
import agentsRouter from './agents.js';
import actionPlanExecutionsRouter from './action-plan-executions.js';
import selfImproveRouter from './self-improve.js';
import selfHealRouter from './self-heal.js';
import workerHelperRouter from './worker-helper.js';
import { createFallbackTestRoute } from "@transport/http/middleware/fallbackHandler.js";
import { runHealthCheck } from "@platform/logging/diagnostics.js";
import { logger } from '@platform/logging/structuredLogging.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import { resolveConfiguredPurposeBoundCredential } from '@shared/security/purposeBoundCredential.js';
import {
  projectPublicRailwayHealthcheck,
  RAILWAY_HEALTHCHECK_UNAVAILABLE_CODE,
  RAILWAY_HEALTHCHECK_UNAVAILABLE_MESSAGE,
} from '@shared/http/railwayHealthcheckProjection.js';
import devopsRouter from './devops.js';
import introspectionRouter from './introspection.js';
import trinityRouter from './trinity.js';
import apiSessionSystemRouter from './api-session-system.js';
import { sendTimestampedStatus } from "@platform/resilience/serviceUnavailable.js";
import { TRINITY_BASE_SOFT_CAP_MS, TRINITY_MULTIPLIERS } from "@core/logic/trinityGuards.js";
import { WATCHDOG_LIMIT_MS, SAFETY_BUFFER_MS, BUDGET_DISABLED } from '../platform/resilience/runtimeBudget.js';
import { resolveTimeout } from "@platform/runtime/watchdogConfig.js";
import { legacyGptRoutesEnabled } from '@platform/runtime/legacyRouteMode.js';

/**
 * Mounts all application routes on the provided Express app.
 */
export function registerRoutes(app: Express): void {

  app.get('/', (_: Request, res: Response) => {
    res.send('ARCANOS is live');
  });

  app.get('/robots.txt', (_: Request, res: Response) => {
    res.type('text/plain').send('User-agent: *\nDisallow:\n');
  });

  app.get('/railway/healthcheck', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    try {
      const report = runHealthCheck();
      const publicReport = projectPublicRailwayHealthcheck(report);
      const statusCode = publicReport.status === 'ok' ? 200 : 503;

      sendTimestampedStatus(res, statusCode, publicReport);
    } catch (error) {
      try {
        const failureDetails = {
          code: RAILWAY_HEALTHCHECK_UNAVAILABLE_CODE,
          errorType: error instanceof Error ? 'Error' : typeof error,
        };
        if (req.logger?.error) {
          req.logger.error('railway.healthcheck.failed', failureDetails);
        } else {
          logger.error('railway.healthcheck.failed', {
            requestId: req.requestId ?? 'unknown',
            traceId: req.traceId ?? 'unknown',
            ...failureDetails,
          });
        }
      } catch {
        // Public health behavior must not depend on diagnostics logging.
      }
      sendTimestampedStatus(res, 503, {
        status: 'error',
        code: RAILWAY_HEALTHCHECK_UNAVAILABLE_CODE,
        message: RAILWAY_HEALTHCHECK_UNAVAILABLE_MESSAGE,
      });
    }
  });

  if (process.env.DEBUG_WATCHDOG === 'true') {
    app.get('/debug/watchdog', (req: Request, res: Response) => {
      const expectedDebugKey = resolveConfiguredPurposeBoundCredential({
        ownEnvironmentName: 'DEBUG_WATCHDOG_KEY',
        readEnvironmentValue: (environmentName) => process.env[environmentName],
      });
      res.setHeader('Cache-Control', 'no-store');

      if (!expectedDebugKey) {
        return res.status(503).json({ error: 'Service Unavailable' });
      }

      if (!timingSafeEqualOpaqueSecret(req.header('x-debug-key'), expectedDebugKey)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      res.json({
        trinity: {
          baseSoftCapMs: TRINITY_BASE_SOFT_CAP_MS,
          multipliers: {
            simple: TRINITY_MULTIPLIERS.simple,
            complex: TRINITY_MULTIPLIERS.complex,
            critical: TRINITY_MULTIPLIERS.critical,
          }
        },
        runtime: {
          watchdogLimitMs: WATCHDOG_LIMIT_MS,
          safetyBufferMs: SAFETY_BUFFER_MS,
          budgetDisabled: BUDGET_DISABLED,
        },
        modelTimeouts: {
          'gpt-5': resolveTimeout('gpt-5'),
          'gpt-5.1': resolveTimeout('gpt-5.1'),
          default: resolveTimeout('default'),
        }
      });
    });
  }

  app.use('/', healthGroupRouter);
  app.use('/', introspectionRouter);
  app.use('/', trinityRouter);
  app.use('/', safetyRouter);
  app.use('/', dispatchRouter);
  app.use('/', mcpRouter);
  // The dedicated bearer result adapter must run before the GPT Access
  // namespace catch-all, while generic /jobs capability reads stay unchanged.
  app.use('/', backstageBookerAsyncResultRouter);
  app.use('/', jobsRouter);
  app.use('/', gptAccessRouter);
  app.use('/', controlPlaneRouter);
  app.use('/', selfHealRouter);
  app.use('/', selfImproveRouter);
  app.use('/', systemStateRouter);
  app.use('/', askRouter);
  app.use('/', queryFinetuneRouter);
  app.use('/', apiSessionSystemRouter);
  app.use('/', apiRouter);
  app.use('/', arcanosPipelineRouter);
  if (legacyGptRoutesEnabled()) {
    app.use('/', arcanosRouter);
    app.use('/', aiEndpointsRouter);
  }
  app.use('/', modulesRouter);
  app.use('/', workersRouter);
  app.use('/', orchestrationRouter);
  app.use('/', siriRouter);
  app.use('/gpt', gptRouter);
  app.use('/backstage', backstageRouter);
  app.use('/sdk', sdkRouter);
  app.use('/', bridgeRouter);
  app.use('/', debugConfirmationRouter);
  app.use('/', workerHelperRouter);
  console.info('[ROUTES] Mounted /worker-helper helper endpoints and canonical /gpt routing.');
  app.use('/', hrcRouter);
  app.use('/', imageRouter);
  app.use('/', ragRouter);
  app.use('/', researchRouter);
  app.use('/', reinforcementRouter);
  app.use('/', devopsRouter);
  // ActionPlan orchestration + CLEAR 2.0 governance
  app.use('/', actionPlanExecutionsRouter);
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
