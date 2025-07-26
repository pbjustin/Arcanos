import fs from 'fs';
import path from 'path';
import { createServiceLogger } from './logger';
import { fallbackHandler } from '../handlers/fallback-handler';

const logger = createServiceLogger('OverlayDiagnostics');

/**
 * Check for the existence of model-control-hooks.js in the compiled services
 * directory. If missing, trigger a fallback audit and log an overlay reroute
 * event so the AI can diagnose missing hooks.
 */
export async function checkModelControlHooks(): Promise<boolean> {
  const hooksPath = path.join(__dirname, '../services/model-control-hooks.js');
  const exists = fs.existsSync(hooksPath);

  if (!exists) {
    logger.warning('model-control-hooks.js missing', {
      event: 'ARCANOS::overlay_reroute',
      severity: 'MID',
    });

    try {
      const logEventPath = path.join(__dirname, '../memory/logEvent.js');
      const { logEvent } = require(logEventPath);
      await logEvent('overlay_reroute');
    } catch (err) {
      logger.error('Failed to record overlay_reroute event', err);
    }

    try {
      await fallbackHandler.handleUndefinedWorker({
        type: 'audit',
        message: 'goalWatcher overlay reroute - missing model-control-hooks.js',
      });
    } catch (err) {
      logger.error('Dynamic audit reroute failed', err);
    }

    return false;
  }

  return true;
}
