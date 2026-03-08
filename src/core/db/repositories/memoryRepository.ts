/**
 * Memory Repository for ARCANOS
 * 
 * Handles memory storage and retrieval operations.
 */

import { isDatabaseConnected } from "@core/db/client.js";
import type { MemoryEntry } from "@core/db/schema.js";
import { query } from "@core/db/query.js";
import { createVersionedMemoryEnvelope, unwrapVersionedMemoryEnvelope } from "@services/safety/memoryEnvelope.js";

export interface SaveMemoryOptions {
  ttlSeconds?: number;
}

/**
 * Normalize TTL input into a bounded integer or null when expiry is disabled.
 */
function resolveTtlSeconds(ttlSeconds: number | undefined): number | null {
  //audit Assumption: callers may omit TTL for non-expiring memory entries; failure risk: undefined values produce invalid SQL interval math; expected invariant: persistence receives a positive integer TTL or null; handling strategy: coerce undefined to null and reject invalid numeric values explicitly.
  if (ttlSeconds === undefined) {
    return null;
  }

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`Invalid memory TTL seconds: ${ttlSeconds}`);
  }

  return ttlSeconds;
}

/**
 * Save or update memory entry
 */
export async function saveMemory(key: string, value: unknown, options: SaveMemoryOptions = {}): Promise<MemoryEntry> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const envelopedValue = createVersionedMemoryEnvelope(value, {
    prefix: 'db-memory'
  });
  const ttlSeconds = resolveTtlSeconds(options.ttlSeconds);

  const result = await query(
    `INSERT INTO memory (key, value, expires_at, updated_at) 
     VALUES ($1, $2, CASE WHEN $3::INTEGER IS NULL THEN NULL ELSE NOW() + ($3::INTEGER * INTERVAL '1 second') END, NOW()) 
     ON CONFLICT (key) 
     DO UPDATE SET value = $2, expires_at = EXCLUDED.expires_at, updated_at = NOW() 
     RETURNING *`,
    [key, JSON.stringify(envelopedValue), ttlSeconds]
  );
  
  return result.rows[0];
}

/**
 * Load memory entry by key
 */
export async function loadMemory(key: string): Promise<unknown | null> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    'SELECT value FROM memory WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())',
    [key],
    1,
    false // Avoid stale reads after immediate writes.
  );
  
  if (result.rows.length === 0) {
    return null;
  }

  //audit Assumption: legacy rows may not have envelope metadata yet; risk: backward compatibility break; invariant: callers receive raw payload for both formats; handling: unwrap envelope when present, passthrough otherwise.
  const unwrapped = unwrapVersionedMemoryEnvelope(result.rows[0].value);
  return unwrapped.payload;
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
