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

export interface StoredMemoryRecord {
  id: number;
  key: string;
  value: unknown;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
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
 * Load one persisted memory row by numeric record id.
 * Inputs/outputs: positive memory table id -> normalized persisted row or null.
 * Edge cases: expired or missing rows return null instead of stale payloads.
 */
export async function loadMemoryRecordById(recordId: number): Promise<StoredMemoryRecord | null> {
  //audit Assumption: record-id reads require a live database connection; failure risk: callers infer persistence success from stale process memory; expected invariant: reads come from PostgreSQL only; handling strategy: fail closed when DB is unavailable.
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  //audit Assumption: record ids must be positive integers before reaching SQL; failure risk: ambiguous casts or malformed lookup attempts; expected invariant: exact integer row selector; handling strategy: reject invalid ids before query execution.
  if (!Number.isInteger(recordId) || recordId < 1) {
    throw new Error(`Invalid memory record id: ${recordId}`);
  }

  const result = await query(
    `SELECT id, key, value, expires_at::text, created_at::text, updated_at::text
     FROM memory
     WHERE id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [recordId],
    1,
    false
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as {
    id: number | string;
    key: string;
    value: unknown;
    expires_at: string | null;
    created_at: string;
    updated_at: string;
  };
  const unwrapped = unwrapVersionedMemoryEnvelope(row.value);

  return {
    id: typeof row.id === 'number' ? row.id : Number.parseInt(String(row.id), 10),
    key: row.key,
    value: unwrapped.payload,
    expires_at: normalizeDatabaseTimestamp(row.expires_at),
    created_at: normalizeRequiredDatabaseTimestamp(row.created_at),
    updated_at: normalizeRequiredDatabaseTimestamp(row.updated_at)
  };
}

function normalizeDatabaseTimestamp(rawTimestamp: string | null): string | null {
  if (typeof rawTimestamp !== 'string' || rawTimestamp.trim().length === 0) {
    return null;
  }

  const parsedTimestamp = new Date(rawTimestamp);
  //audit Assumption: repository responses must expose machine-verifiable ISO timestamps instead of database-local text formatting; failure risk: public API schema validation rejects otherwise successful reads; expected invariant: persisted timestamps round-trip as ISO-8601 strings; handling strategy: normalize parseable values and preserve the raw text only when parsing fails.
  if (Number.isNaN(parsedTimestamp.getTime())) {
    return rawTimestamp;
  }

  return parsedTimestamp.toISOString();
}

function normalizeRequiredDatabaseTimestamp(rawTimestamp: string): string {
  const normalizedTimestamp = normalizeDatabaseTimestamp(rawTimestamp);
  return normalizedTimestamp ?? rawTimestamp;
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
