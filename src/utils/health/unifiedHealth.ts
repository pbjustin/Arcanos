/**
 * Unified Health Check Utilities
 * 
 * Provides reusable health check patterns for Railway-native deployments:
 * - Service health checks (OpenAI, database, etc.)
 * - Dependency health aggregation
 * - Health check endpoint builder
 * - Railway-compatible health responses
 * 
 * Features:
 * - Stateless health checks (no local state dependencies)
 * - Railway-compatible response formats
 * - Comprehensive dependency checking
 * - Audit trail for health checks
 * 
 * @module unifiedHealth
 */

import { Request, Response, NextFunction } from 'express';
import { aiLogger } from '../structuredLogging.js';
import { recordTraceEvent } from '../telemetry.js';
import { validateClientHealth, HealthStatus as ClientHealthStatus } from '../../services/openai/unifiedClient.js';
import { isOpenAIAdapterInitialized } from '../../adapters/openai.adapter.js';
import { getConfig } from '../../config/unifiedConfig.js';
import { assessCoreServiceReadiness, HealthStatus as ServiceHealthStatus } from '../healthChecks.js';
import { resolveErrorMessage } from '../../lib/errors/index.js';
import { sendTimestampedStatus } from '../serviceUnavailable.js';

/**
 * Health check function type
 */
export type HealthCheckFn = () => Promise<HealthCheckResult> | HealthCheckResult;

/**
 * Health check result
 */
export interface HealthCheckResult {
  /** Whether the check passed */
  healthy: boolean;
  /** Check name */
  name: string;
  /** Optional error message */
  error?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Check duration in milliseconds */
  duration?: number;
}

/**
 * Aggregated health status
 */
export interface AggregatedHealthStatus {
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Timestamp of health check */
  timestamp: string;
  /** Individual health check results */
  checks: HealthCheckResult[];
  /** Summary of healthy/unhealthy checks */
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
    degraded: number;
  };
}

/**
 * Health checker instance
 */
export interface HealthChecker {
  /** Check name */
  name: string;
  /** Health check function */
  check: HealthCheckFn;
  /** Whether this check is critical (fails overall health if unhealthy) */
  critical?: boolean;
}

/**
 * Creates a health check instance
 * 
 * @param name - Health check name
 * @param check - Health check function
 * @param critical - Whether this check is critical (default: true)
 * @returns Health checker instance
 */
export function createHealthCheck(
  name: string,
  check: HealthCheckFn,
  critical: boolean = true
): HealthChecker {
  return {
    name,
    check,
    critical
  };
}

/**
 * Executes a health check with timing and error handling
 * 
 * @param checker - Health checker instance
 * @returns Health check result
 */
async function executeHealthCheck(checker: HealthChecker): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const traceId = recordTraceEvent('health.check.start', {
    name: checker.name,
    critical: checker.critical
  });

  try {
    const result = await Promise.resolve(checker.check());
    const duration = Date.now() - startTime;

    const healthResult: HealthCheckResult = {
      ...result,
      name: checker.name,
      duration
    };

    recordTraceEvent('health.check.success', {
      traceId,
      name: checker.name,
      healthy: healthResult.healthy,
      duration
    });

    return healthResult;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = resolveErrorMessage(error);

    aiLogger.error(`Health check failed: ${checker.name}`, {
      module: 'health.unified',
      operation: 'executeHealthCheck',
      name: checker.name,
      duration
    }, undefined, error as Error);

    recordTraceEvent('health.check.error', {
      traceId,
      name: checker.name,
      error: errorMessage,
      duration
    });

    return {
      healthy: false,
      name: checker.name,
      error: errorMessage,
      duration
    };
  }
}

/**
 * Aggregates multiple health checks into a single status
 * 
 * Determines overall health status based on individual checks:
 * - healthy: All checks are healthy
 * - degraded: Some non-critical checks are unhealthy
 * - unhealthy: Any critical check is unhealthy
 * 
 * @param checks - Array of health checker instances
 * @returns Aggregated health status
 */
export async function aggregateHealthChecks(checks: HealthChecker[]): Promise<AggregatedHealthStatus> {
  const startTime = Date.now();
  const traceId = recordTraceEvent('health.aggregate.start', {
    checkCount: checks.length
  });

  // Execute all checks in parallel
  const results = await Promise.all(checks.map(checker => executeHealthCheck(checker)));

  // Calculate summary
  const summary = {
    total: results.length,
    healthy: results.filter(r => r.healthy).length,
    unhealthy: results.filter(r => !r.healthy).length,
    degraded: 0
  };

  // Determine overall status
  const criticalChecks = checks.filter(c => c.critical !== false);
  const criticalResults = results.filter((_, i) => criticalChecks.includes(checks[i]));
  const hasUnhealthyCritical = criticalResults.some(r => !r.healthy);
  const hasUnhealthyNonCritical = results.some((r, i) => !r.healthy && checks[i].critical === false);

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (hasUnhealthyCritical) {
    status = 'unhealthy';
  } else if (hasUnhealthyNonCritical) {
    status = 'degraded';
    summary.degraded = summary.unhealthy;
    summary.unhealthy = 0;
  } else {
    status = 'healthy';
  }

  const duration = Date.now() - startTime;
  const aggregated: AggregatedHealthStatus = {
    status,
    timestamp: new Date().toISOString(),
    checks: results,
    summary
  };

  recordTraceEvent('health.aggregate.success', {
    traceId,
    status,
    duration,
    ...summary
  });

  return aggregated;
}

/**
 * Builds an Express health check endpoint handler
 * 
 * Creates a Railway-compatible health check endpoint that:
 * - Returns 200 for healthy/degraded status
 * - Returns 503 for unhealthy status
 * - Includes comprehensive health information
 * - Supports Railway health check format
 * 
 * @param checks - Array of health checker instances
 * @returns Express route handler
 */
export function buildHealthEndpoint(checks: HealthChecker[]): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    const startTime = Date.now();
    const traceId = recordTraceEvent('health.endpoint.start', {
      path: req.path,
      checkCount: checks.length
    });

    try {
      const health = await aggregateHealthChecks(checks);
      const duration = Date.now() - startTime;

      // Railway-compatible status codes
      const statusCode = health.status === 'unhealthy' ? 503 : 200;

      res.status(statusCode).json({
        status: health.status,
        timestamp: health.timestamp,
        checks: health.checks,
        summary: health.summary,
        duration
      });

      recordTraceEvent('health.endpoint.success', {
        traceId,
        status: health.status,
        statusCode,
        duration
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = resolveErrorMessage(error);

      aiLogger.error('Health endpoint error', {
        module: 'health.unified',
        operation: 'buildHealthEndpoint',
        duration
      }, undefined, error as Error);

      recordTraceEvent('health.endpoint.error', {
        traceId,
        error: errorMessage,
        duration
      });

      sendTimestampedStatus(res, 503, {
        status: 'unhealthy',
        error: errorMessage,
        duration
      });
    }
  };
}

/**
 * Creates a liveness probe endpoint (healthz)
 * 
 * Simple liveness check that returns 200 if the application is running.
 * Used by Railway and Kubernetes for liveness probes.
 * 
 * @returns Express route handler
 */
export function buildLivenessEndpoint(): (req: Request, res: Response) => void {
  return (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString()
    });
  };
}

/**
 * Creates a readiness probe endpoint (readyz)
 * 
 * Readiness check that verifies critical dependencies are ready.
 * Returns 200 if ready, 503 if not ready.
 * 
 * @param checks - Array of critical health checker instances
 * @returns Express route handler
 */
export function buildReadinessEndpoint(checks: HealthChecker[]): (req: Request, res: Response) => Promise<void> {
  const criticalChecks = checks.filter(c => c.critical !== false);
  
  return async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const health = await aggregateHealthChecks(criticalChecks);
      const duration = Date.now() - startTime;

      const statusCode = health.status === 'healthy' ? 200 : 503;

      res.status(statusCode).json({
        ready: health.status === 'healthy',
        status: health.status,
        timestamp: health.timestamp,
        checks: health.checks,
        duration
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = resolveErrorMessage(error);

      sendTimestampedStatus(res, 503, {
        ready: false,
        status: 'unhealthy',
        error: errorMessage,
        duration
      });
    }
  };
}

/**
 * Default health checks for common services
 */

/**
 * OpenAI client health check.
 * Considers adapter singleton (set by init-openai) as well as unified client so /readyz and /health match actual request path.
 */
export async function checkOpenAIHealth(): Promise<HealthCheckResult> {
  const health = validateClientHealth();
  const adapterInitialized = isOpenAIAdapterInitialized();
  const effectiveHealthy = health.healthy || (adapterInitialized && health.circuitBreakerHealthy);
  return {
    healthy: effectiveHealthy,
    name: 'openai',
    error: effectiveHealthy ? undefined : health.error,
    metadata: {
      apiKeyConfigured: health.apiKeyConfigured || adapterInitialized,
      apiKeySource: health.apiKeySource,
      defaultModel: health.defaultModel,
      circuitBreakerHealthy: health.circuitBreakerHealthy,
      adapterInitialized
    }
  };
}

/**
 * Database health check (if database is configured)
 */
export async function checkDatabaseHealth(): Promise<HealthCheckResult> {
  const config = getConfig();
  
  if (!config.databaseUrl) {
    return {
      healthy: true,
      name: 'database',
      metadata: {
        configured: false,
        reason: 'Database not configured (optional)'
      }
    };
  }

  // Check database connectivity using db client
  try {
    const { getStatus } = await import('../../db/index.js');
    const dbStatus = getStatus();
    
    return {
      healthy: dbStatus.connected,
      name: 'database',
      error: dbStatus.error || undefined,
      metadata: {
        configured: true,
        connected: dbStatus.connected,
        url: config.databaseUrl ? 'configured' : 'not configured'
      }
    };
  } catch (error) {
    return {
      healthy: false,
      name: 'database',
      error: resolveErrorMessage(error),
      metadata: {
        configured: true,
        connected: false
      }
    };
  }
}

/**
 * Application health check
 */
export async function checkApplicationHealth(): Promise<HealthCheckResult> {
  const config = getConfig();
  
  return {
    healthy: true,
    name: 'application',
    metadata: {
      nodeEnv: config.nodeEnv,
      isRailway: config.isRailway,
      railwayEnvironment: config.railwayEnvironment,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    }
  };
}

/**
 * Default export for convenience
 */
export default {
  createHealthCheck,
  aggregateHealthChecks,
  buildHealthEndpoint,
  buildLivenessEndpoint,
  buildReadinessEndpoint,
  checkOpenAIHealth,
  checkDatabaseHealth,
  checkApplicationHealth
};
