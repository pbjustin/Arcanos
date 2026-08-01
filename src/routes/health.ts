/**
 * Health and Readiness Endpoints for ARCANOS
 * 
 * Kubernetes/Railway-style health check endpoints:
 * - /healthz: Application health (liveness probe)
 * - /readyz: Readiness probe (OpenAI, database, Redis connectivity)
 * - /health: Comprehensive health check
 * 
 * Uses unified health utilities for consistent health checking.
 */

import express from 'express';
import {
  buildLivenessEndpoint,
  buildReadinessEndpoint,
  buildHealthEndpoint,
  createHealthCheck,
  checkOpenAIHealth,
  checkDatabaseHealth,
  checkDatabaseReadiness,
  checkRedisHealth,
  checkRedisReadiness,
  checkPublicProviderAdmissionReadiness,
  checkStartupReadiness,
  checkApplicationHealth
} from "@platform/resilience/unifiedHealth.js";

const router = express.Router();

/**
 * GET /healthz - Application liveness probe
 * Returns 200 if the application is running
 * Railway-compatible liveness check
 */
router.get('/healthz', buildLivenessEndpoint());

/**
 * GET /readyz - Readiness probe
 * Returns 200 if the application is ready to serve traffic. Production web
 * activation requires configured and available database and Redis backends.
 * Railway-compatible readiness check
 */
router.get('/readyz', buildReadinessEndpoint([
  createHealthCheck('openai', checkOpenAIHealth, true),
  createHealthCheck('database', checkDatabaseReadiness, true),
  createHealthCheck('redis', checkRedisReadiness, true),
  createHealthCheck(
    'public-provider-admission',
    checkPublicProviderAdmissionReadiness,
    true
  ),
  createHealthCheck('startup', checkStartupReadiness, true)
]));

/**
 * GET /health - Comprehensive health check
 * Returns detailed health status for all services
 * Railway-compatible comprehensive health check
 */
router.get('/health', buildHealthEndpoint([
  createHealthCheck('openai', checkOpenAIHealth, true),
  createHealthCheck('database', checkDatabaseHealth, false), // Database is optional
  createHealthCheck('redis', checkRedisHealth, false), // Redis is optional
  createHealthCheck('application', checkApplicationHealth, true)
]));

export default router;
