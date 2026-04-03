/**
 * RAG Document Repository for ARCANOS
 * 
 * Handles RAG document storage and retrieval operations.
 */

import { isDatabaseConnected } from "@core/db/client.js";
import type { RagDoc } from "@core/db/schema.js";
import { query } from "@core/db/query.js";
import { safeJSONParse } from "@shared/jsonHelpers.js";

type RagDocRow = {
  id: string;
  url: string;
  content: string;
  embedding: unknown;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

/**
 * Parse JSON field with fallback (safe)
 */
function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    const result = safeJSONParse<T>(value, 'ragRepository.parseJsonField');
    return result.success && result.data !== undefined ? result.data : fallback;
  }
  return value as T;
}

function parseDateField(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Save or update RAG document
 */
export async function saveRagDoc(doc: RagDoc): Promise<RagDoc> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    `INSERT INTO rag_docs (id, url, content, embedding, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET url = EXCLUDED.url, content = EXCLUDED.content, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = NOW()
     RETURNING *`,
    [
      doc.id,
      doc.url,
      doc.content,
      JSON.stringify(doc.embedding),
      JSON.stringify(doc.metadata ?? {})
    ]
  );

  const row = result.rows[0] as RagDocRow | undefined;
  if (!row) {
    throw new Error('Failed to persist RAG document');
  }

  return {
    id: row.id,
    url: row.url,
    content: row.content,
    embedding: parseJsonField(row.embedding, [] as number[]),
    metadata: parseJsonField(row.metadata, {} as Record<string, unknown>),
    created_at: parseDateField(row.created_at),
    updated_at: parseDateField(row.updated_at),
  };
}

/**
 * Load one RAG document by identifier.
 */
export async function loadRagDocById(id: string): Promise<RagDoc | null> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    'SELECT id, url, content, embedding, metadata, created_at, updated_at FROM rag_docs WHERE id = $1 LIMIT 1',
    [id]
  );
  const row = result.rows[0] as RagDocRow | undefined;
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    url: row.url,
    content: row.content,
    embedding: parseJsonField(row.embedding, [] as number[]),
    metadata: parseJsonField(row.metadata, {} as Record<string, unknown>),
    created_at: parseDateField(row.created_at),
    updated_at: parseDateField(row.updated_at),
  };
}

/**
 * Load all RAG documents
 */
export async function loadAllRagDocs(): Promise<RagDoc[]> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured');
  }

  const result = await query(
    'SELECT id, url, content, embedding, metadata, created_at, updated_at FROM rag_docs',
    [],
    1000,
    true
  );

  return result.rows.map((row: RagDocRow) => {
    return {
      id: row.id,
      url: row.url,
      content: row.content,
      embedding: parseJsonField(row.embedding, [] as number[]),
      metadata: parseJsonField(row.metadata, {} as Record<string, unknown>),
      created_at: parseDateField(row.created_at),
      updated_at: parseDateField(row.updated_at),
    };
  });
}
