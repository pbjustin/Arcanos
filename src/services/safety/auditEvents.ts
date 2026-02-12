import { logger } from '../../utils/structuredLogging.js';
import { recordTraceEvent } from '../../utils/telemetry.js';

export type SafetyAuditSeverity = 'info' | 'warn' | 'error';

export interface SafetyAuditPayload {
  event: string;
  severity?: SafetyAuditSeverity;
  details?: Record<string, unknown>;
}

const safetyAuditLogger = logger.child({ module: 'safety.audit' });

/**
 * Purpose: Emit a structured safety audit event to logs and telemetry.
 * Inputs/Outputs: Event name, severity, and details; returns emitted trace ID.
 * Edge cases: Defaults to info severity when severity is omitted.
 */
export function emitSafetyAuditEvent(payload: SafetyAuditPayload): string {
  const severity = payload.severity || 'info';
  const timestamp = new Date().toISOString();
  const details = payload.details || {};

  const logContext = {
    event: payload.event,
    timestamp,
    ...details
  };

  //audit Assumption: severity mapping controls alert routing fidelity; failure risk: under-reporting critical safety faults; expected invariant: error severity logs through error channel; handling strategy: explicit severity switch.
  if (severity === 'error') {
    safetyAuditLogger.error(`Safety audit event: ${payload.event}`, logContext);
  } else if (severity === 'warn') {
    safetyAuditLogger.warn(`Safety audit event: ${payload.event}`, logContext);
  } else {
    safetyAuditLogger.info(`Safety audit event: ${payload.event}`, logContext);
  }

  const trace = recordTraceEvent(`safety.${payload.event}`, {
    severity,
    timestamp,
    ...details
  });

  return trace.id;
}

