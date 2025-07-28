import { EventEmitter } from 'events';
import type { LogLevel } from '../utils/logger';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context?: any;
}

const logEmitter = new EventEmitter();
const logBuffer: LogRecord[] = [];
const MAX_LOGS = 200;

export function relayLog(record: LogRecord): void {
  logBuffer.push(record);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }
  logEmitter.emit('log', record);
}

export function getRecentLogs(): LogRecord[] {
  return [...logBuffer];
}

export function onLog(listener: (record: LogRecord) => void): void {
  logEmitter.on('log', listener);
}
