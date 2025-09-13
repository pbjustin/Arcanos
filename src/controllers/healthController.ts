/**
 * System Health Controller - Business logic for system monitoring
 */

import { Request, Response } from 'express';
import { getOpenAIServiceHealth } from '../services/openai.js';
import { getEnvironmentInfo } from '../utils/environmentValidation.js';
import { env } from '../utils/env.js';

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    openai: any;
    database: any;
    environment: any;
  };
  version: string;
  uptime: number;
}

/**
 * Health check controller
 */
export class HealthController {
  /**
   * Comprehensive health check endpoint
   */
  static async getHealth(req: Request, res: Response<HealthResponse>): Promise<void> {
    try {
      const openaiHealth = getOpenAIServiceHealth();
      const envInfo = getEnvironmentInfo();
      
      // Determine overall health status
      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      
      // Check OpenAI service health
      if (!env.OPENAI_API_KEY) {
        status = 'degraded'; // Running in mock mode
      }
      
      // Check database connectivity
      if (!env.DATABASE_URL) {
        status = 'degraded'; // Running in memory mode
      }

      const healthResponse: HealthResponse = {
        status,
        timestamp: new Date().toISOString(),
        services: {
          openai: openaiHealth,
          database: {
            connected: !!env.DATABASE_URL,
            url: env.DATABASE_URL ? '[CONFIGURED]' : '[NOT_CONFIGURED]'
          },
          environment: envInfo
        },
        version: '1.0.0',
        uptime: process.uptime()
      };

      // Set appropriate HTTP status based on health
      const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
      
      res.status(httpStatus).json(healthResponse);
    } catch {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        services: {
          openai: { error: 'Service check failed' },
          database: { error: 'Service check failed' },
          environment: { error: 'Service check failed' }
        },
        version: '1.0.0',
        uptime: process.uptime()
      });
    }
  }

  /**
   * Simple health check for load balancers
   */
  static async getSimpleHealth(req: Request, res: Response): Promise<void> {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  }
}

export default HealthController;