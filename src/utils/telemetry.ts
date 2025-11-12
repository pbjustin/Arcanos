import { EventEmitter } from 'events';
import { generateRequestId } from './idGenerator.js';

type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryLogEvent {
  id: string;
  timestamp: string;
  level: TelemetryLevel;
  message: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown> | undefined;
  duration?: number;
}

export interface TelemetryTraceEvent {
  id: string;
  timestamp: string;
  name: string;
  attributes?: Record<string, unknown>;
}

interface TelemetryMetrics {
  totalLogs: number;
  logsByLevel: Record<TelemetryLevel, number>;
  operations: Record<string, { count: number; lastTimestamp: string }>; 
}

interface TelemetryState {
  metrics: TelemetryMetrics;
  recentLogs: TelemetryLogEvent[];
  traceEvents: TelemetryTraceEvent[];
}

const MAX_RECENT_LOGS = parseInt(process.env.TELEMETRY_RECENT_LOGS_LIMIT || '100', 10);
const MAX_TRACE_EVENTS = parseInt(process.env.TELEMETRY_TRACE_EVENT_LIMIT || '200', 10);

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

function clampBuffer<T>(buffer: T[], maxSize: number): void {
  while (buffer.length > maxSize) {
    buffer.shift();
  }
}

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
  clampBuffer(telemetryState.recentLogs, Math.max(10, MAX_RECENT_LOGS));

  telemetryEmitter.emit('log', event);
  return event;
}

export function recordTraceEvent(name: string, attributes: Record<string, unknown> = {}): TelemetryTraceEvent {
  const event: TelemetryTraceEvent = {
    id: generateRequestId('trace'),
    timestamp: new Date().toISOString(),
    name,
    attributes
  };

  telemetryState.traceEvents.push(event);
  clampBuffer(telemetryState.traceEvents, Math.max(25, MAX_TRACE_EVENTS));
  telemetryEmitter.emit('trace', event);
  return event;
}

export function markOperation(name: string): void {
  const now = new Date().toISOString();
  const existing = telemetryState.metrics.operations[name];
  telemetryState.metrics.operations[name] = {
    count: existing ? existing.count + 1 : 1,
    lastTimestamp: now
  };
  recordTraceEvent(`operation.${name}`, { count: telemetryState.metrics.operations[name].count });
}

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

export function onTelemetry(event: 'log' | 'trace', listener: (payload: TelemetryLogEvent | TelemetryTraceEvent) => void) {
  telemetryEmitter.on(event, listener as any);
}

export function resetTelemetry(): void {
  telemetryState.metrics.totalLogs = 0;
  telemetryState.metrics.logsByLevel = { debug: 0, info: 0, warn: 0, error: 0 };
  telemetryState.metrics.operations = {};
  telemetryState.recentLogs.length = 0;
  telemetryState.traceEvents.length = 0;
}

