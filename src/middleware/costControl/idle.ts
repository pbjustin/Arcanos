import { createIdleManager } from '../../utils/idleManager.js';
import { logger } from '../../utils/structuredLogging.js';
import type { IdleManagerLogger, IdleStateProvider } from './types.js';

function createIdleManagerLogger(): IdleManagerLogger {
  return {
    log: (message: string, metadata?: unknown) => {
      //audit Assumption: idle manager audit logs are informational; risk: noisy logging; invariant: message remains intact; handling: log via structured logger.
      const metaRecord =
        metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : undefined;
      logger.info(message, { module: 'idle-manager' }, metaRecord);
    }
  };
}

const defaultIdleManager = createIdleManager(createIdleManagerLogger());

export const defaultIdleStateProvider: IdleStateProvider = {
  getState: () => {
    const idle = defaultIdleManager.isIdle();
    //audit Assumption: idle manager's boolean can map to idle/active; risk: misclassification; invariant: idle true => idle state; handling: map directly.
    return { state: idle ? 'idle' : 'active' };
  },
  noteTraffic: (meta?: Record<string, unknown>) => {
    //audit Assumption: traffic note is safe to record; risk: missing activity; invariant: noteTraffic updates idle heuristics; handling: forward to idle manager.
    defaultIdleManager.noteTraffic(meta);
  }
};
