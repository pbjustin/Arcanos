import { unwrapVersionedMemoryEnvelope } from "@services/safety/memoryEnvelope.js";

export interface MemoryListRow {
  key: string;
  value: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  expires_at?: string | Date | null;
}

export interface MemoryListEntry {
  key: string;
  value: unknown;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

/**
 * Build an active-memory SELECT statement with an optional key prefix filter.
 *
 * Purpose:
 * - Reuse one SQL shape for APIs and MCP tools that should ignore expired memory rows.
 *
 * Inputs/outputs:
 * - Input: bounded limit plus optional prefix string.
 * - Output: SQL statement text and parameter list.
 *
 * Edge case behavior:
 * - When no prefix is provided, returns the latest active rows globally.
 */
export function buildActiveMemorySelect(limit: number, prefix: string | null): { text: string; params: unknown[] } {
  if (!prefix) {
    return {
      text:
        'SELECT key, value, created_at, updated_at, expires_at FROM memory WHERE (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT $1',
      params: [limit]
    };
  }

  return {
    text:
      'SELECT key, value, created_at, updated_at, expires_at FROM memory WHERE key ILIKE $2 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT $1',
    params: [limit, `${prefix}%`]
  };
}

function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalizedDate = value instanceof Date ? value : new Date(value);
  return Number.isNaN(normalizedDate.getTime()) ? null : normalizedDate.toISOString();
}

/**
 * Convert raw memory rows into API/MCP-safe entries with envelope payloads unwrapped.
 *
 * Purpose:
 * - Preserve only plain-object data structures for downstream JSON and MCP structured content.
 *
 * Inputs/outputs:
 * - Input: database rows from the memory table.
 * - Output: normalized memory entry objects with payload and metadata separated.
 *
 * Edge case behavior:
 * - Legacy rows without envelope metadata are returned with `metadata: null`.
 */
export function normalizeMemoryEntries(rows: MemoryListRow[]): MemoryListEntry[] {
  return rows.map((row) => {
    const { payload, metadata } = unwrapVersionedMemoryEnvelope<Record<string, unknown> | unknown>(row.value);

    //audit Assumption: database drivers may return timestamps as either Date objects or ISO strings; failure risk: inconsistent JSON payloads break MCP and API consumers; expected invariant: normalized memory views always emit ISO strings or null; handling strategy: coerce each timestamp field explicitly.
    return {
      key: row.key,
      value: payload,
      metadata: metadata ? (metadata as unknown as Record<string, unknown>) : null,
      created_at: normalizeTimestamp(row.created_at) ?? new Date(0).toISOString(),
      updated_at: normalizeTimestamp(row.updated_at) ?? new Date(0).toISOString(),
      expires_at: normalizeTimestamp(row.expires_at)
    };
  });
}
