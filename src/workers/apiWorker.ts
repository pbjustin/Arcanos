/**
 * API Worker - Handles API request processing and external service integration
 * Integrated with AI dispatcher for intelligent API routing and processing
 */

import { createServiceLogger } from '../utils/logger';
import { exponentialDelay } from '../utils/delay';
import axios from 'axios';

const logger = createServiceLogger('ApiWorker');

export interface ApiTask {
  action: 'request' | 'webhook' | 'proxy' | 'batch' | 'monitor';
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url?: string;
  data?: any;
  headers?: Record<string, string>;
  options?: {
    timeout?: number;
    retries?: number;
    cache?: boolean;
    validate?: boolean;
  };
  batch?: {
    requests: Array<{
      method: string;
      url: string;
      data?: any;
      headers?: Record<string, string>;
    }>;
  };
}

export interface ApiResponse {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: {
    timestamp: string;
    statusCode?: number;
    responseTime?: number;
    retryCount?: number;
  };
}

/**
 * Main API worker handler function
 */
export async function handle(task: ApiTask): Promise<ApiResponse> {
  const startTime = Date.now();
  logger.info('Processing API task', { action: task.action, method: task.method, url: task.url });

  try {
    let result: any;

    switch (task.action) {
      case 'request':
        result = await makeApiRequest(task);
        break;
      
      case 'webhook':
        result = await processWebhook(task);
        break;
      
      case 'proxy':
        result = await proxyRequest(task);
        break;
      
      case 'batch':
        result = await processBatchRequests(task);
        break;
      
      case 'monitor':
        result = await monitorApiHealth();
        break;
      
      default:
        throw new Error(`Unknown API action: ${task.action}`);
    }

    const responseTime = Date.now() - startTime;
    logger.success(`API task completed in ${responseTime}ms`, { action: task.action });

    return {
      success: true,
      data: result,
      metadata: {
        timestamp: new Date().toISOString(),
        responseTime
      }
    };

  } catch (error: any) {
    const responseTime = Date.now() - startTime;
    logger.error('API task failed', { action: task.action, error: error.message, responseTime });

    return {
      success: false,
      error: error.message,
      metadata: {
        timestamp: new Date().toISOString(),
        responseTime
      }
    };
  }
}

/**
 * Make API request with retry logic and error handling
 */
async function makeApiRequest(task: ApiTask): Promise<any> {
  const { method = 'GET', url, data, headers = {}, options = {} } = task;
  
  if (!url) {
    throw new Error('URL is required for API requests');
  }

  const axiosConfig = {
    method: method.toLowerCase(),
    url,
    data,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Arcanos-API-Worker/1.0',
      ...headers
    },
    timeout: options.timeout || 30000,
    validateStatus: (status: number) => options.validate ? status < 400 : true
  };

  let lastError: any;
  const maxRetries = options.retries || 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`API request attempt ${attempt + 1}`, { method, url });
      const response = await axios(axiosConfig);
      
      logger.info('API request successful', { 
        status: response.status, 
        size: JSON.stringify(response.data).length 
      });

      return {
        statusCode: response.status,
        headers: response.headers,
        data: response.data,
        requestConfig: {
          method,
          url,
          attempt: attempt + 1
        }
      };

    } catch (error: any) {
      lastError = error;
      logger.warning(`API request attempt ${attempt + 1} failed`, { 
        error: error.message,
        status: error.response?.status
      });

      if (attempt < maxRetries) {
        // Exponential backoff with modernized delay pattern
        await exponentialDelay(attempt);
      }
    }
  }

  throw lastError;
}

/**
 * Process incoming webhook data
 */
async function processWebhook(task: ApiTask): Promise<any> {
  logger.info('Processing webhook data', { dataSize: JSON.stringify(task.data).length });

  // Validate webhook signature if headers contain signature
  if (task.headers?.['x-hub-signature-256']) {
    logger.info('Webhook signature validation would be performed here');
  }

  // Process webhook payload
  const processed = {
    received: new Date().toISOString(),
    source: task.headers?.['user-agent'] || 'unknown',
    payload: task.data,
    headers: task.headers
  };

  logger.info('Webhook processed successfully');
  return processed;
}

/**
 * Proxy request to another service
 */
async function proxyRequest(task: ApiTask): Promise<any> {
  logger.info('Proxying request', { method: task.method, url: task.url });

  // Add proxy headers
  const proxyHeaders = {
    ...task.headers,
    'X-Forwarded-By': 'Arcanos-API-Worker',
    'X-Proxy-Timestamp': new Date().toISOString()
  };

  const proxiedTask = {
    ...task,
    headers: proxyHeaders
  };

  return await makeApiRequest(proxiedTask);
}

/**
 * Process batch API requests
 */
async function processBatchRequests(task: ApiTask): Promise<any> {
  if (!task.batch?.requests) {
    throw new Error('Batch requests array is required');
  }

  logger.info('Processing batch requests', { count: task.batch.requests.length });

  const results = [];
  const concurrency = 5; // Process 5 requests at a time

  for (let i = 0; i < task.batch.requests.length; i += concurrency) {
    const batch = task.batch.requests.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (request, index) => {
      try {
        const requestTask: ApiTask = {
          action: 'request',
          method: request.method as any,
          url: request.url,
          data: request.data,
          headers: request.headers,
          options: task.options
        };

        const result = await makeApiRequest(requestTask);
        return { index: i + index, success: true, result };
      } catch (error: any) {
        return { index: i + index, success: false, error: error.message };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.length - successful;

  logger.info('Batch processing completed', { total: results.length, successful, failed });

  return {
    total: results.length,
    successful,
    failed,
    results
  };
}

/**
 * Monitor API health and connectivity
 */
async function monitorApiHealth(): Promise<any> {
  logger.info('Performing API health check');

  const healthChecks: Array<{ name: string; url?: string; internal?: boolean }> = [
    { name: 'Local Health', url: 'http://localhost:3000/health' },
    { name: 'Memory Usage', internal: true }
  ];

  const results = [];

  for (const check of healthChecks) {
    try {
      if (check.internal) {
        // Internal health check
        const memUsage = process.memoryUsage();
        results.push({
          name: check.name,
          status: 'healthy',
          data: {
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            rssMB: Math.round(memUsage.rss / 1024 / 1024),
            uptime: process.uptime()
          }
        });
      } else {
        // External API health check
        if (check.url) {
          const response = await axios.get(check.url, { timeout: 5000 });
          results.push({
            name: check.name,
            status: response.status < 400 ? 'healthy' : 'degraded',
            statusCode: response.status,
            responseTime: Date.now()
          });
        } else {
          results.push({
            name: check.name,
            status: 'misconfigured',
            error: 'No URL provided for external health check'
          });
        }
      }
    } catch (error: any) {
      results.push({
        name: check.name,
        status: 'unhealthy',
        error: error.message
      });
    }
  }

  const overallStatus = results.every(r => r.status === 'healthy') ? 'healthy' : 'degraded';
  
  logger.info('Health check completed', { status: overallStatus, checks: results.length });

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks: results
  };
}