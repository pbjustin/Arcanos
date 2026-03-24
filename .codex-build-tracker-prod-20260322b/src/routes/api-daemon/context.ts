import fs from 'fs';
import path from 'path';
import { logger } from "@platform/logging/structuredLogging.js";
import { createDaemonStore } from "@routes/daemonStore.js";
import { DAEMON_TOKENS_FILE } from "@platform/runtime/daemonConfig.js";

export const daemonLogger = logger.child({ module: 'api-daemon' });

export const daemonStore = createDaemonStore({
  fs,
  path,
  logger: daemonLogger.child({ module: 'daemon-store' }),
  tokensFilePath: DAEMON_TOKENS_FILE,
  now: () => new Date()
});

// Load tokens at startup
daemonStore.loadTokens();
