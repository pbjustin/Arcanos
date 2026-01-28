/**
 * Unified Telemetry Module
 * 
 * Provides Railway-native telemetry patterns for tracing, metrics, and logging.
 * Wraps and enhances the existing telemetry module with additional utilities.
 * 
 * Features:
 * - Request tracing with automatic span management
 * - Performance metrics collection
 * - Error tracking with context
 * - Railway-compatible logging
 * - Operation timing and profiling
 * 
 * @module unifiedTelemetry
 */

import {
  recordTraceEvent,
  recordLogEvent,
  markOperation,
  TelemetryLogEvent,
  TelemetryTraceEvent
} from '../telemetry.js';
import { aiLogger } from '../structuredLogging.js';
import { generateRequestId } from '../idGenerator.js';

/**
 * Span for tracing operations
 */
export interface Span {
  /** Span ID */
  id: string;
  /** Span name */
  name: string;
  /** Start time */
  startTime: number;
  /** End time (if completed) */
  endTime?: number;
  /** Span attributes */
  attributes: Record<string, unknown>;
  /** Child spans */
  children: Span[];
  /** Parent span ID */
  parentId?: string;
}

/**
 * Metric value with tags
 */
export interface Metric {
  /** Metric name */
  name: string;
  /** Metric value */
  value: number;
  /** Metric tags */
  tags: Record<string, string>;
  /** Timestamp */
  timestamp: string;
}

/**
 * Active span storage (for nested spans)
 */
const activeSpans = new Map<string, Span>();

/**
 * Creates a new span for tracing operations
 * 
 * Spans are used to track the duration and context of operations.
 * Supports nested spans for complex operation tracing.
 * 
 * @param name - Span name
 * @param attributes - Span attributes
 * @param parentId - Parent span ID (for nested spans)
 * @returns Span instance
 */
export function createSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  parentId?: string
): Span {
  const spanId = generateRequestId('span');
  const startTime = Date.now();

  const span: Span = {
    id: spanId,
    name,
    startTime,
    attributes: {
      ...attributes,
      parentId
    },
    children: []
  };

  // Add to parent span if provided
  if (parentId) {
    const parent = activeSpans.get(parentId);
    if (parent) {
      parent.children.push(span);
    }
  }

  activeSpans.set(spanId, span);

  recordTraceEvent(`span.start.${name}`, {
    spanId,
    parentId,
    ...attributes
  });

  return span;
}

/**
 * Ends a span and records its duration
 * 
 * @param span - Span to end
 * @param attributes - Additional attributes to add
 */
export function endSpan(span: Span, attributes: Record<string, unknown> = {}): void {
  const endTime = Date.now();
  const duration = endTime - span.startTime;

  span.endTime = endTime;
  span.attributes = {
    ...span.attributes,
    ...attributes,
    duration
  };

  activeSpans.delete(span.id);

  recordTraceEvent(`span.end.${span.name}`, {
    spanId: span.id,
    duration,
    ...span.attributes
  });

  // Log if duration is significant
  if (duration > 1000) {
    aiLogger.warn(`Long-running operation: ${span.name}`, {
      module: 'telemetry.unified',
      operation: 'endSpan',
      duration,
      ...span.attributes
    });
  }
}

/**
 * Traces an async operation with automatic span management
 * 
 * Creates a span, executes the operation, and automatically ends the span.
 * Handles errors and records them in the span.
 * 
 * @param name - Operation name
 * @param operation - Async operation to trace
 * @param attributes - Additional span attributes
 * @returns Operation result
 */
export async function traceOperation<T>(
  name: string,
  operation: () => Promise<T>,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const span = createSpan(name, attributes);
  const traceId = recordTraceEvent(`operation.start.${name}`, {
    spanId: span.id,
    ...attributes
  });

  try {
    const result = await operation();
    endSpan(span, { success: true });
    recordTraceEvent(`operation.success.${name}`, {
      spanId: span.id,
      traceId: traceId.id
    });
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    endSpan(span, {
      success: false,
      error: errorMessage
    });
    recordTraceEvent(`operation.error.${name}`, {
      spanId: span.id,
      traceId: traceId.id,
      error: errorMessage
    });
    throw error;
  }
}

/**
 * Records a metric with tags
 * 
 * Metrics are used to track numerical values over time.
 * Tags allow filtering and grouping metrics.
 * 
 * @param name - Metric name
 * @param value - Metric value
 * @param tags - Metric tags
 */
export function recordMetric(
  name: string,
  value: number,
  tags: Record<string, string> = {}
): void {
  const metric: Metric = {
    name,
    value,
    tags,
    timestamp: new Date().toISOString()
  };

  recordTraceEvent(`metric.${name}`, {
    value,
    tags,
    timestamp: metric.timestamp
  });

  // Also mark as operation for counting
  markOperation(`metric.${name}`);
}

/**
 * Records an error with full context
 * 
 * Provides structured error logging with telemetry integration.
 * 
 * @param error - Error to record
 * @param context - Additional context
 * @param level - Log level (default: 'error')
 */
export function recordError(
  error: Error | unknown,
  context: Record<string, unknown> = {},
  level: 'error' | 'warn' = 'error'
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  recordLogEvent({
    timestamp: new Date().toISOString(),
    level,
    message: errorMessage,
    context: {
      ...context,
      error: {
        name: error instanceof Error ? error.name : 'Unknown',
        message: errorMessage,
        stack: errorStack
      }
    },
    metadata: context
  });

  recordTraceEvent('error.recorded', {
    error: errorMessage,
    level,
    ...context
  });
}

/**
 * Creates a timer for measuring operation duration
 * 
 * Returns a function that, when called, records the duration.
 * 
 * @param operation - Operation name
 * @param attributes - Additional attributes
 * @returns Function to call when operation completes
 */
export function startTimer(
  operation: string,
  attributes: Record<string, unknown> = {}
): () => void {
  const startTime = Date.now();
  const traceId = recordTraceEvent(`timer.start.${operation}`, {
    ...attributes
  });

  return () => {
    const duration = Date.now() - startTime;
    recordTraceEvent(`timer.end.${operation}`, {
      traceId: traceId.id,
      duration,
      ...attributes
    });
    recordMetric(`operation.duration.${operation}`, duration, {
      operation
    });
  };
}

/**
 * Railway-compatible logging
 * 
 * Formats logs for Railway's log aggregation system.
 * In production, outputs structured JSON.
 * 
 * @param level - Log level
 * @param message - Log message
 * @param metadata - Additional metadata
 */
export function logRailway(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  metadata: Record<string, unknown> = {}
): void {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    // Railway-compatible structured JSON logging
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...metadata,
      service: 'arcanos-backend',
      environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'development'
    };
    console.log(JSON.stringify(logEntry));
  } else {
    // Human-readable format for development
    aiLogger[level](message, {
      module: 'telemetry.unified',
      ...metadata
    });
  }

  recordLogEvent({
    timestamp: new Date().toISOString(),
    level,
    message,
    metadata
  });
}

/**
 * Gets active spans (for debugging)
 * 
 * @returns Array of active spans
 */
export function getActiveSpans(): Span[] {
  return Array.from(activeSpans.values());
}

/**
 * Clears all active spans (for testing/cleanup)
 */
export function clearSpans(): void {
  activeSpans.clear();
}

/**
 * Default export for convenience
 */
export default {
  createSpan,
  endSpan,
  traceOperation,
  recordMetric,
  recordError,
  startTimer,
  logRailway,
  getActiveSpans,
  clearSpans
};
