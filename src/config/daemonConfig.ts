/**
 * Daemon configuration derived from environment settings.
 */

import path from 'path';
import { env } from '../utils/env.js';

const DEFAULT_DAEMON_TOKENS_FILE = 'memory/daemon_tokens.json';

function resolveDaemonTokensFilePath(setting?: string): string {
  if (!setting) {
    //audit Assumption: missing env var means default path; risk: missing tokens file; invariant: default path used; handling: join with cwd.
    return path.join(process.cwd(), DEFAULT_DAEMON_TOKENS_FILE);
  }

  if (path.isAbsolute(setting)) {
    //audit Assumption: absolute path should be respected; risk: misplacement; invariant: absolute path returned; handling: return as-is.
    return setting;
  }

  //audit Assumption: relative path should resolve from cwd; risk: wrong working dir; invariant: cwd join; handling: join and return.
  return path.join(process.cwd(), setting);
}

export const DAEMON_TOKENS_FILE = resolveDaemonTokensFilePath(env.DAEMON_TOKENS_FILE);
export const DAEMON_RATE_LIMIT_MAX = env.DAEMON_RATE_LIMIT_MAX;
export const DAEMON_RATE_LIMIT_WINDOW_MS = env.DAEMON_RATE_LIMIT_WINDOW_MS;
export const DAEMON_REGISTRY_RATE_LIMIT_MAX = env.DAEMON_REGISTRY_RATE_LIMIT_MAX;
export const DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS = env.DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS;
export const DAEMON_PENDING_ACTION_TTL_MS = env.DAEMON_PENDING_ACTION_TTL_MS;
export const DAEMON_COMMAND_RETENTION_MS = env.DAEMON_COMMAND_RETENTION_MS;
