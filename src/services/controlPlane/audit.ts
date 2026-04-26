import { emitSafetyAuditEvent } from '@services/safety/auditEvents.js';
import { redactSensitive } from '@shared/redaction.js';

import type { ControlPlaneAuditEvent } from './types.js';

export function sanitizeControlPlaneAuditEvent(event: ControlPlaneAuditEvent): Record<string, unknown> {
  return redactSensitive(event) as Record<string, unknown>;
}

export function emitControlPlaneAuditEvent(event: ControlPlaneAuditEvent): void {
  emitSafetyAuditEvent({
    event: 'control_plane.operation',
    severity: event.status === 'accepted' ? 'info' : event.status === 'denied' ? 'warn' : 'error',
    details: sanitizeControlPlaneAuditEvent(event),
  });
}
