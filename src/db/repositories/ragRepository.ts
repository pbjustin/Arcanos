/**
 * RAG Document Repository for ARCANOS
 * 
 * Handles RAG document storage and retrieval operations.
 */

import { isDatabaseConnected } from '../client.js';
import type { RagDoc } from '../schema.js';
import { query } from '../query.js';

/**
 * Parse JSON field with fallback
 */
function parseJsonField<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
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

  const row = result.rows[0];
  return {
    id: row.id,
    url: row.url,
    content: row.content,
    embedding: parseJsonField(row.embedding, [] as number[]),
    metadata: parseJsonField(row.metadata, {} as Record<string, unknown>),
    created_at: row.created_at,
    updated_at: row.updated_at,
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

  return result.rows.map((row) => ({
    id: row.id,
    url: row.url,
    content: row.content,
    embedding: parseJsonField(row.embedding, [] as number[]),
    metadata: parseJsonField(row.metadata, {} as Record<string, unknown>),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}
