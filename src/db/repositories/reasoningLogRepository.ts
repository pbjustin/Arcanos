/**
 * Reasoning Log Repository for ARCANOS
 * 
 * Handles reasoning log storage operations.
 */

import { isDatabaseConnected } from '../client.js';
import type { ReasoningLog } from '../schema.js';
import { query } from '../query.js';

/**
 * Log reasoning input and output
 */
export async function logReasoning(input: string, output: string, metadata: any = {}): Promise<ReasoningLog | undefined> {
  if (!isDatabaseConnected()) {
    console.log('[🧠 REASONING] Input:', input.substring(0, 100) + '...');
    console.log('[🧠 REASONING] Output:', output.substring(0, 100) + '...');
    return;
  }

  try {
    const result = await query(
      'INSERT INTO reasoning_logs (input, output, metadata) VALUES ($1, $2, $3) RETURNING *',
      [input, output, JSON.stringify(metadata)]
    );
    
    console.log('[🧠 REASONING] ✅ Reasoning logged to database');
    return result.rows[0];
  } catch (error) {
    console.error('[🔌 DB] Failed to log reasoning:', (error as Error).message);
    // Fallback to console logging
    console.log('[🧠 REASONING] Input:', input.substring(0, 100) + '...');
    console.log('[🧠 REASONING] Output:', output.substring(0, 100) + '...');
  }
}
