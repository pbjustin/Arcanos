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

const router = express.Router();

/**
 * GET /status - Retrieve current system state
 */
router.get('/status', (_: Request, res: Response) => {
  try {
    const state = loadState();
    res.json(state);
  } catch (error) {
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
    const isHealthy = openaiHealth.circuitBreaker.healthy && 
                     (dbStatus.connected || !process.env.DATABASE_URL);
    
    health.status = isHealthy ? 'healthy' : 'degraded';
    
    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
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
      return res.status(400).json({
        error: 'No update data provided',
        message: 'Request body must contain state updates'
      });
    }
    
    const updatedState = updateState(updates);
    console.log('[STATUS] System state updated:', Object.keys(updates));

    res.json(updatedState);
  } catch (error) {
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