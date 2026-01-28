/**
 * Fallback Handler and Degraded Mode Support
 * Provides graceful degradation when AI services are unavailable
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config/index.js';
import { getOpenAIClient } from '../services/openai.js';
import { responseCache } from '../utils/cache.js';
import { ARCANOS_SYSTEM_PROMPTS } from '../config/prompts.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import { getFallbackMessage } from '../config/fallbackMessages.js';
import { FALLBACK_RESPONSE_MESSAGES } from '../config/fallbackResponseMessages.js';
import { FALLBACK_LOG_MESSAGES, FALLBACK_LOG_REASON } from '../config/fallbackLogMessages.js';
import { logger } from '../utils/structuredLogging.js';

export interface DegradedResponse {
  status: 'degraded';
  message: string;
  data: unknown;
  fallbackMode: 'cache' | 'mock' | 'minimal';
  timestamp: string;
}

/**
 * Generates a cached or minimal response when AI services are unavailable
 */
export function generateDegradedResponse(
  prompt: string,
  endpoint: string = 'unknown'
): DegradedResponse {
  const timestamp = new Date().toISOString();
  
  // Try to find a cached response first
  const cacheKey = `fallback_${endpoint}_${prompt.slice(0, 100)}`;
  const cachedResponse = responseCache.get(cacheKey);
  
  if (cachedResponse) {
    return {
      status: 'degraded',
      message: FALLBACK_RESPONSE_MESSAGES.cacheUnavailable,
      data:
        cachedResponse.output || cachedResponse.result || FALLBACK_RESPONSE_MESSAGES.cachedResponsePlaceholder,
      fallbackMode: 'cache',
      timestamp
    };
  }

  // Generate appropriate mock responses based on endpoint
  const mockResponse =
    endpoint === 'ask'
      ? ARCANOS_SYSTEM_PROMPTS.FALLBACK_MODE(prompt)
      : getFallbackMessage(endpoint, prompt);

  return {
    status: 'degraded',
    message: FALLBACK_RESPONSE_MESSAGES.degradedMode,
    data: mockResponse,
    fallbackMode: 'mock',
    timestamp
  };
}

function getEndpointFromRequest(req: Request): string {
  return req.path.split('/').pop() || 'unknown';
}

function extractPromptFromRequest(req: Request, defaultPrompt: string = FALLBACK_RESPONSE_MESSAGES.defaultPrompt): string {
  //audit Assumption: prompt may be in body; Handling: use default when absent
  const body = req.body as Record<string, unknown> | undefined;
  const promptCandidate = body?.prompt ?? body?.scenario ?? body?.query;
  return typeof promptCandidate === 'string' ? promptCandidate : defaultPrompt;
}

function logFallbackEvent(
  type: 'degraded' | 'preemptive',
  endpoint: string,
  reason: string,
  metadata: Record<string, unknown> = {}
): void {
  const message = type === 'degraded'
    ? FALLBACK_LOG_MESSAGES.degraded(endpoint, reason)
    : FALLBACK_LOG_MESSAGES.preemptive(endpoint);

  logger.warn(message, { module: 'fallback', endpoint, reason, ...metadata });
  recordTraceEvent(`fallback.${type}`, { endpoint, reason, ...metadata });
}

/**
 * Fallback middleware that intercepts errors and provides degraded responses
 */
export function createFallbackMiddleware() {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    const errorRecord = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
    const errorMessage = typeof errorRecord.message === 'string' ? errorRecord.message : '';
    // Check if this is an AI service error
    const isAIServiceError = (
      errorMessage.includes('OpenAI') ||
      errorMessage.includes('API key') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('timeout') ||
      errorRecord.status === 503 ||
      errorRecord.status === 504
    );

    if (!isAIServiceError) {
      return next(err);
    }

    // Determine endpoint from request path
    const endpoint = getEndpointFromRequest(req);
    const prompt = extractPromptFromRequest(req);

    logFallbackEvent('degraded', endpoint, errorMessage || FALLBACK_LOG_REASON.unknown);

    const degradedResponse = generateDegradedResponse(prompt, endpoint);

    // Set appropriate HTTP status for degraded mode
    res.status(503).json(degradedResponse);
  };
}

/**
 * Health check for fallback system readiness
 */
export function getFallbackSystemHealth() {
  const client = getOpenAIClient();
  const cacheStats = {
    size: getCacheSize(responseCache),
    hitRate: 0 // Cache doesn't expose hit rate directly
  };
  
  return {
    fallbackSystemReady: true,
    primaryService: {
      available: client !== null,
      status: client ? 'operational' : 'unavailable'
    },
    fallbackCapabilities: {
      cache: {
        enabled: true,
        entries: cacheStats.size || 0,
        hitRate: cacheStats.hitRate || 0
      },
      mockResponses: {
        enabled: true,
        endpoints: ['ask', 'arcanos', 'sim', 'memory']
      },
      degradedMode: {
        enabled: true,
        gracefulDegradation: true
      }
    },
    lastHealthCheck: new Date().toISOString()
  };
}

function getCacheSize(cache: unknown): number {
  if (!cache || typeof cache !== 'object') {
    return 0;
  }
  const size = (cache as { size?: unknown }).size;
  return typeof size === 'number' ? size : 0;
}

/**
 * Middleware to check system health and trigger fallback if needed
 */
export function createHealthCheckMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only apply to AI-related endpoints
    const isAIEndpoint = (
      req.path.includes('/api/arcanos') ||
      req.path.includes('/api/sim') ||
      req.path.includes('/ask') ||
      req.path.includes('/arcanos')
    );

    if (!isAIEndpoint) {
      return next();
    }

    const client = getOpenAIClient();
    const strictEnvs = config.fallback.strictEnvironments;
    const enforcePreemptive = config.fallback.preemptive || strictEnvs.includes(config.server.environment);

    // If OpenAI client is not available, immediately trigger degraded mode
    if (!client && enforcePreemptive) {
      const endpoint = getEndpointFromRequest(req);
      const prompt = extractPromptFromRequest(req, FALLBACK_RESPONSE_MESSAGES.healthCheckPrompt);

      logFallbackEvent('preemptive', endpoint, FALLBACK_LOG_REASON.unavailable, {
        environment: config.server.environment
      });

      const degradedResponse = generateDegradedResponse(prompt, endpoint);
      return res.status(503).json(degradedResponse);
    }

    next();
  };
}

/**
 * Fallback route for testing degraded mode
 */
export function createFallbackTestRoute() {
  return (req: Request, res: Response) => {
    const testResponse = generateDegradedResponse(
      FALLBACK_RESPONSE_MESSAGES.fallbackTestPrompt,
      'test'
    );
    
    res.json({
      ...testResponse,
      message: FALLBACK_RESPONSE_MESSAGES.fallbackTestMessage,
      systemHealth: getFallbackSystemHealth()
    });
  };
}

export default {
  createFallbackMiddleware,
  createHealthCheckMiddleware,
  createFallbackTestRoute,
  generateDegradedResponse,
  getFallbackSystemHealth
};