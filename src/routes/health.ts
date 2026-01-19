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
import { assessCoreServiceReadiness } from '../utils/healthChecks.js';

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

    //audit Assumption: readiness depends on database connectivity and OpenAI health; risk: misclassification; invariant: readiness requires critical services; handling: shared readiness helper.
    const readiness = assessCoreServiceReadiness(
      dbStatus,
      openaiHealth,
      process.env.DATABASE_URL
    );

    const response = {
      status: readiness.isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: readiness.isDatabaseReady ? 'ready' : 'not_ready',
          connected: dbStatus.connected,
          error: dbStatus.error
        },
        openai: {
          status: readiness.isOpenAIReady ? 'ready' : 'not_ready',
          healthy: openaiHealth.circuitBreaker.healthy,
          configured: openaiHealth.apiKey.configured
        }
      }
    };

    //audit Assumption: readiness maps to HTTP 200/503; risk: incorrect status code; invariant: readiness dictates service availability; handling: set status based on readiness.
    const statusCode = readiness.isReady ? 200 : 503;
    res.status(statusCode).json(response);
    
  } catch (error) {
    //audit Assumption: readiness failure should surface as 503; risk: masking root cause; invariant: readiness endpoint signals unavailability; handling: log and return error payload.
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
