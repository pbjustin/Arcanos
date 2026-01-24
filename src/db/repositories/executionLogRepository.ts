/**
 * Execution Log Repository for ARCANOS
 * 
 * Handles execution log storage operations with batch processing support.
 */

import { isDatabaseConnected } from '../client.js';
import { query } from '../query.js';

/**
 * Log single execution entry
 */
export async function logExecution(
  workerId: string,
  level: string,
  message: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (!isDatabaseConnected()) {
    console.log(`[${workerId}] ${level.toUpperCase()}: ${message}`);
    return;
  }

  try {
    await query(
      'INSERT INTO execution_logs (worker_id, level, message, metadata) VALUES ($1, $2, $3, $4)',
      [workerId, level, message, JSON.stringify(metadata)]
    );
  } catch (error: unknown) {
    //audit Assumption: DB failures should fall back to console logging
    console.error('[🔌 DB] Failed to log execution:', error instanceof Error ? error.message : 'Unknown error');
    // Fallback to console logging
    console.log(`[${workerId}] ${level.toUpperCase()}: ${message}`);
  }
}

/**
 * Batch log multiple execution entries for improved performance
 */
export async function logExecutionBatch(
  entries: Array<{ workerId: string; level: string; message: string; metadata?: Record<string, unknown> }>
): Promise<void> {
  if (!isDatabaseConnected() || entries.length === 0) {
    entries.forEach(entry => console.log(`[${entry.workerId}] ${entry.level.toUpperCase()}: ${entry.message}`));
    return;
  }

  try {
    const values = entries.map((_, index) => {
      const base = index * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(', ');
    
    const params = entries.flatMap(entry => [
      entry.workerId,
      entry.level,
      entry.message,
      JSON.stringify(entry.metadata || {})
    ]);

    await query(
      `INSERT INTO execution_logs (worker_id, level, message, metadata) VALUES ${values}`,
      params
    );
  } catch (error: unknown) {
    //audit Assumption: batch failures should fall back to console logging
    console.error('[🔌 DB] Failed to batch log execution:', error instanceof Error ? error.message : 'Unknown error');
    // Fallback to individual console logging
    entries.forEach(entry => console.log(`[${entry.workerId}] ${entry.level.toUpperCase()}: ${entry.message}`));
  }
}
