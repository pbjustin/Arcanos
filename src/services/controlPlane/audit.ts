import { emitSafetyAuditEvent } from '@services/safety/auditEvents.js';
import { redactSensitive } from '@shared/redaction.js';

import type { ControlPlaneAuditEvent } from './types.js';

export function emitControlPlaneAuditEvent(event: ControlPlaneAuditEvent): void {
  emitSafetyAuditEvent({
    event: 'control_plane.operation',
    severity: event.status === 'accepted' ? 'info' : event.status === 'denied' ? 'warn' : 'error',
    details: redactSensitive(event) as Record<string, unknown>,
  });
}
