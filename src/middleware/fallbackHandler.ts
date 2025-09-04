/**
 * Fallback Handler and Degraded Mode Support
 * Provides graceful degradation when AI services are unavailable
 */

import { Request, Response, NextFunction } from 'express';
import { getOpenAIClient } from '../services/openai.js';
import { responseCache } from '../utils/cache.js';

export interface DegradedResponse {
  status: 'degraded';
  message: string;
  data: any;
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
      message: 'Service temporarily unavailable - returning cached response',
      data: cachedResponse.output || cachedResponse.result || 'Cached response available',
      fallbackMode: 'cache',
      timestamp
    };
  }

  // Generate appropriate mock responses based on endpoint
  const mockResponses = {
    ask: `I understand you're asking: "${prompt.slice(0, 200)}". However, I'm currently operating in degraded mode due to temporary service limitations. Please try again in a few moments.`,
    arcanos: `ARCANOS system temporarily operating in fallback mode. Your request has been noted but cannot be fully processed at this time.`,
    sim: `Simulation request received but cannot be processed in degraded mode. Please retry when services are restored.`,
    memory: `Memory operation temporarily unavailable. System is operating in read-only fallback mode.`,
    default: `Service temporarily unavailable. Operating in degraded mode with limited functionality.`
  };

  const mockResponse = mockResponses[endpoint as keyof typeof mockResponses] || mockResponses.default;

  return {
    status: 'degraded',
    message: 'AI services temporarily unavailable - operating in degraded mode',
    data: mockResponse,
    fallbackMode: 'mock',
    timestamp
  };
}

/**
 * Fallback middleware that intercepts errors and provides degraded responses
 */
export function createFallbackMiddleware() {
  return (err: any, req: Request, res: Response, next: NextFunction) => {
    // Check if this is an AI service error
    const isAIServiceError = (
      err.message?.includes('OpenAI') ||
      err.message?.includes('API key') ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('timeout') ||
      err.status === 503 ||
      err.status === 504
    );

    if (!isAIServiceError) {
      return next(err);
    }

    // Determine endpoint from request path
    const endpoint = req.path.split('/').pop() || 'unknown';
    const prompt = req.body?.prompt || req.body?.scenario || req.body?.query || 'No input provided';

    console.log(`🔄 Fallback mode activated for ${endpoint} - ${err.message}`);

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
    size: (responseCache as any).size || 0,
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
    
    // If OpenAI client is not available, immediately trigger degraded mode
    if (!client && process.env.NODE_ENV === 'production') {
      const endpoint = req.path.split('/').pop() || 'unknown';
      const prompt = req.body?.prompt || req.body?.scenario || req.body?.query || 'Health check triggered fallback';
      
      console.log(`🔄 Preemptive fallback mode activated for ${endpoint} - OpenAI client unavailable`);
      
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
      'Test degraded mode functionality',
      'test'
    );
    
    res.json({
      ...testResponse,
      message: 'Fallback system test - this endpoint simulates degraded mode',
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