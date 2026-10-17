/**
 * Self-Reflection Repository for ARCANOS
 *
 * Persists AI reflection outputs for historical analysis and tooling reuse.
 */

import { getPool, isDatabaseConnected, initializeDatabase } from "@core/db/client.js";
import { query } from "@core/db/query.js";
import { createDatabaseRepositoryReadinessGate } from '@core/db/repositoryReadiness.js';
import { initializeTables, isDatabaseSchemaReady } from "@core/db/schema.js";
import { resolveErrorMessage } from "@shared/errorUtils.js";

export interface SelfReflectionInsert {
  priority: string;
  category: string;
  content: string;
  improvements: string[];
  metadata: unknown;
}

export interface SelfReflectionRecord {
  id: string;
  priority: string;
  category: string;
  content: string;
  improvements: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

const SELF_REFLECTION_DB_WORKER_ID = 'self-reflections';
const SELF_REFLECTION_INIT_RETRY_COOLDOWN_MS = 30_000;

/**
 * Ensure self-reflection persistence can reach PostgreSQL.
 *
 * Purpose: lazily bootstrap DB connectivity for standalone script/test flows.
 * Inputs/outputs: no inputs, returns readiness boolean.
 * Edge cases: applies cooldown after failed bootstrap to avoid retry storms.
 */
const ensureSelfReflectionPersistenceReady = createDatabaseRepositoryReadinessGate({
  getPool,
  isDatabaseConnected,
  isDatabaseSchemaReady,
  initializeDatabase,
  initializeTables,
  workerId: SELF_REFLECTION_DB_WORKER_ID,
  cooldownMs: SELF_REFLECTION_INIT_RETRY_COOLDOWN_MS,
  onError: error => {
    console.warn('[🧠 Reflections] Failed to initialize database for persistence:', resolveErrorMessage(error));
  }
});

/**
 * Store a generated self-reflection in PostgreSQL.
 *
 * Purpose: persist reflection output for historical analysis and tooling reuse.
 * Inputs/outputs: reflection payload fields -> no return value.
 * Edge cases: lazily initializes DB when not already connected and safely skips persistence when unavailable.
 */
export async function saveSelfReflection({
  priority,
  category,
  content,
  improvements,
  metadata
}: SelfReflectionInsert): Promise<void> {
  const persistenceReady = await ensureSelfReflectionPersistenceReady();
  //audit Assumption: persistence is optional for runtime correctness; risk: data loss when DB unavailable; invariant: caller flow continues without throw; handling: warn and skip write.
  if (!persistenceReady) {
    console.warn('[🧠 Reflections] Database not connected; skipping persistence for self-reflection');
    return;
  }

  //audit Assumption: persistence payload must remain JSON-serializable; risk: malformed values breaking insert; invariant: improvements metadata normalized before write; handling: sanitize arrays + default metadata.
  const sanitizedImprovements = Array.isArray(improvements) ? improvements : [];
  const serializedMetadata = metadata ?? {};

  await query(
    `INSERT INTO self_reflections (priority, category, content, improvements, metadata)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      priority,
      category,
      content,
      JSON.stringify(sanitizedImprovements),
      JSON.stringify(serializedMetadata)
    ]
  );
}

/**
 * Load recent self-reflections filtered by category.
 *
 * Purpose: provide persistence-backed learning context for response quality feedback loops.
 * Inputs/outputs: category + limit -> ordered self-reflection records (newest first).
 * Edge cases: returns empty array when DB is unavailable or category/limit are invalid.
 */
export async function loadRecentSelfReflectionsByCategory(
  category: string,
  limit: number = 20
): Promise<SelfReflectionRecord[]> {
  //audit Assumption: category must be a non-empty identifier; risk: broad table scans and ambiguous filtering; invariant: query executes with a valid category string; handling: validate and return empty.
  if (typeof category !== 'string' || category.trim().length === 0) {
    return [];
  }

  const sanitizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const persistenceReady = await ensureSelfReflectionPersistenceReady();
  //audit Assumption: reads are optional for runtime correctness; risk: stale/empty learning context; invariant: caller receives deterministic array; handling: return empty when DB unavailable.
  if (!persistenceReady) {
    return [];
  }

  const result = await query(
    `SELECT id, priority, category, content, improvements, metadata, created_at
     FROM self_reflections
     WHERE category = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [category.trim(), sanitizedLimit]
  );

  return result.rows.map((rowRaw: unknown) => {
    const row = rowRaw as Record<string, unknown>;
    //audit Assumption: DB jsonb columns may deserialize as objects or strings depending on driver settings; risk: runtime parsing failures; invariant: record fields remain serializable; handling: resilient normalization helper.
    const normalizedImprovements = normalizeStringArray(row.improvements);
    const normalizedMetadata = normalizeObjectRecord(row.metadata);
    const normalizedCreatedAt = typeof row.created_at === 'string'
      ? row.created_at
      : new Date().toISOString();

    return {
      id: String(row.id ?? ''),
      priority: String(row.priority ?? 'medium'),
      category: String(row.category ?? ''),
      content: String(row.content ?? ''),
      improvements: normalizedImprovements,
      metadata: normalizedMetadata,
      createdAt: normalizedCreatedAt
    };
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string') as string[];
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(item => typeof item === 'string') as string[];
      }
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeObjectRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}
