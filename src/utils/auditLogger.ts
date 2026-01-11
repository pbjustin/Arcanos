/**
 * auditLogger.ts
 *
 * Lightweight audit logger with dependency injection hooks.
 */

import { logger } from './structuredLogging.js';

export interface AuditLogEntry {
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface AuditLogger {
  log: (entry: AuditLogEntry) => void;
}

interface AuditLoggerDependencies {
  baseLogger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/**
 * Create an audit logger for structured audit events.
 * Inputs: optional base logger dependency override.
 * Outputs: audit logger with a `log` method.
 * Edge cases: falls back to the core logger when dependency is missing.
 */
export function createAuditLogger({
  baseLogger = logger.child({ module: 'audit' })
}: AuditLoggerDependencies = {}): AuditLogger {
  return {
    log: (entry: AuditLogEntry) => {
      //audit Assumption: audit entries are safe to log; risk: sensitive data leakage; invariant: audit logs are structured; handling: route through structured logger.
      baseLogger.info(entry.event, entry);
    }
  };
}

export const auditLogger = createAuditLogger();
