/**
 * System Health Controller - Business logic for system monitoring
 */

import { Request, Response } from 'express';
import { getOpenAIServiceHealth } from '../services/openai.js';
import { getEnvironmentInfo } from '../utils/environmentValidation.js';
import { buildTimestampedPayload } from '../utils/responseHelpers.js';
import { env } from '../utils/env.js';

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  services: {
    openai: any;
    database: any;
    environment: any;
  };
  version: string;
  uptime: number;
}

function determineHealthStatus(hasOpenAiKey: boolean, hasDatabaseUrl: boolean): HealthStatus {
  let status: HealthStatus = 'healthy';

  //audit Assumption: missing OpenAI key implies degraded health; risk: misclassifying expected mock mode; invariant: status reflects critical dependencies; handling: downgrade to degraded.
  if (!hasOpenAiKey) {
    status = 'degraded';
  }

  //audit Assumption: missing database URL implies degraded health; risk: false positives in memory mode; invariant: status reflects critical dependencies; handling: downgrade to degraded.
  if (!hasDatabaseUrl) {
    status = 'degraded';
  }

  return status;
}

function buildHealthResponsePayload(
  status: HealthStatus,
  openaiHealth: unknown,
  envInfo: unknown,
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
        connected: isDatabaseConfigured,
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

      //audit Assumption: health status derives from OpenAI and database configuration; risk: missing signals from other dependencies; invariant: status reflects core dependency readiness; handling: derive via helper.
      const status = determineHealthStatus(!!env.OPENAI_API_KEY, !!env.DATABASE_URL);
      const healthResponse = buildHealthResponsePayload(
        status,
        openaiHealth,
        envInfo,
        env.DATABASE_URL
      );

      //audit Assumption: degraded state should still be 200; risk: incorrect status code for degraded; invariant: unhealthy should be 503; handling: map status to HTTP code.
      const httpStatus = status === 'unhealthy' ? 503 : 200;
      res.status(httpStatus).json(healthResponse);
    } catch (error) {
      //audit Assumption: failure to compute health implies unhealthy; risk: hiding root cause; invariant: health endpoint signals failure; handling: return minimal unhealthy payload.
      //audit Assumption: error may not be an Error instance; risk: losing details; invariant: response includes a message string; handling: normalize to safe string.
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(503).json({
        //audit Assumption: spreading response payload is safe; risk: overriding fields; invariant: unhealthy response includes error message; handling: append error after payload.
        ...buildHealthResponsePayload(
          'unhealthy',
          { error: 'Service check failed' },
          { error: 'Service check failed' },
          env.DATABASE_URL
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
