/**
 * System Health Controller - Business logic for system monitoring
 */

import { Request, Response } from 'express';
import { getOpenAIServiceHealth } from "@services/openai.js";
import { getStatus as getDbStatus } from "@core/db/index.js";
import { getEnvironmentInfo } from "@platform/runtime/environmentValidation.js";
import { buildTimestampedPayload } from "@transport/http/responseHelpers.js";
import { sendTimestampedStatus } from "@platform/resilience/serviceUnavailable.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  assessCoreServiceReadiness,
  mapReadinessToHealthStatus,
  type DatabaseStatusLike,
  type HealthStatus
} from "@platform/resilience/healthChecks.js";
import { RESILIENCE_CONSTANTS } from "@services/openai/resilience.js";
import { CircuitBreakerState } from "@platform/resilience/circuitBreaker.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  services: {
    openai: OpenAIServiceHealth;
    database: DatabaseHealth;
    environment: EnvironmentInfo;
  };
  version: string;
  uptime: number;
  error?: string;
}

type OpenAIServiceHealth = ReturnType<typeof getOpenAIServiceHealth>;
type EnvironmentInfo = ReturnType<typeof getEnvironmentInfo>;

interface DatabaseHealth {
  connected: boolean;
  error: string | null;
  url: string;
}

function buildFallbackOpenAIHealth(): OpenAIServiceHealth {
  try {
    return getOpenAIServiceHealth();
  } catch {
    return {
      apiKey: {
        configured: false,
        status: 'unknown',
        source: null
      },
      client: {
        initialized: false,
        model: 'unknown',
        timeout: 0,
        baseURL: undefined
      },
      circuitBreaker: {
        state: CircuitBreakerState.OPEN,
        failureCount: 0,
        lastFailureTime: 0,
        successCount: 0,
        constants: RESILIENCE_CONSTANTS,
        healthy: false
      },
      cache: {
        totalEntries: 0,
        expiredEntries: 0,
        activeEntries: 0,
        averageAccessCount: 0,
        memoryUsage: 0,
        enabled: false
      },
      lastHealthCheck: new Date().toISOString(),
      defaults: {
        maxTokens: RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS
      }
    };
  }
}

function buildHealthResponsePayload(
  status: HealthStatus,
  openaiHealth: OpenAIServiceHealth,
  envInfo: EnvironmentInfo,
  dbStatus: DatabaseStatusLike,
  databaseUrl: string | undefined
): HealthResponse {
  const isDatabaseConfigured = Boolean(databaseUrl);

  //audit Assumption: database URL presence signals configuration; risk: mislabeling non-standard configs; invariant: connection metadata matches configuration; handling: map boolean to display label.
  const databaseDisplayUrl = isDatabaseConfigured ? '[CONFIGURED]' : '[NOT_CONFIGURED]';

  //audit Assumption: building response should not mutate inputs; risk: accidental mutation; invariant: response contains expected fields; handling: construct new payload object.
  const responsePayload = buildTimestampedPayload({
    status,
    services: {
      openai: openaiHealth,
      database: {
        connected: dbStatus.connected,
        error: dbStatus.error ?? null,
        url: databaseDisplayUrl
      },
      environment: envInfo
    },
    version: '1.0.0',
    uptime: process.uptime()
  });

  return responsePayload;
}

/**
 * Health check controller
 */
export class HealthController {
  /**
   * Comprehensive health check endpoint.
   *
   * Purpose: Provide detailed health status for dependencies.
   * Inputs/Outputs: Accepts Express request/response and returns a HealthResponse payload.
   * Edge cases: Returns degraded or unhealthy statuses when dependencies are missing or checks fail.
   */
  static async getHealth(req: Request, res: Response<HealthResponse>): Promise<void> {
    try {
      const openaiHealth = getOpenAIServiceHealth();
      const envInfo = getEnvironmentInfo();
      const dbStatus = getDbStatus();
      const readiness = assessCoreServiceReadiness(dbStatus, openaiHealth, getEnv('DATABASE_URL'));

      //audit Assumption: health status derives from core readiness; risk: missing signals from other dependencies; invariant: status reflects core dependency readiness; handling: derive via helper.
      const status = mapReadinessToHealthStatus(readiness);
      const healthResponse = buildHealthResponsePayload(
        status,
        openaiHealth,
        envInfo,
        dbStatus,
        getEnv('DATABASE_URL')
      );

      //audit Assumption: degraded state should still be 200; risk: incorrect status code for degraded; invariant: unhealthy should be 503; handling: map status to HTTP code.
      const httpStatus = status === 'unhealthy' ? 503 : 200;
      res.status(httpStatus).json(healthResponse);
    } catch (error: unknown) {
      //audit Assumption: failure to compute health implies unhealthy; risk: hiding root cause; invariant: health endpoint signals failure; handling: return minimal unhealthy payload.
      //audit Assumption: error may not be an Error instance; risk: losing details; invariant: response includes a message string; handling: normalize to safe string.
      const errorMessage = resolveErrorMessage(error);
      const fallbackOpenAI = buildFallbackOpenAIHealth();
      const fallbackEnv = getEnvironmentInfo();
      const fallbackDbStatus: DatabaseStatusLike = { connected: false, error: 'Service check failed' };
      sendTimestampedStatus(res, 503, {
        //audit Assumption: spreading response payload is safe; risk: overriding fields; invariant: unhealthy response includes error message; handling: append error after payload.
        ...buildHealthResponsePayload(
          'unhealthy',
          fallbackOpenAI,
          fallbackEnv,
          fallbackDbStatus,
          getEnv('DATABASE_URL')
        ),
        error: errorMessage
      });
    }
  }

  /**
   * Simple health check for load balancers.
   *
   * Purpose: Provide a lightweight liveness response.
   * Inputs/Outputs: Accepts Express response and returns a minimal status payload.
   * Edge cases: Always returns ok unless the response stream fails.
   */
  static async getSimpleHealth(req: Request, res: Response): Promise<void> {
    res.status(200).json(buildTimestampedPayload({ status: 'ok' }));
  }
}

export default HealthController;
