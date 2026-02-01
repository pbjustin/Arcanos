export interface DaemonHeartbeat {
  instanceId: string;
  clientId: string;
  version?: string;
  uptime?: number;
  routingMode?: string;
  stats?: Record<string, unknown>;
  lastSeen: Date;
}

export interface DaemonCommand {
  id: string;
  instanceId: string;
  name: string;
  payload: Record<string, unknown>;
  issuedAt: Date;
  acknowledged: boolean;
}

export interface PendingDaemonAction {
  daemon: string;
  payload: Record<string, unknown>;
  summary: string;
}

export interface PendingDaemonActions {
  id: string;
  instanceId: string;
  actions: PendingDaemonAction[];
  expiresAt: Date;
}

export interface DaemonStore {
  /**
   * Purpose: Load daemon tokens from disk.
   * Inputs/Outputs: reads tokens JSON file into memory.
   * Edge cases: missing or invalid file returns without throwing.
   */
  loadTokens: () => void;
  /**
   * Purpose: Persist daemon tokens to disk.
   * Inputs/Outputs: writes in-memory token map to JSON file.
   * Edge cases: write failures are logged and swallowed.
   */
  saveTokens: () => void;
  /**
   * Purpose: Get the token for a daemon instance.
   * Inputs/Outputs: instanceId; returns token or null.
   * Edge cases: returns null when mapping missing.
   */
  getTokenForInstance: (instanceId: string) => string | null;
  /**
   * Purpose: Set the token for a daemon instance.
   * Inputs/Outputs: instanceId and token; stores mapping.
   * Edge cases: overwrites existing mapping.
   */
  setTokenForInstance: (instanceId: string, token: string) => void;
  /**
   * Purpose: Record heartbeat data for a daemon instance.
   * Inputs/Outputs: token and heartbeat; stores in memory.
   * Edge cases: overwrites existing heartbeat.
   */
  recordHeartbeat: (token: string, heartbeat: DaemonHeartbeat) => void;
  /**
   * Purpose: Fetch heartbeat data for a token + instance.
   * Inputs/Outputs: token, instanceId; returns heartbeat or undefined.
   * Edge cases: returns undefined when missing.
   */
  getHeartbeat: (token: string, instanceId: string) => DaemonHeartbeat | undefined;
  /**
   * Purpose: List pending commands for a daemon instance.
   * Inputs/Outputs: token, instanceId; returns unacknowledged commands.
   * Edge cases: returns empty list when none exist.
   */
  listPendingCommands: (token: string, instanceId: string) => DaemonCommand[];
  /**
   * Purpose: Acknowledge command IDs for a daemon instance.
   * Inputs/Outputs: token, instanceId, command IDs, retention window; returns count.
   * Edge cases: unknown command IDs are ignored.
   */
  acknowledgeCommands: (
    token: string,
    instanceId: string,
    commandIds: string[],
    retentionWindowMs: number
  ) => number;
  /**
   * Purpose: Queue a command for a daemon instance.
   * Inputs/Outputs: token, instanceId, name, payload; returns command ID.
   * Edge cases: always returns a new ID.
   */
  queueCommand: (token: string, instanceId: string, name: string, payload: Record<string, unknown>) => string;
  /**
   * Purpose: Queue a command using stored token for an instance.
   * Inputs/Outputs: instanceId, name, payload; returns command ID or null.
   * Edge cases: returns null when token missing.
   */
  queueCommandForInstance: (instanceId: string, name: string, payload: Record<string, unknown>) => string | null;
  /**
   * Purpose: Create pending actions that require confirmation.
   * Inputs/Outputs: instanceId, actions, TTL; returns confirmation ID.
   * Edge cases: stores empty action list with TTL.
   */
  createPendingActions: (instanceId: string, actions: PendingDaemonAction[], ttlMs: number) => string;
  /**
   * Purpose: Consume confirmation token and queue actions.
   * Inputs/Outputs: confirmation token, instanceId, daemon token; returns queued count or -1.
   * Edge cases: returns -1 for invalid, expired, or mismatched token.
   */
  consumePendingActions: (
    confirmationToken: string,
    instanceId: string,
    daemonToken: string
  ) => number;
}
