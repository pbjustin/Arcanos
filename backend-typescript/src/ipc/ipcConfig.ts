/**
 * IPC configuration loader for the backend WebSocket bridge.
 */

type EnvGetter = (key: string) => string | undefined;

export interface IpcServerConfig {
  wsPath: string;
  heartbeatIntervalMs: number;
  clientTimeoutMs: number;
  maxMessageSizeBytes: number;
}

function normalizePositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    //audit assumption: missing value uses fallback; risk: default mismatch; invariant: fallback applied; strategy: return fallback.
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    //audit assumption: value must be positive; risk: invalid config; invariant: positive int; strategy: return fallback.
    return fallback;
  }
  return parsed;
}

function normalizeWsPath(rawValue: string | undefined, fallback: string): string {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    //audit assumption: missing path uses fallback; risk: path unset; invariant: fallback path; strategy: return fallback.
    return fallback;
  }
  if (trimmed.startsWith('/')) {
    //audit assumption: path already normalized; risk: none; invariant: leading slash; strategy: return trimmed.
    return trimmed;
  }
  //audit assumption: path missing leading slash; risk: invalid path; invariant: leading slash; strategy: prepend slash.
  return `/${trimmed}`;
}

/**
 * Load IPC server configuration from environment values.
 * Inputs/Outputs: optional env getter; returns IpcServerConfig.
 * Edge cases: invalid numeric values fall back to defaults.
 */
export function loadIpcServerConfig(getEnv: EnvGetter = (key) => process.env[key]): IpcServerConfig {
  const wsPath = normalizeWsPath(getEnv('IPC_WS_PATH'), '/ws/daemon');
  const heartbeatIntervalMs = normalizePositiveInteger(getEnv('IPC_HEARTBEAT_INTERVAL_MS'), 30000);
  const clientTimeoutMs = normalizePositiveInteger(getEnv('IPC_CLIENT_TIMEOUT_MS'), 90000);
  const maxMessageSizeBytes = normalizePositiveInteger(getEnv('IPC_MAX_MESSAGE_SIZE'), 1024 * 1024);

  return {
    wsPath,
    heartbeatIntervalMs,
    clientTimeoutMs,
    maxMessageSizeBytes
  };
}
