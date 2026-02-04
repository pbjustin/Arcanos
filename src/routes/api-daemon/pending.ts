import type { PendingDaemonAction } from '../daemonStore.js';
import { DAEMON_PENDING_ACTION_TTL_MS } from '../../config/daemonConfig.js';
import { daemonStore } from './context.js';

/**
 * Purpose: Create a pending confirmation bundle for sensitive daemon actions.
 * Inputs/Outputs: instanceId and action list; returns confirmation token ID.
 * Edge cases: Empty action list still creates a token; callers should gate on length.
 */
export function createPendingDaemonActions(instanceId: string, actions: PendingDaemonAction[]): string {
  return daemonStore.createPendingActions(instanceId, actions, DAEMON_PENDING_ACTION_TTL_MS);
}

/**
 * Purpose: Consume a pending confirmation token and queue its daemon actions.
 * Inputs/Outputs: confirmation token, instanceId, daemon token; returns queued count or -1 on invalid.
 * Edge cases: Returns -1 for missing/expired tokens or mismatched instance/token.
 */
export function consumePendingDaemonActions(
  confirmationToken: string,
  instanceId: string,
  daemonToken: string
): number {
  return daemonStore.consumePendingActions(confirmationToken, instanceId, daemonToken);
}
