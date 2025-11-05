/**
 * Structured Logging Service
 * Provides comprehensive logging with context and metadata for better observability
 */

import { generateRequestId } from './idGenerator.js';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info', 
  WARN = 'warn',
  ERROR = 'error'
}

export interface LogContext {
  requestId?: string;
  userId?: string;
  sessionId?: string;
  module?: string;
  operation?: string;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  metadata?: any;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class StructuredLogger {
  private defaultContext: LogContext = {};

  constructor(defaultContext: LogContext = {}) {
    this.defaultContext = defaultContext;
  }

  /**
   * Sets default context that will be included in all log entries
   */
  setDefaultContext(context: LogContext): void {
    this.defaultContext = { ...this.defaultContext, ...context };
  }

  /**
   * Creates a child logger with additional context
   */
  child(context: LogContext): StructuredLogger {
    return new StructuredLogger({ ...this.defaultContext, ...context });
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    context?: LogContext,
    metadata?: any,
    duration?: number,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.defaultContext, ...context },
      metadata,
      duration
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }

    return entry;
  }

  private log(entry: LogEntry): void {
    const isProduction = process.env.NODE_ENV === 'production';
    
    if (isProduction) {
      // In production, output structured JSON for log aggregation
      console.log(JSON.stringify(entry));
    } else {
      // In development, output human-readable format
      const contextStr = entry.context ? ` [${Object.entries(entry.context).map(([k, v]) => `${k}:${v}`).join(',')}]` : '';
      const durationStr = entry.duration ? ` (${entry.duration}ms)` : '';
      const metadataStr = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : '';
      
      console.log(`[${entry.timestamp}] ${entry.level.toUpperCase()}${contextStr}: ${entry.message}${durationStr}${metadataStr}`);
      
      if (entry.error && entry.error.stack) {
        console.log(entry.error.stack);
      }
    }
  }

  debug(message: string, context?: LogContext, metadata?: any): void {
    this.log(this.createLogEntry(LogLevel.DEBUG, message, context, metadata));
  }

  info(message: string, context?: LogContext, metadata?: any): void {
    this.log(this.createLogEntry(LogLevel.INFO, message, context, metadata));
  }

  warn(message: string, context?: LogContext, metadata?: any, error?: Error): void {
    this.log(this.createLogEntry(LogLevel.WARN, message, context, metadata, undefined, error));
  }

  error(message: string, context?: LogContext, metadata?: any, error?: Error): void {
    this.log(this.createLogEntry(LogLevel.ERROR, message, context, metadata, undefined, error));
  }

  /**
   * Logs the duration of an operation
   */
  timed(
    message: string,
    duration: number,
    context?: LogContext,
    metadata?: any,
    level: LogLevel = LogLevel.INFO
  ): void {
    this.log(this.createLogEntry(level, message, context, metadata, duration));
  }

  /**
   * Creates a timer for measuring operation duration
   */
  startTimer(operation: string, context?: LogContext): () => void {
    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      this.timed(`${operation} completed`, duration, context);
    };
  }
}

// Global logger instances
export const logger = new StructuredLogger({ module: 'core' });
export const apiLogger = new StructuredLogger({ module: 'api' });
export const dbLogger = new StructuredLogger({ module: 'database' });
export const aiLogger = new StructuredLogger({ module: 'openai' });
export const workerLogger = new StructuredLogger({ module: 'worker' });

// Helper to sanitize potentially sensitive fields before logging
function sanitize(obj: Record<string, any>): Record<string, any> {
  const SENSITIVE_KEYS = ['authorization', 'cookie', 'token', 'password'];
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = SENSITIVE_KEYS.includes(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return sanitized;
}

/**
 * Express middleware for request logging
 */
export function requestLoggingMiddleware(req: any, res: any, next: any) {
  const requestId = req.headers['x-request-id'] || generateRequestId('req');
  const startTime = Date.now();
  
  // Add request ID to request object
  req.requestId = requestId;
  
  // Create request-scoped logger
  req.logger = apiLogger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.get('User-Agent')
  });

  // Log request start
  req.logger.info('Request started', {
    ip: req.ip,
    query: Object.keys(req.query).length > 0 ? sanitize(req.query) : undefined,
    headers: sanitize({
      authorization: req.headers['authorization'],
      cookie: req.headers['cookie']
    })
  });

  // Override res.json to log response
  const originalJson = res.json;
  res.json = function(data: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    req.logger.timed(
      `Request completed`,
      duration,
      { statusCode },
      { 
        responseSize: JSON.stringify(data).length,
        success: statusCode < 400
      },
      statusCode >= 400 ? LogLevel.WARN : LogLevel.INFO
    );
    
    return originalJson.call(this, data);
  };

  next();
}

/**
 * Health metrics collection
 */
class HealthMetrics {
  private metrics: Map<string, any> = new Map();

  record(key: string, value: any): void {
    this.metrics.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  increment(key: string, amount: number = 1): void {
    const current = this.metrics.get(key)?.value || 0;
    this.record(key, current + amount);
  }

  getMetrics(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, metric] of this.metrics.entries()) {
      result[key] = metric;
    }
    return result;
  }

  getSnapshot(): Record<string, any> {
    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      metrics: this.getMetrics()
    };
  }
}

export const healthMetrics = new HealthMetrics();

// Export default for backwards compatibility
export default logger;