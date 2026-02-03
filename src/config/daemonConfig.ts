/**
 * Daemon configuration derived from environment settings.
 */

import path from 'path';
import { getEnv, getEnvNumber } from './env.js';

const DEFAULT_DAEMON_TOKENS_FILE = 'memory/daemon_tokens.json';

function resolveDaemonTokensFilePath(setting?: string): string {
  if (!setting) {
    return path.join(process.cwd(), DEFAULT_DAEMON_TOKENS_FILE);
  }

  if (path.isAbsolute(setting)) {
    return setting;
  }

  return path.join(process.cwd(), setting);
}

export const DAEMON_TOKENS_FILE = resolveDaemonTokensFilePath(getEnv('DAEMON_TOKENS_FILE'));
export const DAEMON_RATE_LIMIT_MAX = getEnvNumber('DAEMON_RATE_LIMIT_MAX', 400);
export const DAEMON_RATE_LIMIT_WINDOW_MS = getEnvNumber('DAEMON_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
export const DAEMON_REGISTRY_RATE_LIMIT_MAX = getEnvNumber('DAEMON_REGISTRY_RATE_LIMIT_MAX', 120);
export const DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS = getEnvNumber('DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
export const DAEMON_PENDING_ACTION_TTL_MS = getEnvNumber('DAEMON_PENDING_ACTION_TTL_MS', 5 * 60 * 1000);
export const DAEMON_COMMAND_RETENTION_MS = getEnvNumber('DAEMON_COMMAND_RETENTION_MS', 60 * 60 * 1000);
