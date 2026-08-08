/**
 * Daemon configuration derived from environment settings.
 */

import { getEnv, getEnvNumber } from "@platform/runtime/env.js";
import { resolveDaemonTokensFilePath } from '@platform/runtime/protectedConfigCandidatePaths.js';

export const DAEMON_TOKENS_FILE = resolveDaemonTokensFilePath(getEnv('DAEMON_TOKENS_FILE'));
export const DAEMON_RATE_LIMIT_MAX = getEnvNumber('DAEMON_RATE_LIMIT_MAX', 400);
export const DAEMON_RATE_LIMIT_WINDOW_MS = getEnvNumber('DAEMON_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
export const DAEMON_REGISTRY_RATE_LIMIT_MAX = getEnvNumber('DAEMON_REGISTRY_RATE_LIMIT_MAX', 120);
export const DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS = getEnvNumber('DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
export const DAEMON_PENDING_ACTION_TTL_MS = getEnvNumber('DAEMON_PENDING_ACTION_TTL_MS', 5 * 60 * 1000);
export const DAEMON_COMMAND_RETENTION_MS = getEnvNumber('DAEMON_COMMAND_RETENTION_MS', 60 * 60 * 1000);
