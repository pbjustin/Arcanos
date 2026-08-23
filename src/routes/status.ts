import { sendBadRequestPayload } from '@shared/http/index.js';
/**
 * System Status Routes
 * Provides endpoints for reading and updating system state
 */

import express, { NextFunction, Request, Response } from 'express';
import { loadState, updateState, SystemState } from "@services/stateManager.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { getOpenAIServiceHealth } from "@services/openai.js";
import { queryCache, configCache } from "@platform/resilience/cache.js";
import { getStatus as getDbStatus } from "@core/db/index.js";
import { sendJsonError } from "@transport/http/responseHelpers.js";
import { assessCoreServiceReadiness, mapReadinessToHealthStatus } from "@platform/resilience/healthChecks.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { writePublicHealthResponse } from "@core/diagnostics.js";
import { logger } from '@platform/logging/structuredLogging.js';
import { systemStateHttpBoundary } from '@services/controlPlane/systemStateHttpBoundary.js';
import { systemStateBodyParser } from '@services/controlPlane/systemStateBodyParser.js';

const router = express.Router();
const STATUS_UNAVAILABLE_CODE = 'STATUS_UNAVAILABLE';
const STATUS_UNAVAILABLE_MESSAGE = 'Status endpoint unavailable.';
const STATUS_UPDATE_FAILED_CODE = 'STATUS_UPDATE_FAILED';
const STATUS_UPDATE_FAILED_MESSAGE = 'System state update failed.';
const HEALTH_STATUS_UNAVAILABLE_CODE = 'HEALTH_STATUS_UNAVAILABLE';
const HEALTH_STATUS_UNAVAILABLE_MESSAGE = 'Health status unavailable.';

function setNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function markNoStore(_req: Request, res: Response, next: NextFunction): void {
  setNoStoreHeaders(res);
  next();
}

function logStatusFailure(
  req: Request,
  event: string,
  code: string,
  error: unknown,
): void {
  try {
    const failureDetails = {
      code,
      errorType: error instanceof Error ? 'Error' : typeof error,
    };
    if (req.logger?.error) {
      req.logger.error(event, failureDetails);
    } else {
      logger.error(event, {
        requestId: req.requestId ?? 'unknown',
        traceId: req.traceId ?? 'unknown',
        ...failureDetails,
      });
    }
  } catch {
    // Public status behavior must not depend on diagnostics logging.
  }
}

/**
 * GET /status - Legacy health alias
 */
router.get('/status', async (req: Request, res: Response) => {
  res.setHeader('x-status-endpoint', 'deprecated');
  res.setHeader('x-status-replacement', '/health');
  setNoStoreHeaders(res);
  try {
    await writePublicHealthResponse(req, res);
  } catch (error) {
    //audit Assumption: legacy status failures need correlation without retaining arbitrary exception text; risk: response or log disclosure; invariant: fixed public message and closed log classification; handling: log stable metadata and return a no-store error.
    logStatusFailure(req, 'status.legacy_health.failed', STATUS_UNAVAILABLE_CODE, error);
    sendJsonError(
      res,
      500,
      'Failed to retrieve system state',
      STATUS_UNAVAILABLE_MESSAGE
    );
  }
});

/**
 * GET /health - Comprehensive health check including services, caches, and circuit breakers
 */
router.get('/health', markNoStore, async (req: Request, res: Response) => {
  try {
    const openaiHealth = getOpenAIServiceHealth();
    const dbStatus = await getDbStatus();
    //audit Assumption: readiness depends on database connectivity and OpenAI health; risk: misclassification; invariant: readiness requires critical services; handling: shared readiness helper.
    const config = getConfig();
    const readiness = assessCoreServiceReadiness(
      dbStatus,
      openaiHealth,
      config.databaseUrl
    );
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        openai: openaiHealth,
        database: dbStatus,
        cache: {
          query: queryCache.getStats(),
          config: configCache.getStats()
        }
      },
      system: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version,
        environment: config.nodeEnv
      }
    };

    // Determine overall health status
    //audit Assumption: degraded health should map to 503; risk: false negatives; invariant: health reflects readiness flags; handling: derive from readiness helper.
    const healthStatus = mapReadinessToHealthStatus(readiness);
    //audit Assumption: status reflects readiness; risk: mismatch; invariant: status matches readiness; handling: update status from readiness result.
    health.status = healthStatus;

    //audit Assumption: health status maps to HTTP 200/503; risk: incorrect status code; invariant: unhealthy signals 503; handling: set status based on readiness.
    const statusCode = healthStatus === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
    //audit Assumption: this shadowed compatibility handler may become reachable after route-order changes; risk: latent exception disclosure; invariant: fixed public message and closed log classification; handling: mark no-store and log stable metadata only.
    logStatusFailure(
      req,
      'status.legacy_detailed_health.failed',
      HEALTH_STATUS_UNAVAILABLE_CODE,
      error,
    );
    sendJsonError(
      res,
      500,
      'Failed to retrieve health status',
      HEALTH_STATUS_UNAVAILABLE_MESSAGE,
      { status: 'unhealthy' }
    );
  }
});

/**
 * POST /status - Update system state
 */
router.post(
  '/status',
  systemStateHttpBoundary,
  systemStateBodyParser,
  markNoStore,
  confirmGate,
  (req: Request, res: Response) => {
    try {
      const updates: Partial<SystemState> = req.body;

      // Validate that we have some data to update
      if (!updates || Object.keys(updates).length === 0) {
        //audit Assumption: empty updates are invalid; risk: accepting no-op updates; invariant: update requires payload; handling: return 400 with message.
        return sendBadRequestPayload(res, {
          error: 'No update data provided',
          message: 'Request body must contain state updates'
        });
      }

      const updatedState = updateState(updates);
      console.log('[STATUS] System state updated:', Object.keys(updates));

      res.json(updatedState);
    } catch (error) {
      //audit Assumption: update failures need correlation without retaining filesystem or serialization text; risk: response or log disclosure; invariant: fixed public message and closed log classification; handling: log stable metadata and return a no-store error.
      logStatusFailure(req, 'status.update.failed', STATUS_UPDATE_FAILED_CODE, error);
      sendJsonError(
        res,
        500,
        'Failed to update system state',
        STATUS_UPDATE_FAILED_MESSAGE
      );
    }
  }
);

export default router;
