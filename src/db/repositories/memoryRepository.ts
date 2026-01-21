/**
 * Memory Repository for ARCANOS
 * 
 * Handles memory storage and retrieval operations.
 */

import type { QueryResult } from 'pg';
import { getPool, isDatabaseConnected } from '../client.js';
import type { MemoryEntry } from '../schema.js';
import { query } from '../query.js';

/**
 * Save or update memory entry
 */
export async function saveMemory(key: string, value: any): Promise<MemoryEntry> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    `INSERT INTO memory (key, value, updated_at) 
     VALUES ($1, $2, NOW()) 
     ON CONFLICT (key) 
     DO UPDATE SET value = $2, updated_at = NOW() 
     RETURNING *`,
    [key, JSON.stringify(value)]
  );
  
  return result.rows[0];
}

/**
 * Load memory entry by key
 */
export async function loadMemory(key: string): Promise<any | null> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    'SELECT value FROM memory WHERE key = $1',
    [key],
    1,
    true // Use cache for read operations
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0].value;
}

/**
 * Delete memory entry by key
 */
export async function deleteMemory(key: string): Promise<boolean> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query('DELETE FROM memory WHERE key = $1 RETURNING *', [key]);
  return (result.rowCount || 0) > 0;
}
