/**
 * System Status Routes
 * Provides endpoints for reading and updating system state
 */

import express, { Request, Response } from 'express';
import { loadState, updateState, SystemState } from '../services/stateManager.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { getOpenAIServiceHealth } from '../services/openai.js';
import { queryCache, configCache } from '../utils/cache.js';
import { getStatus as getDbStatus } from '../db.js';
import { sendJsonError } from '../utils/responseHelpers.js';
import { assessCoreServiceReadiness, mapReadinessToHealthStatus } from '../utils/healthChecks.js';

const router = express.Router();

/**
 * GET /status - Retrieve current system state
 */
router.get('/status', (_: Request, res: Response) => {
  try {
    const state = loadState();
    res.json(state);
  } catch (error) {
    //audit Assumption: state load failures should return 500; risk: leaking internal details; invariant: client gets structured error; handling: log and return error response.
    console.error('[STATUS] Error retrieving system state:', error);
    sendJsonError(
      res,
      500,
      'Failed to retrieve system state',
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
});

/**
 * GET /health - Comprehensive health check including services, caches, and circuit breakers
 */
router.get('/health', async (_: Request, res: Response) => {
  try {
    const openaiHealth = getOpenAIServiceHealth();
    const dbStatus = await getDbStatus();
    //audit Assumption: readiness depends on database connectivity and OpenAI health; risk: misclassification; invariant: readiness requires critical services; handling: shared readiness helper.
    const readiness = assessCoreServiceReadiness(
      dbStatus,
      openaiHealth,
      process.env.DATABASE_URL
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
        environment: process.env.NODE_ENV || 'development'
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
    //audit Assumption: health failures should return 500; risk: masking root cause; invariant: error response includes context; handling: log and send JSON error.
    console.error('[HEALTH] Error retrieving health status:', error);
    sendJsonError(
      res,
      500,
      'Failed to retrieve health status',
      error instanceof Error ? error.message : 'Unknown error',
      { status: 'unhealthy' }
    );
  }
});

/**
 * POST /status - Update system state
 */
router.post('/status', confirmGate, (req: Request, res: Response) => {
  try {
    const updates: Partial<SystemState> = req.body;
    
    // Validate that we have some data to update
    if (!updates || Object.keys(updates).length === 0) {
      //audit Assumption: empty updates are invalid; risk: accepting no-op updates; invariant: update requires payload; handling: return 400 with message.
      return res.status(400).json({
        error: 'No update data provided',
        message: 'Request body must contain state updates'
      });
    }
    
    const updatedState = updateState(updates);
    console.log('[STATUS] System state updated:', Object.keys(updates));

    res.json(updatedState);
  } catch (error) {
    //audit Assumption: update failures should return 500; risk: leaking internal details; invariant: client gets structured error; handling: log and return error response.
    console.error('[STATUS] Error updating system state:', error);
    sendJsonError(
      res,
      500,
      'Failed to update system state',
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
});

export default router;
