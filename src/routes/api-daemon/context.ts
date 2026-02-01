import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/structuredLogging.js';
import { createDaemonStore } from '../daemonStore.js';
import { DAEMON_TOKENS_FILE } from '../../config/daemonConfig.js';

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
