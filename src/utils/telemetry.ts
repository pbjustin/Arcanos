/**
 * Telemetry Service
 * 
 * Provides centralized telemetry collection and monitoring for the Arcanos backend.
 * Tracks log events, trace events, and operational metrics in memory with configurable
 * buffer limits. Supports event-driven listeners for real-time monitoring.
 * 
 * @module telemetry
 */

import { EventEmitter } from 'events';
import { generateRequestId } from './idGenerator.js';

/**
 * Supported telemetry log levels for categorizing events by severity.
 */
type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log event structure capturing a single telemetry log entry.
 */
export interface TelemetryLogEvent {
  id: string;
  timestamp: string;
  level: TelemetryLevel;
  message: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown> | undefined;
  duration?: number;
}

/**
 * Trace event structure for tracking distributed operations and request flows.
 */
export interface TelemetryTraceEvent {
  id: string;
  timestamp: string;
  name: string;
  attributes?: Record<string, unknown>;
}

/**
 * Internal metrics aggregating telemetry data across log levels and operations.
 */
interface TelemetryMetrics {
  totalLogs: number;
  logsByLevel: Record<TelemetryLevel, number>;
  operations: Record<string, { count: number; lastTimestamp: string }>; 
}

/**
 * In-memory telemetry state containing metrics, recent logs, and trace events.
 */
interface TelemetryState {
  metrics: TelemetryMetrics;
  recentLogs: TelemetryLogEvent[];
  traceEvents: TelemetryTraceEvent[];
}

function parseLimit(envValue: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envValue ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

const MAX_RECENT_LOGS = parseLimit(process.env.TELEMETRY_RECENT_LOGS_LIMIT, 100);
const MAX_TRACE_EVENTS = parseLimit(process.env.TELEMETRY_TRACE_EVENT_LIMIT, 200);
const RECENT_LOG_BUFFER_LIMIT = Math.max(10, MAX_RECENT_LOGS);
const TRACE_EVENT_BUFFER_LIMIT = Math.max(25, MAX_TRACE_EVENTS);

const telemetryEmitter = new EventEmitter();

const telemetryState: TelemetryState = {
  metrics: {
    totalLogs: 0,
    logsByLevel: {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    },
    operations: {}
  },
  recentLogs: [],
  traceEvents: []
};

/**
 * Ensures a buffer does not exceed its maximum size by removing oldest entries.
 * @param buffer - Array to clamp
 * @param maxSize - Maximum allowed size
 */
function clampBuffer<T>(buffer: T[], maxSize: number): void {
  while (buffer.length > maxSize) {
    buffer.shift();
  }
}

/**
 * Records a log event with automatic ID generation and metrics aggregation.
 * Emits the event to registered listeners and maintains a bounded buffer of recent logs.
 * 
 * @param entry - Log entry without ID (ID is auto-generated)
 * @returns The complete log event with generated ID
 */
export function recordLogEvent(entry: Omit<TelemetryLogEvent, 'id'>): TelemetryLogEvent {
  const event: TelemetryLogEvent = {
    ...entry,
    id: generateRequestId('log')
  };

  telemetryState.metrics.totalLogs += 1;
  if (telemetryState.metrics.logsByLevel[event.level] !== undefined) {
    telemetryState.metrics.logsByLevel[event.level] += 1;
  }

  telemetryState.recentLogs.push(event);
  clampBuffer(telemetryState.recentLogs, RECENT_LOG_BUFFER_LIMIT);

  telemetryEmitter.emit('log', event);
  return event;
}

/**
 * Records a distributed trace event for tracking operations across service boundaries.
 * 
 * @param name - Name identifying the traced operation
 * @param attributes - Optional key-value attributes providing operation context
 * @returns The complete trace event
 */
export function recordTraceEvent(name: string, attributes: Record<string, unknown> = {}): TelemetryTraceEvent {
  const event: TelemetryTraceEvent = {
    id: generateRequestId('trace'),
    timestamp: new Date().toISOString(),
    name,
    attributes
  };

  telemetryState.traceEvents.push(event);
  clampBuffer(telemetryState.traceEvents, TRACE_EVENT_BUFFER_LIMIT);
  telemetryEmitter.emit('trace', event);
  return event;
}

/**
 * Marks an operation occurrence, incrementing its count and updating the last timestamp.
 * Useful for tracking API calls, database queries, and other repeated operations.
 * 
 * @param name - Operation identifier
 */
export function markOperation(name: string): void {
  const now = new Date().toISOString();
  const existing = telemetryState.metrics.operations[name];
  telemetryState.metrics.operations[name] = {
    count: existing ? existing.count + 1 : 1,
    lastTimestamp: now
  };
  recordTraceEvent(`operation.${name}`, { count: telemetryState.metrics.operations[name].count });
}

/**
 * Retrieves a complete snapshot of current telemetry state including metrics and traces.
 * Safe for serialization and external monitoring integrations.
 * 
 * @returns Telemetry snapshot with timestamp
 */
export function getTelemetrySnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    metrics: telemetryState.metrics,
    traces: {
      recentLogs: [...telemetryState.recentLogs],
      recentEvents: [...telemetryState.traceEvents]
    }
  };
}

/**
 * Registers a listener for telemetry events (logs or traces).
 * Enables real-time monitoring and integration with external systems.
 * 
 * @param event - Event type to listen for ('log' or 'trace')
 * @param listener - Callback invoked when events are emitted
 */
export function onTelemetry(event: 'log' | 'trace', listener: (payload: TelemetryLogEvent | TelemetryTraceEvent) => void) {
  telemetryEmitter.on(event, listener as any);
}

/**
 * Resets all telemetry state to initial values.
 * Primarily used for testing or manual maintenance operations.
 */
export function resetTelemetry(): void {
  telemetryState.metrics.totalLogs = 0;
  telemetryState.metrics.logsByLevel = { debug: 0, info: 0, warn: 0, error: 0 };
  telemetryState.metrics.operations = {};
  telemetryState.recentLogs.length = 0;
  telemetryState.traceEvents.length = 0;
}

