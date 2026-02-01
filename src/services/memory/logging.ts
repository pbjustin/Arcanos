import { appendFileSync } from 'fs';
import { resolveErrorMessage } from '../../lib/errors/index.js';
import { MEMORY_LOG_FILE, SUPPRESSION_LOG_FILE } from './paths.js';

/**
 * Log suppression events without touching runtime memory
 */
export function logSuppressionEvent(moduleId: string, reason: string) {
  try {
    const logEntry = `${new Date().toISOString()} | ${moduleId} | ${reason}\n`;
    appendFileSync(SUPPRESSION_LOG_FILE, logEntry);
  } catch {
    /* Silent fail - diagnostics only */
  }
}

/**
 * Log memory access for audit trail
 */
export function logMemoryAccess(operation: string, key: string, entryId: string) {
  try {
    const logEntry = `${new Date().toISOString()} | ${operation} | ${key} | ${entryId}\n`;
    appendFileSync(MEMORY_LOG_FILE, logEntry);
  } catch (error: unknown) {
    console.error('❌ Failed to log memory access:', resolveErrorMessage(error));
  }
}
