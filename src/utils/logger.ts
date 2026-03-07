import { logger as structuredLogger } from '../platform/logging/structuredLogging.js';

export interface DagLogger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

class StructuredDagLogger implements DagLogger {
  debug(message: string, metadata?: Record<string, unknown>): void {
    structuredLogger.debug(message, { module: 'dag' }, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    structuredLogger.info(message, { module: 'dag' }, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    structuredLogger.warn(message, { module: 'dag' }, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    structuredLogger.error(message, { module: 'dag' }, metadata);
  }
}

export const dagLogger: DagLogger = new StructuredDagLogger();
