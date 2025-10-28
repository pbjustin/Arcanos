/**
 * Health and Readiness Endpoints for ARCANOS
 * 
 * Kubernetes/Railway-style health check endpoints:
 * - /healthz: Application health (liveness probe)
 * - /readyz: Readiness probe (database connectivity)
 */

import express, { Request, Response } from 'express';
import { getStatus as getDbStatus } from '../db.js';
import { getOpenAIServiceHealth } from '../services/openai.js';

const router = express.Router();

/**
 * GET /healthz - Application liveness probe
 * Returns 200 if the application is running
 */
router.get('/healthz', (_: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'ARCANOS Backend'
  });
});

/**
 * GET /readyz - Readiness probe
 * Returns 200 if the application is ready to serve traffic (DB connected, OpenAI available)
 */
router.get('/readyz', async (_: Request, res: Response) => {
  try {
    const dbStatus = getDbStatus();
    const openaiHealth = getOpenAIServiceHealth();
    
    // Check if critical services are ready
    const isDatabaseReady = dbStatus.connected || !process.env.DATABASE_URL;
    const isOpenAIReady = openaiHealth.circuitBreaker.healthy;
    
    const isReady = isDatabaseReady && isOpenAIReady;
    
    const response = {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: isDatabaseReady ? 'ready' : 'not_ready',
          connected: dbStatus.connected,
          error: dbStatus.error
        },
        openai: {
          status: isOpenAIReady ? 'ready' : 'not_ready',
          healthy: openaiHealth.circuitBreaker.healthy,
          configured: openaiHealth.apiKey.configured
        }
      }
    };
    
    const statusCode = isReady ? 200 : 503;
    res.status(statusCode).json(response);
    
  } catch (error) {
    console.error('[READYZ] Error checking readiness:', error);
    res.status(503).json({
      status: 'not_ready',
      error: 'Failed to check readiness',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
