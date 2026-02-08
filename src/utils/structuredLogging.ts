/**
 * Structured Logging Service
 * Provides comprehensive logging with context and metadata for better observability
 */

import { type NextFunction, type Request, type Response } from 'express';
import { generateRequestId } from './idGenerator.js';
import { recordLogEvent, recordTraceEvent } from './telemetry.js';
import { getEnv } from '../config/env.js';

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
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  metadata?: Record<string, unknown>;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const SENSITIVE_KEYS = ['authorization', 'cookie', 'token', 'password', 'apikey', 'secret', 'privatekey', 'connectionstring'];
const SENSITIVE_VALUE_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{12,}\b/i,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^@\s]+:[^@\s]+@/i,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

function sanitizeStringValue(value: string): string {
  //audit Assumption: token-like literal patterns inside log strings are sensitive; risk: credential leakage in aggregated logs; invariant: redact sensitive literals before output; handling: pattern-match and replace with sentinel.
  if (SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
    return '[REDACTED]';
  }
  return value;
}

// Helper to recursively sanitize potentially sensitive fields before logging
function sanitize(data: any): any {
  if (typeof data === 'string') {
    return sanitizeStringValue(data);
  }

  if (data === null || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitize(item));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.some(sensitiveKey => key.toLowerCase().includes(sensitiveKey))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitize(value);
    }
  }

  return sanitized;
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
    metadata?: Record<string, unknown>,
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

    //audit Assumption: error details should be captured when provided
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
    // Use config layer for env access (adapter boundary pattern)
    const isProduction = getEnv('NODE_ENV') === 'production';

    const sanitizedEntry = {
      ...entry,
      context: entry.context ? sanitize(entry.context) : undefined,
      metadata: entry.metadata ? sanitize(entry.metadata) : undefined,
    };

    //audit Assumption: production logs should be structured JSON
    if (isProduction) {
      // In production, output structured JSON for log aggregation
      console.log(JSON.stringify(sanitizedEntry));
    } else {
      // In development, output human-readable format
      const contextStr = sanitizedEntry.context ? ` [${Object.entries(sanitizedEntry.context).map(([k, v]) => `${k}:${v}`).join(',')}]` : '';
      const durationStr = sanitizedEntry.duration ? ` (${sanitizedEntry.duration}ms)` : '';
      const metadataStr = sanitizedEntry.metadata ? ` ${JSON.stringify(sanitizedEntry.metadata)}` : '';

      console.log(`[${sanitizedEntry.timestamp}] ${sanitizedEntry.level.toUpperCase()}${contextStr}: ${sanitizedEntry.message}${durationStr}${metadataStr}`);

      //audit Assumption: error stacks are useful in dev; Handling: log if present
      if (sanitizedEntry.error && sanitizedEntry.error.stack) {
        console.log(sanitizedEntry.error.stack);
      }
    }

    //audit Assumption: telemetry records should mirror log entries
    recordLogEvent({
      timestamp: sanitizedEntry.timestamp,
      level: sanitizedEntry.level,
      message: sanitizedEntry.message,
      context: sanitizedEntry.context,
      metadata: sanitizedEntry.metadata,
      duration: sanitizedEntry.duration
    });
  }

  /**
   * Logs a debug-level message with optional context and metadata.
   */
  debug(message: string, context?: LogContext, metadata?: Record<string, unknown>): void {
    this.log(this.createLogEntry(LogLevel.DEBUG, message, context, metadata));
  }

  /**
   * Logs an info-level message with optional context and metadata.
   */
  info(message: string, context?: LogContext, metadata?: Record<string, unknown>): void {
    this.log(this.createLogEntry(LogLevel.INFO, message, context, metadata));
  }

  /**
   * Logs a warning-level message with optional context, metadata, and error.
   */
  warn(message: string, context?: LogContext, metadata?: Record<string, unknown>, error?: Error): void {
    this.log(this.createLogEntry(LogLevel.WARN, message, context, metadata, undefined, error));
  }

  /**
   * Logs an error-level message with optional context, metadata, and error.
   */
  error(message: string, context?: LogContext, metadata?: Record<string, unknown>, error?: Error): void {
    this.log(this.createLogEntry(LogLevel.ERROR, message, context, metadata, undefined, error));
  }

  /**
   * Logs the duration of an operation
   */
  timed(
    message: string,
    duration: number,
    context?: LogContext,
    metadata?: Record<string, unknown>,
    level: LogLevel = LogLevel.INFO
  ): void {
    this.log(this.createLogEntry(level, message, context, metadata, duration));
  }

  /**
   * Creates a timer for measuring operation duration
   */
  startTimer(operation: string, context?: LogContext): () => void {
    const startTime = Date.now();
    const startEvent = recordTraceEvent('logger.timer.start', {
      operation,
      context
    });
    return () => {
      const duration = Date.now() - startTime;
      this.timed(`${operation} completed`, duration, context);
      recordTraceEvent('logger.timer.end', {
        operation,
        duration,
        traceId: startEvent.id
      });
    };
  }
}

// Global logger instances
export const logger = new StructuredLogger({ module: 'core' });
export const apiLogger = new StructuredLogger({ module: 'api' });
export const dbLogger = new StructuredLogger({ module: 'database' });
export const aiLogger = new StructuredLogger({ module: 'openai' });
export const workerLogger = new StructuredLogger({ module: 'worker' });

/**
 * Safely serialize log payloads to avoid circular reference and BigInt crashes.
 */
function serializeForLog(data: unknown): string {
  const seenObjects = new WeakSet<object>();
  try {
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === 'bigint') {
        //audit: BigInt is not JSON-serializable; convert to string to preserve value without crashing.
        return value.toString();
      }
      if (typeof value === 'object' && value !== null) {
        //audit: Track object references to prevent circular structure errors.
        if (seenObjects.has(value)) {
          //audit: Circular reference detected; return a placeholder to keep logs intact.
          return '[Circular]';
        }
        seenObjects.add(value);
      }
      return value;
    });
  } catch {
    //audit: Serialization failed; fall back to a safe sentinel string to avoid breaking responses.
    return '"[Unserializable]"';
  }
}

/**
 * Calculate serialized payload size in bytes for response logging.
 */
function getSerializedSizeBytes(data: unknown): number {
  const serialized = serializeForLog(data);
  //audit: Buffer byte length is used as a consistent UTF-8 size estimator for logging metadata.
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Express middleware for request logging
 */
type RequestWithLogger = Request & {
  requestId?: string;
  logger?: StructuredLogger;
};

export function requestLoggingMiddleware(req: RequestWithLogger, res: Response, next: NextFunction) {
  const rawRequestId = req.headers['x-request-id'];
  const requestId =
    typeof rawRequestId === 'string'
      ? rawRequestId
      : Array.isArray(rawRequestId)
        ? rawRequestId[0]
        : generateRequestId('req');
  const startTime = Date.now();
  
  // Add request ID to request object
  req.requestId = requestId;
  
  // Create request-scoped logger
  const requestLogger = apiLogger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.get('User-Agent')
  });
  req.logger = requestLogger;

  // Log request start
  //audit Assumption: request metadata should avoid sensitive data; Handling: sanitize
  requestLogger.info('Request started', {
    ip: req.ip,
    query: Object.keys(req.query).length > 0 ? sanitize(req.query) : undefined,
    headers: sanitize({
      authorization: req.headers['authorization'],
      cookie: req.headers['cookie']
    })
  });

  // Override res.json to log response
  const originalJson = res.json;
  res.json = function(data: unknown) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    //audit Assumption: response size helps diagnostics; Handling: compute safely
    requestLogger.timed(
      `Request completed`,
      duration,
      { statusCode },
      { 
        responseSize: getSerializedSizeBytes(data),
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
  private metrics: Map<string, { value: unknown; timestamp: number }> = new Map();

  /**
   * Records a health metric value with the current timestamp.
   */
  record(key: string, value: unknown): void {
    this.metrics.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  /**
   * Increments a numeric metric value by the provided amount.
   */
  increment(key: string, amount: number = 1): void {
    const currentValue = this.metrics.get(key)?.value;
    const current = typeof currentValue === 'number' ? currentValue : 0;
    this.record(key, current + amount);
  }

  /**
   * Returns a raw metrics map suitable for internal inspection.
   */
  getMetrics(): Record<string, { value: unknown; timestamp: number }> {
    const result: Record<string, { value: unknown; timestamp: number }> = {};
    for (const [key, metric] of this.metrics.entries()) {
      result[key] = metric;
    }
    return result;
  }

  /**
   * Returns a snapshot including process uptime and memory usage.
   */
  getSnapshot(): Record<string, unknown> {
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
