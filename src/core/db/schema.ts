/**
 * Database Schema Module for ARCANOS
 * 
 * Defines database table schemas and initialization logic.
 * Uses Zod for schema validation and type safety.
 */

import { z } from 'zod';
import type { Pool } from 'pg';
import { redactString } from '@shared/redaction.js';
import { getPool, isDatabaseConnected } from './client.js';
import { BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS } from './backstageNotionPartitionStorageSchema.js';
import { BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_TABLE_DEFINITIONS } from './backstageNotionPartitionCutoverEvidenceSchema.js';
import {
  BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES,
  BACKSTAGE_NOTION_SYNC_FAILURE_PHASES,
  BACKSTAGE_NOTION_SYNC_FAILURE_REASONS,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';

export { BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS } from './backstageNotionPartitionStorageSchema.js';
export { BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_TABLE_DEFINITIONS } from './backstageNotionPartitionCutoverEvidenceSchema.js';

// Zod Schemas for Database Entities
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const PostgreSQLBigintDecimalSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/u)
  .refine(
    value => {
      if (value.length > 19) {
        return false;
      }

      try {
        return BigInt(value) <= POSTGRES_BIGINT_MAX;
      } catch {
        return false;
      }
    },
    'Value exceeds the PostgreSQL BIGINT range.'
  );

export const MemoryEntrySchema = z.object({
  id: z.number(),
  key: z.string(),
  value: z.unknown(),
  expires_at: z.date().nullable().optional(),
  created_at: z.date(),
  updated_at: z.date()
});

export const ExecutionLogSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  timestamp: z.date(),
  level: z.string(),
  message: z.string(),
  metadata: z.unknown()
});

export const JobDataSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  job_type: z.string(),
  status: z.string(),
  claim_generation: PostgreSQLBigintDecimalSchema,
  input: z.unknown(),
  output: z.unknown().optional(),
  error_message: z.string().optional(),
  retry_count: z.number().int().optional(),
  max_retries: z.number().int().optional(),
  next_run_at: z.date().optional(),
  started_at: z.date().optional(),
  last_heartbeat_at: z.date().optional(),
  lease_expires_at: z.date().optional(),
  priority: z.number().int().optional(),
  last_worker_id: z.string().nullable().optional(),
  stats_worker_id: z.string().nullable().optional(),
  correlation_id: z.string().nullable().optional(),
  autonomy_state: z.unknown().optional(),
  request_fingerprint_hash: z.string().nullable().optional(),
  idempotency_key_hash: z.string().nullable().optional(),
  idempotency_scope_hash: z.string().nullable().optional(),
  idempotency_origin: z.string().nullable().optional(),
  idempotency_until: z.date().nullable().optional(),
  retention_until: z.date().nullable().optional(),
  expires_at: z.date().nullable().optional(),
  cancel_requested_at: z.date().nullable().optional(),
  cancel_reason: z.string().nullable().optional(),
  created_at: z.date(),
  updated_at: z.date(),
  completed_at: z.date().optional()
});

export const ReasoningLogSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  input: z.string(),
  output: z.string(),
  metadata: z.unknown()
});

export const RagDocSchema = z.object({
  id: z.string(),
  url: z.string(),
  content: z.string(),
  embedding: z.array(z.number()),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional()
});

export const BackstageNotionAuthoritySchema = z.enum(['postgres', 'notion']);

export const BackstageNotionUniverseHeadSchema = z.object({
  universe_id: z.string(),
  authority: BackstageNotionAuthoritySchema,
  active_snapshot_id: z.string().uuid().nullable(),
  activated_at: z.date().nullable(),
  last_verified_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date()
});

export const BackstageNotionSnapshotSchema = z.object({
  id: z.string().uuid(),
  universe_id: z.string(),
  root_page_id: z.string().uuid(),
  manifest_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  embedding_model: z.string(),
  page_count: z.number().int().positive(),
  chunk_count: z.number().int().positive(),
  source_max_edited_at: z.date().nullable(),
  sync_holder_id: z.string(),
  created_at: z.date()
});

export const BackstageNotionSnapshotPageSchema = z.object({
  snapshot_id: z.string().uuid(),
  universe_id: z.string(),
  page_id: z.string().uuid(),
  parent_page_id: z.string().uuid().nullable(),
  title: z.string(),
  canonical_url: z.string().nullable(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  markdown: z.string(),
  source_last_edited_at: z.date().nullable(),
  depth: z.number().int().nonnegative(),
  path: z.array(z.string()),
  metadata: z.record(z.unknown()),
  created_at: z.date()
});

export const BackstageNotionSnapshotChunkSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/u),
  snapshot_id: z.string().uuid(),
  universe_id: z.string(),
  page_id: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  content: z.string(),
  code_points: z.number().int().positive(),
  embedding_model: z.string(),
  embedding: z.array(z.number()),
  heading_path: z.array(z.string()),
  metadata: z.record(z.unknown()),
  created_at: z.date()
});

export const BackstageNotionSyncLeaseSchema = z.object({
  universe_id: z.string(),
  holder_id: z.string(),
  lease_token: z.string().uuid(),
  acquired_at: z.date(),
  expires_at: z.date()
});

export const BackstageNotionLatestSyncAttemptSchema = z.object({
  universe_id: z.string(),
  attempt_id: z.string().uuid(),
  attempt_generation: PostgreSQLBigintDecimalSchema,
  started_at: z.date(),
  completed_at: z.date().nullable(),
  outcome: z.enum(BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES),
  failure_phase: z.enum(BACKSTAGE_NOTION_SYNC_FAILURE_PHASES).nullable(),
  failure_reason: z.enum(BACKSTAGE_NOTION_SYNC_FAILURE_REASONS).nullable(),
  pages_discovered: z.number().int().nonnegative().max(1_000_000),
  pages_fetched: z.number().int().nonnegative().max(1_000_000),
  blocks_fetched: z.number().int().nonnegative().max(1_000_000),
  chunks_produced: z.number().int().nonnegative().max(1_000_000),
  chunks_embedded: z.number().int().nonnegative().max(1_000_000),
  candidate_snapshot_created: z.boolean(),
  candidate_snapshot_validated: z.boolean(),
  candidate_snapshot_activated: z.boolean(),
  activated_snapshot_id: z.string().uuid().nullable(),
  updated_at: z.date(),
});

export const SessionRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  tag: z.string().nullable().optional(),
  memory_type: z.string(),
  payload: z.unknown(),
  transcript_summary: z.string().nullable().optional(),
  audit_trace_id: z.string().nullable().optional(),
  created_at: z.date(),
  updated_at: z.date()
});

export const SessionVersionRecordSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  version_number: z.number().int(),
  payload: z.unknown(),
  created_at: z.date()
});

// TypeScript types from Zod schemas
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type ExecutionLog = z.infer<typeof ExecutionLogSchema>;
export type JobData = z.infer<typeof JobDataSchema>;
export type ReasoningLog = z.infer<typeof ReasoningLogSchema>;
export type RagDoc = z.infer<typeof RagDocSchema>;
export type BackstageNotionAuthorityValue = z.infer<typeof BackstageNotionAuthoritySchema>;
export type BackstageNotionUniverseHead = z.infer<typeof BackstageNotionUniverseHeadSchema>;
export type BackstageNotionSnapshot = z.infer<typeof BackstageNotionSnapshotSchema>;
export type BackstageNotionSnapshotPage = z.infer<typeof BackstageNotionSnapshotPageSchema>;
export type BackstageNotionSnapshotChunk = z.infer<typeof BackstageNotionSnapshotChunkSchema>;
export type BackstageNotionSyncLeaseRow = z.infer<typeof BackstageNotionSyncLeaseSchema>;
export type BackstageNotionLatestSyncAttempt = z.infer<
  typeof BackstageNotionLatestSyncAttemptSchema
>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type SessionVersionRecord = z.infer<typeof SessionVersionRecordSchema>;

export type DatabaseCollationInspectionStatus =
  | 'current'
  | 'mismatch'
  | 'version_unavailable'
  | 'database_unavailable'
  | 'inspection_failed';

const MAX_COLLATION_VERSION_LOG_LENGTH = 128;

function formatCollationVersionForLog(value: string): string {
  const redacted = redactString(value);
  const bounded = redacted.slice(0, MAX_COLLATION_VERSION_LOG_LENGTH);
  const suffix =
    redacted.length > MAX_COLLATION_VERSION_LOG_LENGTH ? '…' : '';
  return JSON.stringify(`${bounded}${suffix}`);
}

/**
 * Inspect the current database's collation version without changing database
 * state. Collation maintenance is always an explicit operator action.
 */
export async function inspectDatabaseCollation(): Promise<DatabaseCollationInspectionStatus> {
  const pool = getPool();
  //audit Assumption: no pool means the database cannot be inspected; Handling: report unavailable.
  if (!pool) {
    return 'database_unavailable';
  }

  try {
    const { rows } = await pool.query<{
      configured_version: string | null;
      actual_version: string | null;
    }>(
      `SELECT
         datcollversion AS configured_version,
         pg_database_collation_actual_version(oid) AS actual_version
       FROM pg_database
       WHERE datname = current_database()`
    );

    //audit Assumption: a missing current-database row means inspection is unavailable; Handling: report unavailable.
    if (!rows.length) {
      return 'database_unavailable';
    }

    const { configured_version: configuredVersion, actual_version: actualVersion } = rows[0];
    if (!configuredVersion || !actualVersion) {
      return 'version_unavailable';
    }

    if (configuredVersion === actualVersion) {
      return 'current';
    }

    console.warn(
      '[🔌 DB] Collation version mismatch detected ' +
      `(configured=${formatCollationVersionForLog(configuredVersion)}, ` +
      `actual=${formatCollationVersionForLog(actualVersion)}). ` +
      'Startup is read-only; schedule operator-controlled collation maintenance against the confirmed database.'
    );
    return 'mismatch';
  } catch {
    //audit Assumption: a diagnostic failure must not prevent startup; Handling: warn and return a bounded status.
    console.warn(
      '[🔌 DB] Collation inspection failed; startup will continue without this diagnostic.'
    );
    return 'inspection_failed';
  }
}

/**
 * @deprecated Use inspectDatabaseCollation(). This compatibility wrapper is
 * passive and never performs collation maintenance.
 */
export async function refreshDatabaseCollation(): Promise<void> {
  await inspectDatabaseCollation();
}

export const BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS = [
  `CREATE TABLE IF NOT EXISTS backstage_notion_universe_heads (
    universe_id TEXT PRIMARY KEY,
    authority TEXT NOT NULL DEFAULT 'postgres',
    active_snapshot_id UUID,
    activated_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_backstage_notion_heads_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT ck_backstage_notion_heads_authority
      CHECK (authority IN ('postgres', 'notion')),
    CONSTRAINT ck_backstage_notion_heads_activation
      CHECK (
        (active_snapshot_id IS NULL AND activated_at IS NULL)
        OR (active_snapshot_id IS NOT NULL AND activated_at IS NOT NULL AND isfinite(activated_at))
      ),
    CONSTRAINT ck_backstage_notion_heads_notion_active
      CHECK (authority <> 'notion' OR active_snapshot_id IS NOT NULL),
    CONSTRAINT ck_backstage_notion_heads_verified_at
      CHECK (
        (last_verified_at IS NULL OR isfinite(last_verified_at))
        AND (authority <> 'notion' OR last_verified_at IS NOT NULL)
      )
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_notion_authority_epoch (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
    epoch BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_backstage_notion_authority_epoch_singleton
      CHECK (singleton),
    CONSTRAINT ck_backstage_notion_authority_epoch_value
      CHECK (epoch >= 0),
    CONSTRAINT ck_backstage_notion_authority_epoch_timestamps
      CHECK (isfinite(created_at) AND isfinite(updated_at))
  )`,

  `INSERT INTO backstage_notion_authority_epoch (singleton, epoch)
   VALUES (TRUE, 0)
   ON CONFLICT (singleton) DO NOTHING`,

  `CREATE TABLE IF NOT EXISTS backstage_notion_snapshots (
    id UUID PRIMARY KEY,
    universe_id TEXT NOT NULL,
    root_page_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    source_max_edited_at TIMESTAMPTZ,
    sync_holder_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_backstage_notion_snapshots_universe_id UNIQUE (universe_id, id),
    CONSTRAINT fk_backstage_notion_snapshots_head
      FOREIGN KEY (universe_id)
      REFERENCES backstage_notion_universe_heads(universe_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT ck_backstage_notion_snapshots_root_page_id
      CHECK (root_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT ck_backstage_notion_snapshots_manifest_hash
      CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_notion_snapshots_embedding_model
      CHECK (char_length(btrim(embedding_model)) BETWEEN 1 AND 200),
    CONSTRAINT ck_backstage_notion_snapshots_counts_v3
      CHECK (page_count BETWEEN 1 AND 5000 AND chunk_count BETWEEN 1 AND 4096),
    CONSTRAINT ck_backstage_notion_snapshots_source_edited
      CHECK (source_max_edited_at IS NULL OR isfinite(source_max_edited_at)),
    CONSTRAINT ck_backstage_notion_snapshots_holder
      CHECK (char_length(btrim(sync_holder_id)) BETWEEN 1 AND 200),
    CONSTRAINT ck_backstage_notion_snapshots_created_at CHECK (isfinite(created_at))
  )`,

  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'backstage_notion_snapshots'::regclass
         AND conname = 'ck_backstage_notion_snapshots_counts'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'backstage_notion_snapshots'::regclass
         AND conname = 'ck_backstage_notion_snapshots_counts_v3'
     ) THEN
       LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
       LOCK TABLE backstage_notion_snapshots IN ACCESS EXCLUSIVE MODE;
       ALTER TABLE backstage_notion_snapshots
         DROP CONSTRAINT IF EXISTS ck_backstage_notion_snapshots_counts;
       ALTER TABLE backstage_notion_snapshots
         DROP CONSTRAINT IF EXISTS ck_backstage_notion_snapshots_counts_v3;
       ALTER TABLE backstage_notion_snapshots
         ADD CONSTRAINT ck_backstage_notion_snapshots_counts_v3
         CHECK (page_count BETWEEN 1 AND 5000 AND chunk_count BETWEEN 1 AND 4096);
     END IF;
   END
   $$`,

  `DO $$
   BEGIN
     LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'backstage_notion_universe_heads'::regclass
         AND conname = 'fk_backstage_notion_heads_active_snapshot'
     ) THEN
       ALTER TABLE backstage_notion_universe_heads
         ADD CONSTRAINT fk_backstage_notion_heads_active_snapshot
         FOREIGN KEY (universe_id, active_snapshot_id)
         REFERENCES backstage_notion_snapshots(universe_id, id)
         ON DELETE RESTRICT ON UPDATE RESTRICT
         DEFERRABLE INITIALLY DEFERRED;
     END IF;
   END
   $$`,

  `CREATE TABLE IF NOT EXISTS backstage_notion_snapshot_pages (
    snapshot_id UUID NOT NULL,
    universe_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    parent_page_id TEXT,
    title TEXT NOT NULL,
    canonical_url TEXT,
    content_hash TEXT NOT NULL,
    markdown TEXT NOT NULL,
    source_last_edited_at TIMESTAMPTZ,
    depth INTEGER NOT NULL,
    path JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_notion_snapshot_pages PRIMARY KEY (snapshot_id, page_id),
    CONSTRAINT uq_backstage_notion_pages_universe_id UNIQUE (universe_id, snapshot_id, page_id),
    CONSTRAINT fk_backstage_notion_pages_snapshot
      FOREIGN KEY (universe_id, snapshot_id)
      REFERENCES backstage_notion_snapshots(universe_id, id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_notion_pages_parent
      FOREIGN KEY (universe_id, snapshot_id, parent_page_id)
      REFERENCES backstage_notion_snapshot_pages(universe_id, snapshot_id, page_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_notion_pages_page_id
      CHECK (page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT ck_backstage_notion_pages_parent_page_id
      CHECK (
        parent_page_id IS NULL
        OR (
          parent_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND parent_page_id <> page_id
        )
      ),
    CONSTRAINT ck_backstage_notion_pages_title
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
    CONSTRAINT ck_backstage_notion_pages_url
      CHECK (canonical_url IS NULL OR char_length(canonical_url) BETWEEN 1 AND 4096),
    CONSTRAINT ck_backstage_notion_pages_content_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_notion_pages_markdown
      CHECK (octet_length(convert_to(markdown, 'UTF8')) <= 10485760),
    CONSTRAINT ck_backstage_notion_pages_source_edited
      CHECK (source_last_edited_at IS NULL OR isfinite(source_last_edited_at)),
    CONSTRAINT ck_backstage_notion_pages_depth CHECK (depth BETWEEN 0 AND 100),
    CONSTRAINT ck_backstage_notion_pages_path
      CHECK (
        jsonb_typeof(path) = 'array'
        AND jsonb_array_length(path) <= 101
        AND octet_length(convert_to(path::TEXT, 'UTF8')) <= 65536
      ),
    CONSTRAINT ck_backstage_notion_pages_metadata
      CHECK (
        jsonb_typeof(metadata) = 'object'
        AND octet_length(convert_to(metadata::TEXT, 'UTF8')) <= 262144
      )
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_notion_snapshot_chunks (
    id TEXT NOT NULL,
    snapshot_id UUID NOT NULL,
    universe_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    code_points INTEGER NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding JSONB NOT NULL,
    heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_notion_snapshot_chunks PRIMARY KEY (snapshot_id, id),
    CONSTRAINT uq_backstage_notion_chunks_position UNIQUE (snapshot_id, page_id, ordinal),
    CONSTRAINT fk_backstage_notion_chunks_page
      FOREIGN KEY (universe_id, snapshot_id, page_id)
      REFERENCES backstage_notion_snapshot_pages(universe_id, snapshot_id, page_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT ck_backstage_notion_chunks_id CHECK (id ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_notion_chunks_ordinal CHECK (ordinal >= 0),
    CONSTRAINT ck_backstage_notion_chunks_content_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_notion_chunks_content
      CHECK (
        char_length(btrim(content)) > 0
        AND octet_length(convert_to(content, 'UTF8')) <= 131072
      ),
    CONSTRAINT ck_backstage_notion_chunks_code_points CHECK (code_points BETWEEN 1 AND 131072),
    CONSTRAINT ck_backstage_notion_chunks_embedding_model
      CHECK (char_length(btrim(embedding_model)) BETWEEN 1 AND 200),
    CONSTRAINT ck_backstage_notion_chunks_embedding
      CHECK (
        jsonb_typeof(embedding) = 'array'
        AND jsonb_array_length(embedding) BETWEEN 1 AND 8192
        AND octet_length(convert_to(embedding::TEXT, 'UTF8')) <= 524288
      ),
    CONSTRAINT ck_backstage_notion_chunks_heading_path
      CHECK (
        jsonb_typeof(heading_path) = 'array'
        AND jsonb_array_length(heading_path) <= 32
        AND octet_length(convert_to(heading_path::TEXT, 'UTF8')) <= 32768
      ),
    CONSTRAINT ck_backstage_notion_chunks_metadata
      CHECK (
        jsonb_typeof(metadata) = 'object'
        AND octet_length(convert_to(metadata::TEXT, 'UTF8')) <= 262144
      )
  )`,

  `DO $$
   DECLARE
     existing_primary_key_name TEXT;
     existing_primary_key_definition TEXT;
   BEGIN
     LOCK TABLE backstage_notion_snapshot_chunks IN ACCESS EXCLUSIVE MODE;
     SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid)
     INTO existing_primary_key_name, existing_primary_key_definition
     FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'backstage_notion_snapshot_chunks'::regclass
       AND constraint_row.contype = 'p';

     IF existing_primary_key_definition IS NULL THEN
       ALTER TABLE backstage_notion_snapshot_chunks
         ADD CONSTRAINT pk_backstage_notion_snapshot_chunks
         PRIMARY KEY (snapshot_id, id);
     ELSIF regexp_replace(existing_primary_key_definition, '[[:space:]]+', '', 'g')
       = 'PRIMARYKEY(id)' THEN
       EXECUTE format(
         'ALTER TABLE backstage_notion_snapshot_chunks DROP CONSTRAINT %I',
         existing_primary_key_name
       );
       ALTER TABLE backstage_notion_snapshot_chunks
         ADD CONSTRAINT pk_backstage_notion_snapshot_chunks
         PRIMARY KEY (snapshot_id, id);
     ELSIF regexp_replace(existing_primary_key_definition, '[[:space:]]+', '', 'g')
       <> 'PRIMARYKEY(snapshot_id,id)' THEN
       RAISE EXCEPTION 'backstage_notion_snapshot_chunks has an unexpected primary key definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,

  `CREATE TABLE IF NOT EXISTS backstage_notion_sync_leases (
    universe_id TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    lease_token UUID NOT NULL UNIQUE,
    acquired_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_backstage_notion_sync_leases_head
      FOREIGN KEY (universe_id)
      REFERENCES backstage_notion_universe_heads(universe_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT ck_backstage_notion_sync_leases_holder
      CHECK (char_length(btrim(holder_id)) BETWEEN 1 AND 200),
    CONSTRAINT ck_backstage_notion_sync_leases_times
      CHECK (isfinite(acquired_at) AND isfinite(expires_at) AND expires_at > acquired_at)
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_notion_latest_sync_attempts (
    universe_id TEXT PRIMARY KEY,
    attempt_id UUID NOT NULL UNIQUE,
    attempt_generation BIGINT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    outcome TEXT NOT NULL,
    failure_phase TEXT,
    failure_reason TEXT,
    pages_discovered INTEGER NOT NULL DEFAULT 0,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    blocks_fetched INTEGER NOT NULL DEFAULT 0,
    chunks_produced INTEGER NOT NULL DEFAULT 0,
    chunks_embedded INTEGER NOT NULL DEFAULT 0,
    candidate_snapshot_created BOOLEAN NOT NULL DEFAULT FALSE,
    candidate_snapshot_validated BOOLEAN NOT NULL DEFAULT FALSE,
    candidate_snapshot_activated BOOLEAN NOT NULL DEFAULT FALSE,
    activated_snapshot_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_backstage_notion_latest_sync_attempts_head
      FOREIGN KEY (universe_id)
      REFERENCES backstage_notion_universe_heads(universe_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_notion_latest_sync_attempts_snapshot
      FOREIGN KEY (universe_id, activated_snapshot_id)
      REFERENCES backstage_notion_snapshots(universe_id, id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_generation
      CHECK (attempt_generation > 0),
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_times
      CHECK (
        isfinite(started_at)
        AND isfinite(updated_at)
        AND (completed_at IS NULL OR (
          isfinite(completed_at)
          AND completed_at >= started_at
        ))
      ),
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_outcome
      CHECK (outcome IN ('running', 'activated', 'unchanged', 'failed')),
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_failure_phase
      CHECK (failure_phase IS NULL OR failure_phase IN (
        'authorization', 'root_resolution', 'discovery', 'page_fetch',
        'block_fetch', 'pagination', 'normalization', 'chunking', 'embedding',
        'persistence', 'completeness_validation', 'activation', 'cleanup',
        'deadline', 'lease'
      )),
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_failure_reason
      CHECK (failure_reason IS NULL OR failure_reason IN (
        'deadline_exhausted', 'rate_limit_exhausted',
        'transient_retry_exhausted', 'permanent_notion_error',
        'inaccessible_page', 'pagination_incomplete',
        'discovered_page_missing', 'source_changed', 'chunk_limit_reached',
        'embedding_failed', 'persistence_failed', 'completeness_mismatch',
        'activation_failed', 'lease_lost', 'invalid_configuration',
        'unexpected_failure'
      )),
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_counts
      CHECK (
        pages_discovered BETWEEN 0 AND 1000000
        AND pages_fetched BETWEEN 0 AND 1000000
        AND blocks_fetched BETWEEN 0 AND 1000000
        AND chunks_produced BETWEEN 0 AND 1000000
        AND chunks_embedded BETWEEN 0 AND 1000000
      ),
    CONSTRAINT ck_backstage_notion_latest_sync_attempts_state
      CHECK (
        (
          outcome = 'running'
          AND completed_at IS NULL
          AND failure_phase IS NULL
          AND failure_reason IS NULL
          AND activated_snapshot_id IS NULL
          AND NOT candidate_snapshot_created
          AND NOT candidate_snapshot_validated
          AND NOT candidate_snapshot_activated
        )
        OR (
          outcome = 'failed'
          AND completed_at IS NOT NULL
          AND failure_phase IS NOT NULL
          AND failure_reason IS NOT NULL
          AND activated_snapshot_id IS NULL
          AND NOT candidate_snapshot_activated
        )
        OR (
          outcome = 'activated'
          AND completed_at IS NOT NULL
          AND failure_phase IS NULL
          AND failure_reason IS NULL
          AND activated_snapshot_id IS NOT NULL
          AND candidate_snapshot_created
          AND candidate_snapshot_validated
          AND candidate_snapshot_activated
        )
        OR (
          outcome = 'unchanged'
          AND completed_at IS NOT NULL
          AND failure_phase IS NULL
          AND failure_reason IS NULL
          AND activated_snapshot_id IS NOT NULL
          AND NOT candidate_snapshot_created
          AND NOT candidate_snapshot_validated
          AND NOT candidate_snapshot_activated
        )
      )
  )`,

  `CREATE INDEX IF NOT EXISTS idx_backstage_notion_snapshots_universe_created
     ON backstage_notion_snapshots(universe_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_notion_pages_snapshot_depth
     ON backstage_notion_snapshot_pages(universe_id, snapshot_id, depth, page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunks_active_scan
     ON backstage_notion_snapshot_chunks(universe_id, snapshot_id, page_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunks_embedding_reuse
     ON backstage_notion_snapshot_chunks(universe_id, embedding_model, content_hash, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_notion_sync_leases_expiry
     ON backstage_notion_sync_leases(expires_at)`,

  `CREATE OR REPLACE FUNCTION backstage_notion_reject_immutable_mutation()
   RETURNS TRIGGER
   LANGUAGE plpgsql
   SET search_path = pg_catalog, public
   AS $$
   BEGIN
     RAISE EXCEPTION '% is immutable after insertion', TG_TABLE_NAME
       USING ERRCODE = '55000';
   END
   $$`,

  `DO $$
   DECLARE
     target_table TEXT;
     existing_trigger_function OID;
     existing_trigger_type SMALLINT;
     existing_trigger_enabled "char";
   BEGIN
     FOREACH target_table IN ARRAY ARRAY[
       'backstage_notion_snapshots',
       'backstage_notion_snapshot_pages',
       'backstage_notion_snapshot_chunks'
     ]
     LOOP
       EXECUTE format(
         'LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',
         target_table
       );
       existing_trigger_function := NULL;
       existing_trigger_type := NULL;
       existing_trigger_enabled := NULL;
       SELECT trigger_row.tgfoid, trigger_row.tgtype, trigger_row.tgenabled
         INTO existing_trigger_function, existing_trigger_type, existing_trigger_enabled
         FROM pg_trigger AS trigger_row
         WHERE trigger_row.tgrelid = target_table::regclass
           AND trigger_row.tgname = 'trg_backstage_notion_immutable'
           AND NOT trigger_row.tgisinternal;
       IF existing_trigger_function IS NULL THEN
         EXECUTE format(
           'CREATE TRIGGER trg_backstage_notion_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION backstage_notion_reject_immutable_mutation()',
           target_table
         );
       ELSIF existing_trigger_function <> 'backstage_notion_reject_immutable_mutation()'::regprocedure
         OR existing_trigger_type <> 27
         OR existing_trigger_enabled <> 'O'
       THEN
         RAISE EXCEPTION 'trg_backstage_notion_immutable on % has an unexpected definition', target_table
           USING ERRCODE = '42804';
       END IF;
     END LOOP;
   END
   $$`,

  `CREATE OR REPLACE FUNCTION backstage_notion_guard_authority_persistence()
   RETURNS TRIGGER
   LANGUAGE plpgsql
   SET search_path = pg_catalog, public
   AS $$
   DECLARE
     old_root_page_id TEXT;
     new_root_page_id TEXT;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       IF OLD.authority = 'notion' THEN
         RAISE EXCEPTION 'Notion authority cannot be deleted for a Backstage universe'
           USING ERRCODE = 'BN001';
       END IF;
       RETURN OLD;
     END IF;

     IF OLD.authority = 'notion' AND NEW.authority IS DISTINCT FROM 'notion' THEN
       RAISE EXCEPTION 'Notion authority cannot be downgraded for a Backstage universe'
         USING ERRCODE = 'BN001';
     END IF;

     IF OLD.authority = 'notion'
       AND NEW.active_snapshot_id IS DISTINCT FROM OLD.active_snapshot_id
     THEN
       SELECT snapshot.root_page_id
         INTO old_root_page_id
         FROM public.backstage_notion_snapshots AS snapshot
         WHERE snapshot.universe_id = OLD.universe_id
           AND snapshot.id = OLD.active_snapshot_id;

       SELECT snapshot.root_page_id
         INTO new_root_page_id
         FROM public.backstage_notion_snapshots AS snapshot
         WHERE snapshot.universe_id = NEW.universe_id
           AND snapshot.id = NEW.active_snapshot_id;

       IF old_root_page_id IS NULL
         OR new_root_page_id IS NULL
         OR new_root_page_id IS DISTINCT FROM old_root_page_id
       THEN
         RAISE EXCEPTION 'Notion authority root cannot be changed for a Backstage universe'
           USING ERRCODE = 'BN001';
       END IF;
     END IF;

     RETURN NEW;
   END
   $$`,

  `DO $$
   DECLARE
     existing_trigger_function OID;
     existing_trigger_type SMALLINT;
     existing_trigger_enabled "char";
   BEGIN
     LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
     SELECT trigger_row.tgfoid, trigger_row.tgtype, trigger_row.tgenabled
       INTO existing_trigger_function, existing_trigger_type, existing_trigger_enabled
       FROM pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'backstage_notion_universe_heads'::regclass
         AND trigger_row.tgname = 'trg_backstage_notion_authority_persistence'
         AND NOT trigger_row.tgisinternal;
     IF existing_trigger_function IS NULL THEN
       CREATE TRIGGER trg_backstage_notion_authority_persistence
         BEFORE UPDATE OR DELETE ON backstage_notion_universe_heads
         FOR EACH ROW
         EXECUTE FUNCTION backstage_notion_guard_authority_persistence();
     ELSIF existing_trigger_function = 'backstage_notion_guard_authority_persistence()'::regprocedure
       AND existing_trigger_type = 19
       AND existing_trigger_enabled = 'O'
     THEN
       DROP TRIGGER trg_backstage_notion_authority_persistence
         ON backstage_notion_universe_heads;
       CREATE TRIGGER trg_backstage_notion_authority_persistence
         BEFORE UPDATE OR DELETE ON backstage_notion_universe_heads
         FOR EACH ROW
         EXECUTE FUNCTION backstage_notion_guard_authority_persistence();
     ELSIF existing_trigger_function <> 'backstage_notion_guard_authority_persistence()'::regprocedure
       OR existing_trigger_type <> 27
       OR existing_trigger_enabled <> 'O'
     THEN
       RAISE EXCEPTION 'trg_backstage_notion_authority_persistence has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,

  `CREATE OR REPLACE FUNCTION backstage_notion_guard_legacy_mutation()
   RETURNS TRIGGER
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, public
   AS $$
   DECLARE
     old_universe_id TEXT;
     new_universe_id TEXT;
     authority_epoch BIGINT;
     authority_row RECORD;
   BEGIN
     IF TG_OP = 'INSERT' THEN
       new_universe_id := NEW.universe_id;
     ELSIF TG_OP = 'DELETE' THEN
       old_universe_id := OLD.universe_id;
     ELSE
       old_universe_id := OLD.universe_id;
       new_universe_id := NEW.universe_id;
     END IF;
     SELECT epoch_row.epoch
       INTO authority_epoch
       FROM public.backstage_notion_authority_epoch AS epoch_row
       WHERE epoch_row.singleton = TRUE
       FOR KEY SHARE;

     IF authority_epoch IS NULL THEN
       RAISE EXCEPTION 'Backstage Notion authority epoch is unavailable'
         USING ERRCODE = 'BN001';
     END IF;

     FOR authority_row IN
       SELECT head.authority
       FROM public.backstage_notion_universe_heads AS head
       WHERE head.universe_id IN (old_universe_id, new_universe_id)
       ORDER BY head.universe_id
       FOR SHARE
     LOOP
       IF authority_row.authority = 'notion' THEN
         RAISE EXCEPTION 'legacy Backstage writes are disabled for a Notion-authoritative universe'
           USING ERRCODE = 'BN001';
       END IF;
     END LOOP;
     IF TG_OP = 'DELETE' THEN
       RETURN OLD;
     END IF;
     RETURN NEW;
   END
   $$`,

  `DO $$
   DECLARE
     target_table TEXT;
     existing_trigger_function OID;
     existing_trigger_type SMALLINT;
     existing_trigger_enabled "char";
   BEGIN
     FOREACH target_table IN ARRAY ARRAY[
       'backstage_events',
       'backstage_wrestlers',
       'backstage_storylines',
       'backstage_story_beats',
       'backstage_canon_heads',
       'backstage_canon_revisions',
       'backstage_storyline_threads',
       'backstage_storyline_participants',
       'backstage_storyline_canon_beats'
     ]
     LOOP
       EXECUTE format(
         'LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',
         target_table
       );
       existing_trigger_function := NULL;
       existing_trigger_type := NULL;
       existing_trigger_enabled := NULL;
       SELECT trigger_row.tgfoid, trigger_row.tgtype, trigger_row.tgenabled
         INTO existing_trigger_function, existing_trigger_type, existing_trigger_enabled
         FROM pg_trigger AS trigger_row
         WHERE trigger_row.tgrelid = target_table::regclass
           AND trigger_row.tgname = 'trg_backstage_notion_authority_guard'
           AND NOT trigger_row.tgisinternal;
       IF existing_trigger_function IS NULL THEN
         EXECUTE format(
           'CREATE TRIGGER trg_backstage_notion_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION backstage_notion_guard_legacy_mutation()',
           target_table
         );
       ELSIF existing_trigger_function <> 'backstage_notion_guard_legacy_mutation()'::regprocedure
         OR existing_trigger_type <> 31
         OR existing_trigger_enabled <> 'O'
       THEN
         RAISE EXCEPTION 'trg_backstage_notion_authority_guard on % has an unexpected definition', target_table
           USING ERRCODE = '42804';
       END IF;
     END LOOP;
   END
   $$`,

  `CREATE OR REPLACE FUNCTION backstage_notion_snapshot_index_version(
     target_universe_id TEXT,
     target_snapshot_id UUID
   )
   RETURNS INTEGER
   LANGUAGE plpgsql
   STABLE
   SET search_path = pg_catalog, public
   AS $$
   DECLARE
     expected_page_count INTEGER;
     expected_chunk_count INTEGER;
     actual_page_count BIGINT;
     actual_chunk_count BIGINT;
     distinct_marker_count BIGINT;
     derived_index_version INTEGER;
   BEGIN
     SELECT snapshot.page_count, snapshot.chunk_count
       INTO expected_page_count, expected_chunk_count
       FROM public.backstage_notion_snapshots AS snapshot
       WHERE snapshot.universe_id = target_universe_id
         AND snapshot.id = target_snapshot_id;

     IF expected_page_count IS NULL THEN
       RAISE EXCEPTION 'Backstage Notion snapshot index version cannot be derived from an unknown snapshot'
         USING ERRCODE = 'BN002';
     END IF;

     SELECT
       COUNT(*),
       COUNT(DISTINCT page_marker.index_version),
       MIN(page_marker.index_version)
       INTO actual_page_count, distinct_marker_count, derived_index_version
       FROM (
         SELECT CASE
           WHEN jsonb_typeof(page.metadata -> 'indexFormat') = 'string'
             AND (page.metadata ->> 'indexFormat')
               ~ '^backstage-notion-rag-index-v(0|[1-9][0-9]{0,8})$'
           THEN substring(
             page.metadata ->> 'indexFormat'
             FROM '^backstage-notion-rag-index-v([0-9]+)$'
           )::INTEGER
           ELSE 0
         END AS index_version
         FROM public.backstage_notion_snapshot_pages AS page
         WHERE page.universe_id = target_universe_id
           AND page.snapshot_id = target_snapshot_id
       ) AS page_marker;

     IF actual_page_count IS DISTINCT FROM expected_page_count::BIGINT THEN
       RAISE EXCEPTION 'Backstage Notion snapshot page inventory is incomplete for index activation'
         USING ERRCODE = 'BN002';
     END IF;
     SELECT COUNT(*)
       INTO actual_chunk_count
       FROM public.backstage_notion_snapshot_chunks AS chunk
       WHERE chunk.universe_id = target_universe_id
         AND chunk.snapshot_id = target_snapshot_id;
     IF actual_chunk_count IS DISTINCT FROM expected_chunk_count::BIGINT THEN
       RAISE EXCEPTION 'Backstage Notion snapshot chunk inventory is incomplete for index activation'
         USING ERRCODE = 'BN002';
     END IF;
     IF distinct_marker_count IS DISTINCT FROM 1::BIGINT THEN
       RAISE EXCEPTION 'Backstage Notion snapshot contains mixed index format markers'
         USING ERRCODE = 'BN002';
     END IF;

     RETURN derived_index_version;
   END
   $$`,

  `CREATE OR REPLACE FUNCTION backstage_notion_guard_index_version_activation()
   RETURNS TRIGGER
   LANGUAGE plpgsql
   SET search_path = pg_catalog, public
   AS $$
   DECLARE
     current_index_version INTEGER := 0;
     candidate_index_version INTEGER;
   BEGIN
     IF NEW.active_snapshot_id IS NOT DISTINCT FROM OLD.active_snapshot_id THEN
       RETURN NEW;
     END IF;
     IF NEW.active_snapshot_id IS NULL THEN
       RAISE EXCEPTION 'Backstage Notion active snapshot cannot be cleared across the index version fence'
         USING ERRCODE = 'BN002';
     END IF;

     candidate_index_version := public.backstage_notion_snapshot_index_version(
       NEW.universe_id,
       NEW.active_snapshot_id
     );
     IF OLD.active_snapshot_id IS NOT NULL THEN
       current_index_version := public.backstage_notion_snapshot_index_version(
         OLD.universe_id,
         OLD.active_snapshot_id
       );
     END IF;

     IF candidate_index_version < current_index_version THEN
       RAISE EXCEPTION 'Backstage Notion index version downgrade rejected (% to %)',
         current_index_version,
         candidate_index_version
         USING ERRCODE = 'BN002';
     END IF;
     RETURN NEW;
   END
   $$`,

  `DO $$
   DECLARE
     existing_trigger_function OID;
     existing_trigger_type SMALLINT;
     existing_trigger_enabled "char";
     existing_trigger_columns TEXT;
     existing_trigger_when TEXT;
   BEGIN
     LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
     SELECT
       trigger_row.tgfoid,
       trigger_row.tgtype,
       trigger_row.tgenabled,
       trigger_row.tgattr::TEXT,
       pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid)
       INTO
         existing_trigger_function,
         existing_trigger_type,
         existing_trigger_enabled,
         existing_trigger_columns,
         existing_trigger_when
       FROM pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'backstage_notion_universe_heads'::regclass
         AND trigger_row.tgname = 'trg_backstage_notion_index_version_fence'
         AND NOT trigger_row.tgisinternal;

     IF existing_trigger_function IS NULL THEN
       CREATE TRIGGER trg_backstage_notion_index_version_fence
         BEFORE UPDATE ON backstage_notion_universe_heads
         FOR EACH ROW
         EXECUTE FUNCTION backstage_notion_guard_index_version_activation();
     ELSIF existing_trigger_function
         <> 'backstage_notion_guard_index_version_activation()'::regprocedure
       OR existing_trigger_type <> 19
       OR existing_trigger_enabled <> 'O'
       OR existing_trigger_columns <> ''
       OR existing_trigger_when IS NOT NULL
     THEN
       RAISE EXCEPTION 'trg_backstage_notion_index_version_fence has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`
] as const;

// Database Table Definitions
export const TABLE_DEFINITIONS = [
  // Saves table for persistence operations
  `CREATE TABLE IF NOT EXISTS saves (
    id SERIAL PRIMARY KEY,
    module TEXT NOT NULL,
    data JSONB NOT NULL,
    timestamp BIGINT NOT NULL
  )`,

  // Audit logs table for persistence and rollback tracking
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    event TEXT NOT NULL,
    payload JSONB,
    timestamp BIGINT NOT NULL
  )`,

  // Memory table for persistent worker memory
  `CREATE TABLE IF NOT EXISTS memory (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE memory ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,

  // RAG documents table for persistent embeddings
  `CREATE TABLE IF NOT EXISTS rag_docs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding JSONB NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE rag_docs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`,

  // Durable, source-attributable ARCANOS Gaming knowledge
  `CREATE TABLE IF NOT EXISTS gaming_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_key TEXT NOT NULL,
    game_name TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    canonical_url_hash TEXT NOT NULL,
    public_url TEXT NOT NULL,
    host TEXT NOT NULL,
    source_type TEXT NOT NULL,
    trust_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    priority SMALLINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    last_checked_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    next_refresh_at TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_gaming_sources_game_url_hash
      UNIQUE (game_key, canonical_url_hash),
    CONSTRAINT ck_gaming_sources_game_key
      CHECK (char_length(btrim(game_key)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_sources_game_name
      CHECK (char_length(btrim(game_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_sources_canonical_url
      CHECK (char_length(canonical_url) BETWEEN 1 AND 4096),
    CONSTRAINT ck_gaming_sources_canonical_url_hash
      CHECK (canonical_url_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_gaming_sources_public_url
      CHECK (char_length(public_url) BETWEEN 1 AND 4096),
    CONSTRAINT ck_gaming_sources_host
      CHECK (char_length(btrim(host)) BETWEEN 1 AND 253),
    CONSTRAINT ck_gaming_sources_source_type
      CHECK (source_type IN ('official', 'patch_notes', 'wiki', 'curated', 'supplied')),
    CONSTRAINT ck_gaming_sources_trust_score
      CHECK (trust_score BETWEEN 0 AND 1),
    CONSTRAINT ck_gaming_sources_priority
      CHECK (priority BETWEEN 0 AND 100),
    CONSTRAINT ck_gaming_sources_status
      CHECK (status IN ('active', 'degraded', 'disabled')),
    CONSTRAINT ck_gaming_sources_last_error_code
      CHECK (last_error_code IS NULL OR char_length(btrim(last_error_code)) BETWEEN 1 AND 120)
  )`,

  `CREATE TABLE IF NOT EXISTS gaming_source_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL,
    content_hash TEXT NOT NULL,
    cleaned_content TEXT NOT NULL,
    etag TEXT,
    last_modified TEXT,
    fetched_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ,
    patch TEXT,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    normalizer_schema_version TEXT NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    extraction_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_gaming_source_revisions_identity
      UNIQUE (
        source_id,
        content_hash,
        extractor,
        extractor_version,
        normalizer_schema_version
      ),
    CONSTRAINT fk_gaming_source_revisions_source
      FOREIGN KEY (source_id)
      REFERENCES gaming_sources(id)
      ON DELETE CASCADE,
    CONSTRAINT ck_gaming_source_revisions_content_hash
      CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_gaming_source_revisions_cleaned_content
      CHECK (char_length(btrim(cleaned_content)) BETWEEN 1 AND 1000000),
    CONSTRAINT ck_gaming_source_revisions_etag
      CHECK (etag IS NULL OR char_length(etag) BETWEEN 1 AND 1024),
    CONSTRAINT ck_gaming_source_revisions_last_modified
      CHECK (last_modified IS NULL OR char_length(last_modified) BETWEEN 1 AND 256),
    CONSTRAINT ck_gaming_source_revisions_patch
      CHECK (patch IS NULL OR char_length(btrim(patch)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_source_revisions_extractor
      CHECK (char_length(btrim(extractor)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_source_revisions_extractor_version
      CHECK (char_length(btrim(extractor_version)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_source_revisions_normalizer_schema_version
      CHECK (char_length(btrim(normalizer_schema_version)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_source_revisions_provenance
      CHECK (jsonb_typeof(provenance) = 'object'),
    CONSTRAINT ck_gaming_source_revisions_extraction_metrics
      CHECK (jsonb_typeof(extraction_metrics) = 'object')
  )`,

  `CREATE TABLE IF NOT EXISTS gaming_knowledge_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_revision_id UUID NOT NULL,
    game_key TEXT NOT NULL,
    record_type TEXT NOT NULL,
    semantic_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    title TEXT,
    patch TEXT,
    search_text TEXT NOT NULL,
    normalized JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_gaming_knowledge_records_revision_semantic_payload
      UNIQUE (source_revision_id, semantic_key, payload_hash),
    CONSTRAINT fk_gaming_knowledge_records_revision
      FOREIGN KEY (source_revision_id)
      REFERENCES gaming_source_revisions(id)
      ON DELETE CASCADE,
    CONSTRAINT ck_gaming_knowledge_records_game_key
      CHECK (char_length(btrim(game_key)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_knowledge_records_type
      CHECK (record_type IN ('guide', 'build', 'meta')),
    CONSTRAINT ck_gaming_knowledge_records_semantic_key
      CHECK (char_length(btrim(semantic_key)) BETWEEN 1 AND 500),
    CONSTRAINT ck_gaming_knowledge_records_payload_hash
      CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_gaming_knowledge_records_title
      CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 500),
    CONSTRAINT ck_gaming_knowledge_records_patch
      CHECK (patch IS NULL OR char_length(btrim(patch)) BETWEEN 1 AND 120),
    CONSTRAINT ck_gaming_knowledge_records_search_text
      CHECK (char_length(btrim(search_text)) BETWEEN 1 AND 100000),
    CONSTRAINT ck_gaming_knowledge_records_normalized
      CHECK (jsonb_typeof(normalized) = 'object'),
    CONSTRAINT ck_gaming_knowledge_records_status
      CHECK (status IN ('active', 'superseded')),
    CONSTRAINT ck_gaming_knowledge_records_superseded_at
      CHECK (
        (status = 'active' AND superseded_at IS NULL)
        OR (status = 'superseded' AND superseded_at IS NOT NULL)
      )
  )`,

  `CREATE INDEX IF NOT EXISTS idx_gaming_sources_game_status_type
    ON gaming_sources(game_key, status, source_type, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gaming_source_revisions_source_fetched
    ON gaming_source_revisions(source_id, fetched_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gaming_knowledge_game_type_status_patch
    ON gaming_knowledge_records(game_key, record_type, status, patch)`,
  `CREATE INDEX IF NOT EXISTS idx_gaming_knowledge_semantic_status
    ON gaming_knowledge_records(game_key, semantic_key, status)`,
  `CREATE INDEX IF NOT EXISTS idx_gaming_knowledge_active_search
    ON gaming_knowledge_records
    USING GIN (to_tsvector('simple'::regconfig, search_text))
    WHERE status = 'active'`,

  // Backstage Booker tables for persistent wrestling data
  `CREATE TABLE IF NOT EXISTS backstage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    universe_id TEXT NOT NULL DEFAULT 'legacy',
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_backstage_events_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT uq_backstage_events_universe_id
      UNIQUE (universe_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_wrestlers (
    id SERIAL PRIMARY KEY,
    universe_id TEXT NOT NULL DEFAULT 'legacy',
    name TEXT NOT NULL,
    overall INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_backstage_wrestlers_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT backstage_wrestlers_name_key
      UNIQUE (name),
    CONSTRAINT uq_backstage_wrestlers_universe_name
      UNIQUE (universe_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_storylines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    universe_id TEXT NOT NULL DEFAULT 'legacy',
    story_key TEXT NOT NULL,
    storyline TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_backstage_storylines_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT backstage_storylines_story_key_key
      UNIQUE (story_key),
    CONSTRAINT uq_backstage_storylines_universe_story_key
      UNIQUE (universe_id, story_key)
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_story_beats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    universe_id TEXT NOT NULL DEFAULT 'legacy',
    data JSONB NOT NULL,
    serialized_data TEXT,
    storage_sequence BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_backstage_story_beats_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  )`,

  `ALTER TABLE backstage_story_beats
     ADD COLUMN IF NOT EXISTS serialized_data TEXT`,

  `ALTER TABLE backstage_story_beats
     ADD COLUMN IF NOT EXISTS storage_sequence BIGINT`,

  `DO $$
   DECLARE
     serialized_data_type OID;
     serialized_data_type_modifier INTEGER;
     serialized_data_not_null BOOLEAN;
     serialized_data_identity "char";
     serialized_data_generated "char";
     serialized_data_default TEXT;
     serialized_data_is_local BOOLEAN;
     serialized_data_inheritance_count INTEGER;
   BEGIN
     SELECT
       attribute.atttypid,
       attribute.atttypmod,
       attribute.attnotnull,
       attribute.attidentity,
       attribute.attgenerated,
       pg_get_expr(attribute_default.adbin, attribute_default.adrelid),
       attribute.attislocal,
       attribute.attinhcount
     INTO
       serialized_data_type,
       serialized_data_type_modifier,
       serialized_data_not_null,
       serialized_data_identity,
       serialized_data_generated,
       serialized_data_default,
       serialized_data_is_local,
       serialized_data_inheritance_count
     FROM pg_attribute AS attribute
     LEFT JOIN pg_attrdef AS attribute_default
       ON attribute_default.adrelid = attribute.attrelid
      AND attribute_default.adnum = attribute.attnum
     WHERE attribute.attrelid = 'backstage_story_beats'::regclass
       AND attribute.attname = 'serialized_data'
       AND NOT attribute.attisdropped;

     IF serialized_data_type IS DISTINCT FROM 'text'::regtype
       OR serialized_data_type_modifier <> -1
       OR serialized_data_not_null
       OR serialized_data_identity <> ''
       OR serialized_data_generated <> ''
       OR serialized_data_default IS NOT NULL
       OR NOT serialized_data_is_local
       OR serialized_data_inheritance_count <> 0 THEN
       RAISE EXCEPTION
         'backstage_story_beats.serialized_data has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,

  `DO $$
   DECLARE
     storage_sequence_type OID;
     storage_sequence_type_modifier INTEGER;
     storage_sequence_not_null BOOLEAN;
     storage_sequence_identity "char";
     storage_sequence_generated "char";
     storage_sequence_default TEXT;
     storage_sequence_is_local BOOLEAN;
     storage_sequence_inheritance_count INTEGER;
   BEGIN
     SELECT
       attribute.atttypid,
       attribute.atttypmod,
       attribute.attnotnull,
       attribute.attidentity,
       attribute.attgenerated,
       pg_get_expr(attribute_default.adbin, attribute_default.adrelid),
       attribute.attislocal,
       attribute.attinhcount
     INTO
       storage_sequence_type,
       storage_sequence_type_modifier,
       storage_sequence_not_null,
       storage_sequence_identity,
       storage_sequence_generated,
       storage_sequence_default,
       storage_sequence_is_local,
       storage_sequence_inheritance_count
     FROM pg_attribute AS attribute
     LEFT JOIN pg_attrdef AS attribute_default
       ON attribute_default.adrelid = attribute.attrelid
      AND attribute_default.adnum = attribute.attnum
     WHERE attribute.attrelid = 'backstage_story_beats'::regclass
       AND attribute.attname = 'storage_sequence'
       AND NOT attribute.attisdropped;

     IF storage_sequence_type IS DISTINCT FROM 'bigint'::regtype
       OR storage_sequence_type_modifier <> -1
       OR storage_sequence_not_null
       OR storage_sequence_identity <> ''
       OR storage_sequence_generated <> ''
       OR storage_sequence_default IS NOT NULL
       OR NOT storage_sequence_is_local
       OR storage_sequence_inheritance_count <> 0 THEN
       RAISE EXCEPTION
         'backstage_story_beats.storage_sequence has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,

  `DO $$
   DECLARE
     actual_constraint_oid OID;
     actual_constraint_type "char";
     actual_constraint_expression TEXT;
     actual_constraint_no_inherit BOOLEAN;
     actual_constraint_is_local BOOLEAN;
     actual_constraint_inheritance_count INTEGER;
     actual_constraint_parent OID;
     actual_constraint_enforced BOOLEAN;
     expected_constraint_expression TEXT;
   BEGIN
     LOCK TABLE backstage_story_beats IN SHARE ROW EXCLUSIVE MODE;

     SELECT
       oid,
       contype,
       pg_get_expr(conbin, conrelid, false),
       connoinherit,
       conislocal,
       coninhcount,
       conparentid,
       COALESCE((to_jsonb(pg_constraint) ->> 'conenforced')::BOOLEAN, TRUE)
     INTO
       actual_constraint_oid,
       actual_constraint_type,
       actual_constraint_expression,
       actual_constraint_no_inherit,
       actual_constraint_is_local,
       actual_constraint_inheritance_count,
       actual_constraint_parent,
       actual_constraint_enforced
     FROM pg_constraint
     WHERE conrelid = 'backstage_story_beats'::regclass
       AND conname = 'backstage_story_beats_serialized_data_contract';

     IF EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'backstage_story_beats'::regclass
         AND conname = 'backstage_story_beats_serialized_data_contract_expected'
     ) THEN
       RAISE EXCEPTION
         'reserved storyline constraint verifier name is already in use'
         USING ERRCODE = '42804';
     END IF;

     IF actual_constraint_oid IS NULL THEN
       ALTER TABLE backstage_story_beats
         ADD CONSTRAINT backstage_story_beats_serialized_data_contract
         CHECK (
           (serialized_data IS NULL AND storage_sequence IS NULL)
           OR (
             serialized_data IS NOT NULL
             AND octet_length(convert_to(serialized_data, 'UTF8')) <= 16384
             AND serialized_data IS JSON OBJECT
             AND storage_sequence IS NOT NULL
             AND storage_sequence > 0
             AND created_at IS NOT NULL
             AND isfinite(created_at)
           )
         ) NOT VALID;
     ELSE
       ALTER TABLE backstage_story_beats
         ADD CONSTRAINT backstage_story_beats_serialized_data_contract_expected
         CHECK (
           (serialized_data IS NULL AND storage_sequence IS NULL)
           OR (
             serialized_data IS NOT NULL
             AND octet_length(convert_to(serialized_data, 'UTF8')) <= 16384
             AND serialized_data IS JSON OBJECT
             AND storage_sequence IS NOT NULL
             AND storage_sequence > 0
             AND created_at IS NOT NULL
             AND isfinite(created_at)
           )
         ) NOT VALID;

       SELECT pg_get_expr(conbin, conrelid, false)
       INTO expected_constraint_expression
       FROM pg_constraint
       WHERE conrelid = 'backstage_story_beats'::regclass
         AND conname = 'backstage_story_beats_serialized_data_contract_expected';

       ALTER TABLE backstage_story_beats
         DROP CONSTRAINT backstage_story_beats_serialized_data_contract_expected;

       IF actual_constraint_type <> 'c'
         OR actual_constraint_expression IS DISTINCT FROM expected_constraint_expression
         OR actual_constraint_no_inherit
         OR NOT actual_constraint_is_local
         OR actual_constraint_inheritance_count <> 0
         OR actual_constraint_parent <> 0
         OR NOT actual_constraint_enforced THEN
         RAISE EXCEPTION
           'backstage_story_beats_serialized_data_contract has an unexpected definition'
           USING ERRCODE = '42804';
       END IF;
     END IF;
   END
   $$`,

  `ALTER TABLE backstage_story_beats
     VALIDATE CONSTRAINT backstage_story_beats_serialized_data_contract`,

  // Upgrade existing Backstage Booker tables to universe-scoped storage.
  `ALTER TABLE backstage_events ADD COLUMN IF NOT EXISTS universe_id TEXT`,
  `ALTER TABLE backstage_wrestlers ADD COLUMN IF NOT EXISTS universe_id TEXT`,
  `ALTER TABLE backstage_storylines ADD COLUMN IF NOT EXISTS universe_id TEXT`,
  `ALTER TABLE backstage_story_beats ADD COLUMN IF NOT EXISTS universe_id TEXT`,
  `UPDATE backstage_events SET universe_id = 'legacy' WHERE universe_id IS NULL OR btrim(universe_id) = ''`,
  `UPDATE backstage_wrestlers SET universe_id = 'legacy' WHERE universe_id IS NULL OR btrim(universe_id) = ''`,
  `UPDATE backstage_storylines SET universe_id = 'legacy' WHERE universe_id IS NULL OR btrim(universe_id) = ''`,
  `UPDATE backstage_story_beats SET universe_id = 'legacy' WHERE universe_id IS NULL OR btrim(universe_id) = ''`,
  `ALTER TABLE backstage_events ALTER COLUMN universe_id SET DEFAULT 'legacy'`,
  `ALTER TABLE backstage_wrestlers ALTER COLUMN universe_id SET DEFAULT 'legacy'`,
  `ALTER TABLE backstage_storylines ALTER COLUMN universe_id SET DEFAULT 'legacy'`,
  `ALTER TABLE backstage_story_beats ALTER COLUMN universe_id SET DEFAULT 'legacy'`,
  `ALTER TABLE backstage_events ALTER COLUMN universe_id SET NOT NULL`,
  `ALTER TABLE backstage_wrestlers ALTER COLUMN universe_id SET NOT NULL`,
  `ALTER TABLE backstage_storylines ALTER COLUMN universe_id SET NOT NULL`,
  `ALTER TABLE backstage_story_beats ALTER COLUMN universe_id SET NOT NULL`,
  `DO $$
   DECLARE
     target RECORD;
     expected_constraint_name TEXT;
     actual_constraint_oid OID;
     actual_constraint_type "char";
     actual_constraint_expression TEXT;
     actual_constraint_no_inherit BOOLEAN;
     actual_constraint_is_local BOOLEAN;
     actual_constraint_inheritance_count INTEGER;
     actual_constraint_parent OID;
     actual_constraint_enforced BOOLEAN;
     expected_constraint_expression TEXT;
   BEGIN
     FOR target IN
       SELECT *
       FROM (VALUES
         ('backstage_wrestlers', 'ck_backstage_wrestlers_universe_id'),
         ('backstage_events', 'ck_backstage_events_universe_id'),
         ('backstage_story_beats', 'ck_backstage_story_beats_universe_id'),
         ('backstage_storylines', 'ck_backstage_storylines_universe_id')
       ) AS targets(table_name, constraint_name)
     LOOP
       EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', target.table_name);
       actual_constraint_oid := NULL;
       actual_constraint_type := NULL;
       actual_constraint_expression := NULL;
       expected_constraint_expression := NULL;
       expected_constraint_name := target.constraint_name || '_expected';

       SELECT
         constraint_row.oid,
         constraint_row.contype,
         pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false),
         constraint_row.connoinherit,
         constraint_row.conislocal,
         constraint_row.coninhcount,
         constraint_row.conparentid,
         COALESCE((to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN, TRUE)
       INTO
         actual_constraint_oid,
         actual_constraint_type,
         actual_constraint_expression,
         actual_constraint_no_inherit,
         actual_constraint_is_local,
         actual_constraint_inheritance_count,
         actual_constraint_parent,
         actual_constraint_enforced
       FROM pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_name::regclass
         AND constraint_row.conname = target.constraint_name;

       IF EXISTS (
         SELECT 1
         FROM pg_constraint AS constraint_row
         WHERE constraint_row.conrelid = target.table_name::regclass
           AND constraint_row.conname = expected_constraint_name
       ) THEN
         RAISE EXCEPTION '% is a reserved constraint verifier name', expected_constraint_name
           USING ERRCODE = '42804';
       END IF;

       IF actual_constraint_oid IS NULL THEN
         EXECUTE format(
           'ALTER TABLE %I ADD CONSTRAINT %I CHECK (universe_id ~ %L) NOT VALID',
           target.table_name,
           target.constraint_name,
           '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
         );
       ELSE
         EXECUTE format(
           'ALTER TABLE %I ADD CONSTRAINT %I CHECK (universe_id ~ %L) NOT VALID',
           target.table_name,
           expected_constraint_name,
           '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
         );

         SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)
         INTO expected_constraint_expression
         FROM pg_constraint AS constraint_row
         WHERE constraint_row.conrelid = target.table_name::regclass
           AND constraint_row.conname = expected_constraint_name;

         EXECUTE format(
           'ALTER TABLE %I DROP CONSTRAINT %I',
           target.table_name,
           expected_constraint_name
         );

         IF actual_constraint_type <> 'c'
           OR actual_constraint_expression IS DISTINCT FROM expected_constraint_expression
           OR actual_constraint_no_inherit
           OR NOT actual_constraint_is_local
           OR actual_constraint_inheritance_count <> 0
           OR actual_constraint_parent <> 0
           OR NOT actual_constraint_enforced
         THEN
           RAISE EXCEPTION '% has an unexpected definition', target.constraint_name
             USING ERRCODE = '42804';
         END IF;
       END IF;

       EXECUTE format(
         'ALTER TABLE %I VALIDATE CONSTRAINT %I',
         target.table_name,
         target.constraint_name
       );
     END LOOP;
   END
   $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'backstage_wrestlers'::regclass
         AND conname = 'uq_backstage_wrestlers_universe_name'
     ) THEN
       ALTER TABLE backstage_wrestlers
         ADD CONSTRAINT uq_backstage_wrestlers_universe_name
         UNIQUE (universe_id, name);
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'backstage_storylines'::regclass
         AND conname = 'uq_backstage_storylines_universe_story_key'
     ) THEN
       ALTER TABLE backstage_storylines
         ADD CONSTRAINT uq_backstage_storylines_universe_story_key
         UNIQUE (universe_id, story_key);
     END IF;
   END
   $$`,

  // Backstage Booker Phase 2A canon/storyline model. These tables are
  // additive and deliberately do not reinterpret legacy prose or retained
  // story-beat rows.
  `DO $$
   DECLARE
     existing_type "char";
     existing_definition TEXT;
   BEGIN
     SELECT constraint_row.contype, pg_get_constraintdef(constraint_row.oid, false)
       INTO existing_type, existing_definition
       FROM pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'backstage_events'::regclass
         AND constraint_row.conname = 'uq_backstage_events_universe_id';

     IF existing_definition IS NULL THEN
       RAISE EXCEPTION
         'uq_backstage_events_universe_id is missing; apply 20260814_backstage_canon_storyline_v1.sql before starting this runtime against an existing database'
         USING ERRCODE = '55000';
     ELSIF existing_type <> 'u'
       OR regexp_replace(existing_definition, '[[:space:]]+', '', 'g')
         <> 'UNIQUE(universe_id,id)' THEN
       RAISE EXCEPTION
         'uq_backstage_events_universe_id has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,

  `CREATE TABLE IF NOT EXISTS backstage_canon_heads (
    universe_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_backstage_canon_heads_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT ck_backstage_canon_heads_revision
      CHECK (revision >= 0)
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_canon_revisions (
    universe_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    mutation_id UUID NOT NULL,
    operation TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_canon_revisions
      PRIMARY KEY (universe_id, revision),
    CONSTRAINT uq_backstage_canon_revisions_mutation
      UNIQUE (universe_id, mutation_id),
    CONSTRAINT fk_backstage_canon_revisions_head
      FOREIGN KEY (universe_id)
      REFERENCES backstage_canon_heads(universe_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT ck_backstage_canon_revisions_revision
      CHECK (revision > 0),
    CONSTRAINT ck_backstage_canon_revisions_operation
      CHECK (operation IN ('upsertStoryline', 'appendCanonBeat')),
    CONSTRAINT ck_backstage_canon_revisions_fingerprint
      CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_canon_revisions_result
      CHECK (
        jsonb_typeof(result) = 'object'
        AND octet_length(convert_to(result::TEXT, 'UTF8')) <= 262144
      )
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_storyline_threads (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    universe_id TEXT NOT NULL,
    story_key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_revision BIGINT NOT NULL,
    updated_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT uq_backstage_storyline_threads_universe_id
      UNIQUE (universe_id, id),
    CONSTRAINT uq_backstage_storyline_threads_universe_key
      UNIQUE (universe_id, story_key),
    CONSTRAINT fk_backstage_storyline_threads_head
      FOREIGN KEY (universe_id)
      REFERENCES backstage_canon_heads(universe_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_threads_created_revision
      FOREIGN KEY (universe_id, created_revision)
      REFERENCES backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_backstage_storyline_threads_updated_revision
      FOREIGN KEY (universe_id, updated_revision)
      REFERENCES backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_threads_story_key
      CHECK (char_length(btrim(story_key)) BETWEEN 1 AND 240),
    CONSTRAINT ck_backstage_storyline_threads_title
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
    CONSTRAINT ck_backstage_storyline_threads_summary
      CHECK (summary IS NULL OR char_length(summary) <= 10000),
    CONSTRAINT ck_backstage_storyline_threads_status
      CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
    CONSTRAINT ck_backstage_storyline_threads_version
      CHECK (version > 0),
    CONSTRAINT ck_backstage_storyline_threads_revisions
      CHECK (created_revision > 0 AND updated_revision >= created_revision),
    CONSTRAINT ck_backstage_storyline_threads_closed_at
      CHECK (
        (status IN ('completed', 'cancelled') AND closed_at IS NOT NULL)
        OR (status IN ('draft', 'active', 'paused') AND closed_at IS NULL)
      )
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_storyline_participants (
    universe_id TEXT NOT NULL,
    storyline_id UUID NOT NULL,
    wrestler_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_storyline_participants
      PRIMARY KEY (universe_id, storyline_id, wrestler_name),
    CONSTRAINT uq_backstage_storyline_participants_order
      UNIQUE (universe_id, storyline_id, sort_order)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_backstage_storyline_participants_thread
      FOREIGN KEY (universe_id, storyline_id)
      REFERENCES backstage_storyline_threads(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_participants_wrestler
      FOREIGN KEY (universe_id, wrestler_name)
      REFERENCES backstage_wrestlers(universe_id, name)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_participants_revision
      FOREIGN KEY (universe_id, created_revision)
      REFERENCES backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_participants_name
      CHECK (char_length(btrim(wrestler_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_backstage_storyline_participants_sort_order
      CHECK (sort_order >= 0)
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_storyline_canon_beats (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    universe_id TEXT NOT NULL,
    storyline_id UUID NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    participant_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_id UUID,
    supersedes_beat_id UUID,
    universe_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_backstage_storyline_canon_beats_universe_id
      UNIQUE (universe_id, id),
    CONSTRAINT uq_backstage_storyline_canon_beats_thread_id
      UNIQUE (universe_id, storyline_id, id),
    CONSTRAINT uq_backstage_storyline_canon_beats_sequence
      UNIQUE (universe_id, storyline_id, sequence),
    CONSTRAINT uq_backstage_storyline_canon_beats_replacement
      UNIQUE (universe_id, supersedes_beat_id),
    CONSTRAINT fk_backstage_storyline_canon_beats_thread
      FOREIGN KEY (universe_id, storyline_id)
      REFERENCES backstage_storyline_threads(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_event
      FOREIGN KEY (universe_id, event_id)
      REFERENCES backstage_events(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_supersedes
      FOREIGN KEY (universe_id, storyline_id, supersedes_beat_id)
      REFERENCES backstage_storyline_canon_beats(universe_id, storyline_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_revision
      FOREIGN KEY (universe_id, universe_revision)
      REFERENCES backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_canon_beats_sequence
      CHECK (sequence > 0),
    CONSTRAINT ck_backstage_storyline_canon_beats_kind
      CHECK (char_length(btrim(kind)) BETWEEN 1 AND 64),
    CONSTRAINT ck_backstage_storyline_canon_beats_summary
      CHECK (char_length(btrim(summary)) BETWEEN 1 AND 10000),
    CONSTRAINT ck_backstage_storyline_canon_beats_occurred_at
      CHECK (isfinite(occurred_at)),
    CONSTRAINT ck_backstage_storyline_canon_beats_participants
      CHECK (
        jsonb_typeof(participant_names) = 'array'
        AND jsonb_array_length(participant_names) <= 50
        AND octet_length(convert_to(participant_names::TEXT, 'UTF8')) <= 16384
      ),
    CONSTRAINT ck_backstage_storyline_canon_beats_not_self_superseding
      CHECK (supersedes_beat_id IS NULL OR supersedes_beat_id <> id),
    CONSTRAINT ck_backstage_storyline_canon_beats_revision
      CHECK (universe_revision > 0)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_backstage_storyline_threads_universe_status_updated
    ON backstage_storyline_threads(universe_id, status, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_storyline_participants_wrestler
    ON backstage_storyline_participants(universe_id, wrestler_name, storyline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_storyline_canon_beats_active_context
    ON backstage_storyline_canon_beats(universe_id, occurred_at DESC, sequence DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_canon_revisions_created
    ON backstage_canon_revisions(universe_id, created_at DESC, revision DESC)`,

  `-- CREATE ... IF NOT EXISTS is intentionally paired with an exact catalog
-- verifier. Startup may have installed this schema before the migration runs;
-- a same-named but structurally different object must fail closed instead of
-- being silently adopted.
DO $$
DECLARE
  table_pair RECORD;
  index_pair RECORD;
  expected_constraint RECORD;
  actual_constraint RECORD;
  actual_table_oid OID;
  expected_table_oid OID;
  expected_reference_oid OID;
  actual_index_oid OID;
  expected_index_oid OID;
  actual_columns JSONB;
  expected_columns JSONB;
  actual_constraint_names TEXT[];
  expected_constraint_names TEXT[];
  actual_index_signature JSONB;
  expected_index_signature JSONB;
  expected_reference_name TEXT;
  actual_table_kind "char";
  actual_table_persistence "char";
  actual_table_is_partition BOOLEAN;
  actual_table_row_security BOOLEAN;
  actual_table_force_row_security BOOLEAN;
BEGIN
  CREATE TEMP TABLE p2_expected_backstage_events (
    id UUID NOT NULL,
    universe_id TEXT NOT NULL,
    CONSTRAINT uq_backstage_events_universe_id
      UNIQUE (universe_id, id)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_wrestlers (
    id INTEGER NOT NULL,
    universe_id TEXT NOT NULL,
    name TEXT NOT NULL,
    CONSTRAINT uq_backstage_wrestlers_universe_name
      UNIQUE (universe_id, name)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_canon_heads (
    universe_id TEXT,
    revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT backstage_canon_heads_pkey
      PRIMARY KEY (universe_id),
    CONSTRAINT ck_backstage_canon_heads_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT ck_backstage_canon_heads_revision
      CHECK (revision >= 0)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_canon_revisions (
    universe_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    mutation_id UUID NOT NULL,
    operation TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_canon_revisions
      PRIMARY KEY (universe_id, revision),
    CONSTRAINT uq_backstage_canon_revisions_mutation
      UNIQUE (universe_id, mutation_id),
    CONSTRAINT fk_backstage_canon_revisions_head
      FOREIGN KEY (universe_id)
      REFERENCES p2_expected_backstage_canon_heads(universe_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT ck_backstage_canon_revisions_revision
      CHECK (revision > 0),
    CONSTRAINT ck_backstage_canon_revisions_operation
      CHECK (operation IN ('upsertStoryline', 'appendCanonBeat')),
    CONSTRAINT ck_backstage_canon_revisions_fingerprint
      CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_canon_revisions_result
      CHECK (
        jsonb_typeof(result) = 'object'
        AND octet_length(convert_to(result::TEXT, 'UTF8')) <= 262144
      )
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_storyline_threads (
    id UUID DEFAULT pg_catalog.gen_random_uuid(),
    universe_id TEXT NOT NULL,
    story_key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_revision BIGINT NOT NULL,
    updated_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT backstage_storyline_threads_pkey
      PRIMARY KEY (id),
    CONSTRAINT uq_backstage_storyline_threads_universe_id
      UNIQUE (universe_id, id),
    CONSTRAINT uq_backstage_storyline_threads_universe_key
      UNIQUE (universe_id, story_key),
    CONSTRAINT fk_backstage_storyline_threads_head
      FOREIGN KEY (universe_id)
      REFERENCES p2_expected_backstage_canon_heads(universe_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_threads_created_revision
      FOREIGN KEY (universe_id, created_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_backstage_storyline_threads_updated_revision
      FOREIGN KEY (universe_id, updated_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_threads_story_key
      CHECK (char_length(btrim(story_key)) BETWEEN 1 AND 240),
    CONSTRAINT ck_backstage_storyline_threads_title
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
    CONSTRAINT ck_backstage_storyline_threads_summary
      CHECK (summary IS NULL OR char_length(summary) <= 10000),
    CONSTRAINT ck_backstage_storyline_threads_status
      CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
    CONSTRAINT ck_backstage_storyline_threads_version
      CHECK (version > 0),
    CONSTRAINT ck_backstage_storyline_threads_revisions
      CHECK (created_revision > 0 AND updated_revision >= created_revision),
    CONSTRAINT ck_backstage_storyline_threads_closed_at
      CHECK (
        (status IN ('completed', 'cancelled') AND closed_at IS NOT NULL)
        OR (status IN ('draft', 'active', 'paused') AND closed_at IS NULL)
      )
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_storyline_participants (
    universe_id TEXT NOT NULL,
    storyline_id UUID NOT NULL,
    wrestler_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_storyline_participants
      PRIMARY KEY (universe_id, storyline_id, wrestler_name),
    CONSTRAINT uq_backstage_storyline_participants_order
      UNIQUE (universe_id, storyline_id, sort_order)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_backstage_storyline_participants_thread
      FOREIGN KEY (universe_id, storyline_id)
      REFERENCES p2_expected_backstage_storyline_threads(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_participants_wrestler
      FOREIGN KEY (universe_id, wrestler_name)
      REFERENCES p2_expected_backstage_wrestlers(universe_id, name)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_participants_revision
      FOREIGN KEY (universe_id, created_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_participants_name
      CHECK (char_length(btrim(wrestler_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_backstage_storyline_participants_sort_order
      CHECK (sort_order >= 0)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_storyline_canon_beats (
    id UUID DEFAULT pg_catalog.gen_random_uuid(),
    universe_id TEXT NOT NULL,
    storyline_id UUID NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    participant_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_id UUID,
    supersedes_beat_id UUID,
    universe_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT backstage_storyline_canon_beats_pkey
      PRIMARY KEY (id),
    CONSTRAINT uq_backstage_storyline_canon_beats_universe_id
      UNIQUE (universe_id, id),
    CONSTRAINT uq_backstage_storyline_canon_beats_thread_id
      UNIQUE (universe_id, storyline_id, id),
    CONSTRAINT uq_backstage_storyline_canon_beats_sequence
      UNIQUE (universe_id, storyline_id, sequence),
    CONSTRAINT uq_backstage_storyline_canon_beats_replacement
      UNIQUE (universe_id, supersedes_beat_id),
    CONSTRAINT fk_backstage_storyline_canon_beats_thread
      FOREIGN KEY (universe_id, storyline_id)
      REFERENCES p2_expected_backstage_storyline_threads(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_event
      FOREIGN KEY (universe_id, event_id)
      REFERENCES p2_expected_backstage_events(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_supersedes
      FOREIGN KEY (universe_id, storyline_id, supersedes_beat_id)
      REFERENCES p2_expected_backstage_storyline_canon_beats(
        universe_id,
        storyline_id,
        id
      )
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_revision
      FOREIGN KEY (universe_id, universe_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_canon_beats_sequence
      CHECK (sequence > 0),
    CONSTRAINT ck_backstage_storyline_canon_beats_kind
      CHECK (char_length(btrim(kind)) BETWEEN 1 AND 64),
    CONSTRAINT ck_backstage_storyline_canon_beats_summary
      CHECK (char_length(btrim(summary)) BETWEEN 1 AND 10000),
    CONSTRAINT ck_backstage_storyline_canon_beats_occurred_at
      CHECK (isfinite(occurred_at)),
    CONSTRAINT ck_backstage_storyline_canon_beats_participants
      CHECK (
        jsonb_typeof(participant_names) = 'array'
        AND jsonb_array_length(participant_names) <= 50
        AND octet_length(convert_to(participant_names::TEXT, 'UTF8')) <= 16384
      ),
    CONSTRAINT ck_backstage_storyline_canon_beats_not_self_superseding
      CHECK (supersedes_beat_id IS NULL OR supersedes_beat_id <> id),
    CONSTRAINT ck_backstage_storyline_canon_beats_revision
      CHECK (universe_revision > 0)
  ) ON COMMIT DROP;

  CREATE INDEX idx_backstage_storyline_threads_universe_status_updated
    ON p2_expected_backstage_storyline_threads(
      universe_id,
      status,
      updated_at DESC,
      id
    );
  CREATE INDEX idx_backstage_storyline_participants_wrestler
    ON p2_expected_backstage_storyline_participants(
      universe_id,
      wrestler_name,
      storyline_id
    );
  CREATE INDEX idx_backstage_storyline_canon_beats_active_context
    ON p2_expected_backstage_storyline_canon_beats(
      universe_id,
      occurred_at DESC,
      sequence DESC,
      id
    );
  CREATE INDEX idx_backstage_canon_revisions_created
    ON p2_expected_backstage_canon_revisions(
      universe_id,
      created_at DESC,
      revision DESC
    );

  FOR table_pair IN
    SELECT *
    FROM (VALUES
      ('backstage_canon_heads', 'p2_expected_backstage_canon_heads'),
      ('backstage_canon_revisions', 'p2_expected_backstage_canon_revisions'),
      ('backstage_storyline_threads', 'p2_expected_backstage_storyline_threads'),
      ('backstage_storyline_participants', 'p2_expected_backstage_storyline_participants'),
      ('backstage_storyline_canon_beats', 'p2_expected_backstage_storyline_canon_beats')
    ) AS expected_tables(actual_name, expected_name)
  LOOP
    actual_table_oid := to_regclass(table_pair.actual_name);
    expected_table_oid := to_regclass('pg_temp.' || table_pair.expected_name);

    SELECT
      relkind,
      relpersistence,
      relispartition,
      relrowsecurity,
      relforcerowsecurity
      INTO
        actual_table_kind,
        actual_table_persistence,
        actual_table_is_partition,
        actual_table_row_security,
        actual_table_force_row_security
      FROM pg_class
      WHERE oid = actual_table_oid;
    IF actual_table_oid IS NULL
      OR expected_table_oid IS NULL
      OR actual_table_kind <> 'r'
      OR actual_table_persistence <> 'p'
      OR actual_table_is_partition
      OR actual_table_row_security
      OR actual_table_force_row_security
    THEN
      RAISE EXCEPTION '% is not an ordinary unfiltered permanent table', table_pair.actual_name
        USING ERRCODE = '42804';
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_array(
          attribute.attnum,
          attribute.attname,
          attribute.atttypid::TEXT,
          attribute.atttypmod,
          attribute.attndims,
          attribute.attnotnull,
          attribute.attidentity::TEXT,
          attribute.attgenerated::TEXT,
          attribute.attcollation::TEXT,
          attribute.attislocal,
          attribute.attinhcount,
          attribute.atthasmissing,
          to_jsonb(attribute.attmissingval),
          pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false),
          attribute.attstorage::TEXT,
          COALESCE(to_jsonb(attribute) ->> 'attcompression', '')
        )
        ORDER BY attribute.attnum
      ),
      '[]'::JSONB
    )
      INTO actual_columns
      FROM pg_attribute AS attribute
      LEFT JOIN pg_attrdef AS attribute_default
        ON attribute_default.adrelid = attribute.attrelid
       AND attribute_default.adnum = attribute.attnum
      WHERE attribute.attrelid = actual_table_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_array(
          attribute.attnum,
          attribute.attname,
          attribute.atttypid::TEXT,
          attribute.atttypmod,
          attribute.attndims,
          attribute.attnotnull,
          attribute.attidentity::TEXT,
          attribute.attgenerated::TEXT,
          attribute.attcollation::TEXT,
          attribute.attislocal,
          attribute.attinhcount,
          attribute.atthasmissing,
          to_jsonb(attribute.attmissingval),
          pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false),
          attribute.attstorage::TEXT,
          COALESCE(to_jsonb(attribute) ->> 'attcompression', '')
        )
        ORDER BY attribute.attnum
      ),
      '[]'::JSONB
    )
      INTO expected_columns
      FROM pg_attribute AS attribute
      LEFT JOIN pg_attrdef AS attribute_default
        ON attribute_default.adrelid = attribute.attrelid
       AND attribute_default.adnum = attribute.attnum
      WHERE attribute.attrelid = expected_table_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped;

    IF actual_columns IS DISTINCT FROM expected_columns THEN
      RAISE EXCEPTION '% has unexpected columns', table_pair.actual_name
        USING ERRCODE = '42804';
    END IF;

    SELECT COALESCE(array_agg(conname ORDER BY conname), ARRAY[]::TEXT[])
      INTO actual_constraint_names
      FROM pg_constraint
      WHERE conrelid = actual_table_oid
        AND contype <> 'n';
    SELECT COALESCE(array_agg(conname ORDER BY conname), ARRAY[]::TEXT[])
      INTO expected_constraint_names
      FROM pg_constraint
      WHERE conrelid = expected_table_oid
        AND contype <> 'n';

    IF actual_constraint_names IS DISTINCT FROM expected_constraint_names THEN
      RAISE EXCEPTION '% has unexpected constraints', table_pair.actual_name
        USING ERRCODE = '42804';
    END IF;

    FOR expected_constraint IN
      SELECT
        constraint_row.*,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS constraint_columns,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS referenced_columns,
        pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          false
        ) AS constraint_expression,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN,
          TRUE
        ) AS constraint_enforced,
        to_jsonb(constraint_row) -> 'confdelsetcols'
          AS constraint_delete_set_columns,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conperiod')::BOOLEAN,
          FALSE
        ) AS constraint_period
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = expected_table_oid
        AND constraint_row.contype <> 'n'
      ORDER BY constraint_row.conname
    LOOP
      SELECT
        constraint_row.*,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS constraint_columns,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS referenced_columns,
        pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          false
        ) AS constraint_expression,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN,
          TRUE
        ) AS constraint_enforced,
        to_jsonb(constraint_row) -> 'confdelsetcols'
          AS constraint_delete_set_columns,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conperiod')::BOOLEAN,
          FALSE
        ) AS constraint_period
        INTO actual_constraint
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = actual_table_oid
          AND constraint_row.conname = expected_constraint.conname;

      IF NOT FOUND
        OR actual_constraint.contype IS DISTINCT FROM expected_constraint.contype
        OR actual_constraint.constraint_columns
          IS DISTINCT FROM expected_constraint.constraint_columns
        OR actual_constraint.referenced_columns
          IS DISTINCT FROM expected_constraint.referenced_columns
        OR actual_constraint.confupdtype IS DISTINCT FROM expected_constraint.confupdtype
        OR actual_constraint.confdeltype IS DISTINCT FROM expected_constraint.confdeltype
        OR actual_constraint.confmatchtype IS DISTINCT FROM expected_constraint.confmatchtype
        OR actual_constraint.conislocal IS DISTINCT FROM expected_constraint.conislocal
        OR actual_constraint.coninhcount IS DISTINCT FROM expected_constraint.coninhcount
        OR actual_constraint.connoinherit IS DISTINCT FROM expected_constraint.connoinherit
        OR actual_constraint.condeferrable IS DISTINCT FROM expected_constraint.condeferrable
        OR actual_constraint.condeferred IS DISTINCT FROM expected_constraint.condeferred
        OR actual_constraint.convalidated IS DISTINCT FROM expected_constraint.convalidated
        OR actual_constraint.conparentid IS DISTINCT FROM expected_constraint.conparentid
        OR actual_constraint.conpfeqop IS DISTINCT FROM expected_constraint.conpfeqop
        OR actual_constraint.conppeqop IS DISTINCT FROM expected_constraint.conppeqop
        OR actual_constraint.conffeqop IS DISTINCT FROM expected_constraint.conffeqop
        OR actual_constraint.conexclop IS DISTINCT FROM expected_constraint.conexclop
        OR actual_constraint.constraint_expression
          IS DISTINCT FROM expected_constraint.constraint_expression
        OR actual_constraint.constraint_enforced
          IS DISTINCT FROM expected_constraint.constraint_enforced
        OR actual_constraint.constraint_delete_set_columns
          IS DISTINCT FROM expected_constraint.constraint_delete_set_columns
        OR actual_constraint.constraint_period
          IS DISTINCT FROM expected_constraint.constraint_period
      THEN
        RAISE EXCEPTION '% has an unexpected definition', expected_constraint.conname
          USING ERRCODE = '42804';
      END IF;

      IF expected_constraint.contype = 'f' THEN
        SELECT regexp_replace(referenced.relname, '^p2_expected_', '')
          INTO expected_reference_name
          FROM pg_class AS referenced
          WHERE referenced.oid = expected_constraint.confrelid;
        expected_reference_oid := to_regclass(expected_reference_name);
        IF expected_reference_oid IS NULL
          OR actual_constraint.confrelid IS DISTINCT FROM expected_reference_oid
        THEN
          RAISE EXCEPTION '% references an unexpected table', expected_constraint.conname
            USING ERRCODE = '42804';
        END IF;
      END IF;

      IF expected_constraint.contype IN ('p', 'u') THEN
        SELECT jsonb_build_object(
          'access_method', index_class.relam::TEXT,
          'reloptions', to_jsonb(index_class.reloptions),
          'unique', index_row.indisunique,
          'primary', index_row.indisprimary,
          'exclusion', index_row.indisexclusion,
          'immediate', index_row.indimmediate,
          'valid', index_row.indisvalid,
          'ready', index_row.indisready,
          'live', index_row.indislive,
          'nulls_not_distinct', COALESCE(
            (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
            FALSE
          ),
          'attribute_count', index_row.indnatts,
          'key_attribute_count', index_row.indnkeyatts,
          'key', index_row.indkey::TEXT,
          'collation', index_row.indcollation::TEXT,
          'operator_class', index_row.indclass::TEXT,
          'options', index_row.indoption::TEXT,
          'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
          'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
        )
          INTO actual_index_signature
          FROM pg_index AS index_row
          INNER JOIN pg_class AS index_class
            ON index_class.oid = index_row.indexrelid
          WHERE index_row.indexrelid = actual_constraint.conindid;

        SELECT jsonb_build_object(
          'access_method', index_class.relam::TEXT,
          'reloptions', to_jsonb(index_class.reloptions),
          'unique', index_row.indisunique,
          'primary', index_row.indisprimary,
          'exclusion', index_row.indisexclusion,
          'immediate', index_row.indimmediate,
          'valid', index_row.indisvalid,
          'ready', index_row.indisready,
          'live', index_row.indislive,
          'nulls_not_distinct', COALESCE(
            (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
            FALSE
          ),
          'attribute_count', index_row.indnatts,
          'key_attribute_count', index_row.indnkeyatts,
          'key', index_row.indkey::TEXT,
          'collation', index_row.indcollation::TEXT,
          'operator_class', index_row.indclass::TEXT,
          'options', index_row.indoption::TEXT,
          'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
          'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
        )
          INTO expected_index_signature
          FROM pg_index AS index_row
          INNER JOIN pg_class AS index_class
            ON index_class.oid = index_row.indexrelid
          WHERE index_row.indexrelid = expected_constraint.conindid;

        IF actual_index_signature IS DISTINCT FROM expected_index_signature THEN
          RAISE EXCEPTION '% has an unexpected backing index', expected_constraint.conname
            USING ERRCODE = '42804';
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  FOR index_pair IN
    SELECT *
    FROM (VALUES
      (
        'backstage_storyline_threads',
        'p2_expected_backstage_storyline_threads',
        'idx_backstage_storyline_threads_universe_status_updated'
      ),
      (
        'backstage_storyline_participants',
        'p2_expected_backstage_storyline_participants',
        'idx_backstage_storyline_participants_wrestler'
      ),
      (
        'backstage_storyline_canon_beats',
        'p2_expected_backstage_storyline_canon_beats',
        'idx_backstage_storyline_canon_beats_active_context'
      ),
      (
        'backstage_canon_revisions',
        'p2_expected_backstage_canon_revisions',
        'idx_backstage_canon_revisions_created'
      )
    ) AS expected_indexes(actual_table, expected_table, index_name)
  LOOP
    actual_table_oid := to_regclass(index_pair.actual_table);
    expected_table_oid := to_regclass('pg_temp.' || index_pair.expected_table);

    SELECT index_class.oid
      INTO actual_index_oid
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indrelid = actual_table_oid
        AND index_class.relname = index_pair.index_name;
    SELECT index_class.oid
      INTO expected_index_oid
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indrelid = expected_table_oid
        AND index_class.relname = index_pair.index_name;

    IF actual_index_oid IS NULL OR expected_index_oid IS NULL THEN
      RAISE EXCEPTION '% is missing', index_pair.index_name
        USING ERRCODE = '42804';
    END IF;

    SELECT jsonb_build_object(
      'access_method', index_class.relam::TEXT,
      'reloptions', to_jsonb(index_class.reloptions),
      'unique', index_row.indisunique,
      'primary', index_row.indisprimary,
      'exclusion', index_row.indisexclusion,
      'immediate', index_row.indimmediate,
      'valid', index_row.indisvalid,
      'ready', index_row.indisready,
      'live', index_row.indislive,
      'nulls_not_distinct', COALESCE(
        (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
        FALSE
      ),
      'attribute_count', index_row.indnatts,
      'key_attribute_count', index_row.indnkeyatts,
      'key', index_row.indkey::TEXT,
      'collation', index_row.indcollation::TEXT,
      'operator_class', index_row.indclass::TEXT,
      'options', index_row.indoption::TEXT,
      'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
      'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
    )
      INTO actual_index_signature
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indexrelid = actual_index_oid;

    SELECT jsonb_build_object(
      'access_method', index_class.relam::TEXT,
      'reloptions', to_jsonb(index_class.reloptions),
      'unique', index_row.indisunique,
      'primary', index_row.indisprimary,
      'exclusion', index_row.indisexclusion,
      'immediate', index_row.indimmediate,
      'valid', index_row.indisvalid,
      'ready', index_row.indisready,
      'live', index_row.indislive,
      'nulls_not_distinct', COALESCE(
        (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
        FALSE
      ),
      'attribute_count', index_row.indnatts,
      'key_attribute_count', index_row.indnkeyatts,
      'key', index_row.indkey::TEXT,
      'collation', index_row.indcollation::TEXT,
      'operator_class', index_row.indclass::TEXT,
      'options', index_row.indoption::TEXT,
      'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
      'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
    )
      INTO expected_index_signature
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indexrelid = expected_index_oid;

    IF actual_index_signature IS DISTINCT FROM expected_index_signature THEN
      RAISE EXCEPTION '% has an unexpected definition', index_pair.index_name
        USING ERRCODE = '42804';
    END IF;
  END LOOP;

  DROP TABLE p2_expected_backstage_storyline_canon_beats;
  DROP TABLE p2_expected_backstage_storyline_participants;
  DROP TABLE p2_expected_backstage_storyline_threads;
  DROP TABLE p2_expected_backstage_canon_revisions;
  DROP TABLE p2_expected_backstage_canon_heads;
  DROP TABLE p2_expected_backstage_events;
  DROP TABLE p2_expected_backstage_wrestlers;
END
$$;`,

  `INSERT INTO backstage_canon_heads (universe_id)
   SELECT universe_id FROM backstage_wrestlers
   UNION
   SELECT universe_id FROM backstage_events
   UNION
   SELECT universe_id FROM backstage_storylines
   UNION
   SELECT universe_id FROM backstage_story_beats
   UNION
   SELECT 'legacy'
   ON CONFLICT (universe_id) DO NOTHING`,

  // Self-reflection storage for AI analysis history
  `CREATE TABLE IF NOT EXISTS self_reflections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    priority TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    improvements JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  
  // Execution logs table for worker logs
  `CREATE TABLE IF NOT EXISTS execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id VARCHAR(255) NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    level VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'
  )`,
  
  // Job data table for worker job tracking
  `CREATE TABLE IF NOT EXISTS job_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id VARCHAR(255) NOT NULL,
    job_type VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    claim_generation BIGINT NOT NULL DEFAULT 0,
    input JSONB NOT NULL,
    output JSONB,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    priority INTEGER NOT NULL DEFAULT 100,
    last_worker_id VARCHAR(255),
    stats_worker_id VARCHAR(255) COLLATE "C",
    correlation_id TEXT,
    autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_fingerprint_hash TEXT,
    idempotency_key_hash TEXT,
    idempotency_scope_hash TEXT,
    idempotency_origin VARCHAR(32),
    idempotency_until TIMESTAMPTZ,
    retention_until TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    cancel_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS claim_generation BIGINT`,
  `DO $$
   DECLARE
     claim_generation_type OID;
   BEGIN
     SELECT atttypid
     INTO claim_generation_type
     FROM pg_attribute
     WHERE attrelid = 'job_data'::regclass
       AND attname = 'claim_generation'
       AND NOT attisdropped;

     IF claim_generation_type IS DISTINCT FROM 'bigint'::regtype THEN
       RAISE EXCEPTION
         'job_data.claim_generation must have PostgreSQL BIGINT type'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,
  `UPDATE job_data SET claim_generation = 0 WHERE claim_generation IS NULL`,
  `ALTER TABLE job_data ALTER COLUMN claim_generation SET DEFAULT 0`,
  `ALTER TABLE job_data ALTER COLUMN claim_generation SET NOT NULL`,
  `DO $$
   DECLARE
     constraint_type "char";
     constraint_definition TEXT;
   BEGIN
     SELECT contype, pg_get_constraintdef(oid, false)
     INTO constraint_type, constraint_definition
       FROM pg_constraint
       WHERE conrelid = 'job_data'::regclass
         AND conname = 'job_data_claim_generation_nonnegative';

     IF constraint_definition IS NULL THEN
       ALTER TABLE job_data
         ADD CONSTRAINT job_data_claim_generation_nonnegative
         CHECK (claim_generation >= 0) NOT VALID;
     ELSIF constraint_type <> 'c'
       OR regexp_replace(
         constraint_definition,
         '[[:space:]]+',
         '',
         'g'
       ) NOT IN (
         'CHECK((claim_generation>=0))',
         'CHECK((claim_generation>=0))NOTVALID'
       ) THEN
       RAISE EXCEPTION
         'job_data_claim_generation_nonnegative has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,
  `ALTER TABLE job_data
     VALIDATE CONSTRAINT job_data_claim_generation_nonnegative`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 2`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS last_worker_id VARCHAR(255)`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS stats_worker_id VARCHAR(255) COLLATE "C"`,
  `DO $$
   DECLARE
     column_type OID;
     column_type_modifier INTEGER;
     column_collation OID;
     column_not_null BOOLEAN;
     column_generated "char";
     column_identity "char";
     column_has_default BOOLEAN;
   BEGIN
     SELECT atttypid, atttypmod, attcollation, attnotnull,
            attgenerated, attidentity, atthasdef
     INTO column_type, column_type_modifier, column_collation, column_not_null,
          column_generated, column_identity, column_has_default
     FROM pg_attribute
     WHERE attrelid = 'job_data'::regclass
       AND attname = 'stats_worker_id'
       AND NOT attisdropped;

     IF column_type IS DISTINCT FROM 'varchar'::regtype
       OR column_type_modifier IS DISTINCT FROM 259
       OR column_collation IS DISTINCT FROM '"C"'::regcollation
       OR column_not_null IS DISTINCT FROM FALSE
       OR column_generated IS DISTINCT FROM ''::"char"
       OR column_identity IS DISTINCT FROM ''::"char"
       OR column_has_default IS DISTINCT FROM FALSE THEN
       RAISE EXCEPTION
         'job_data.stats_worker_id must be a plain writable nullable VARCHAR(255) COLLATE "C" without a default'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS correlation_id TEXT`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS request_fingerprint_hash TEXT`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS idempotency_key_hash TEXT`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS idempotency_scope_hash TEXT`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS idempotency_origin VARCHAR(32)`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS idempotency_until TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,

  // Append-only operational timeline for queue and worker visibility
  `CREATE TABLE IF NOT EXISTS job_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL,
    trace_id TEXT,
    event_type TEXT NOT NULL,
    worker_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,

  // DAG verification snapshot storage for cross-instance orchestration inspection
  `CREATE TABLE IF NOT EXISTS dag_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    template TEXT NOT NULL,
    status VARCHAR(50) NOT NULL,
    planner_node_id TEXT,
    root_node_id TEXT,
    snapshot_generation BIGINT NOT NULL DEFAULT 0,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `ALTER TABLE dag_runs ADD COLUMN IF NOT EXISTS snapshot_generation BIGINT`,
  `DO $$
   DECLARE
     snapshot_generation_type OID;
   BEGIN
     SELECT atttypid
     INTO snapshot_generation_type
     FROM pg_attribute
     WHERE attrelid = 'dag_runs'::regclass
       AND attname = 'snapshot_generation'
       AND NOT attisdropped;

     IF snapshot_generation_type IS DISTINCT FROM 'bigint'::regtype THEN
       RAISE EXCEPTION
         'dag_runs.snapshot_generation must have PostgreSQL BIGINT type'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,
  `UPDATE dag_runs SET snapshot_generation = 0 WHERE snapshot_generation IS NULL`,
  `ALTER TABLE dag_runs ALTER COLUMN snapshot_generation SET DEFAULT 0`,
  `ALTER TABLE dag_runs ALTER COLUMN snapshot_generation SET NOT NULL`,
  `DO $$
   DECLARE
     constraint_type "char";
     constraint_definition TEXT;
   BEGIN
     SELECT contype, pg_get_constraintdef(oid, false)
     INTO constraint_type, constraint_definition
       FROM pg_constraint
       WHERE conrelid = 'dag_runs'::regclass
         AND conname = 'dag_runs_snapshot_generation_nonnegative';

     IF constraint_definition IS NULL THEN
       ALTER TABLE dag_runs
         ADD CONSTRAINT dag_runs_snapshot_generation_nonnegative
         CHECK (snapshot_generation >= 0) NOT VALID;
     ELSIF constraint_type <> 'c'
       OR regexp_replace(
         constraint_definition,
         '[[:space:]]+',
         '',
         'g'
       ) NOT IN (
         'CHECK((snapshot_generation>=0))',
         'CHECK((snapshot_generation>=0))NOTVALID'
       ) THEN
       RAISE EXCEPTION
         'dag_runs_snapshot_generation_nonnegative has an unexpected definition'
         USING ERRCODE = '42804';
     END IF;
   END
   $$`,
  `ALTER TABLE dag_runs
     VALIDATE CONSTRAINT dag_runs_snapshot_generation_nonnegative`,

  // Shared DAG artifact storage for cross-service Trinity dependency hydration
  `CREATE TABLE IF NOT EXISTS dag_artifacts (
    artifact_ref TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    artifact_kind VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,

  // Queue worker runtime snapshots for autonomous worker recovery and health reporting
  `CREATE TABLE IF NOT EXISTS worker_runtime_snapshots (
    worker_id TEXT PRIMARY KEY,
    worker_type VARCHAR(100) NOT NULL,
    health_status VARCHAR(50) NOT NULL,
    current_job_id TEXT,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    last_inspector_run_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,

  // V2 worker liveness path: cheap heartbeat-only updates with no indexed heartbeat timestamp
  `CREATE TABLE IF NOT EXISTS worker_liveness (
    worker_id TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL,
    health_status VARCHAR(50) NOT NULL
  )`,

  // V2 worker runtime state path: latest meaningful rich state only
  `CREATE TABLE IF NOT EXISTS worker_runtime_state (
    worker_id TEXT PRIMARY KEY,
    worker_type VARCHAR(100) NOT NULL,
    health_status VARCHAR(50) NOT NULL,
    current_job_id TEXT,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    last_inspector_run_at TIMESTAMPTZ,
    state_hash TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,

  // V2 worker runtime history path: append-only meaningful changes
  `CREATE TABLE IF NOT EXISTS worker_runtime_history (
    id BIGSERIAL PRIMARY KEY,
    worker_id TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    source VARCHAR(100) NOT NULL,
    health_status VARCHAR(50) NOT NULL,
    current_job_id TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,

  // Canonical durable session storage for the public ARCANOS session API
  `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL,
    tag TEXT,
    memory_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    transcript_summary TEXT,
    audit_trace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tag TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS transcript_summary TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS audit_trace_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  // Immutable session version history used by replay/restore operations
  `CREATE TABLE IF NOT EXISTS session_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, version_number)
  )`,

  // Action-plan tables used by predictive healing and agent orchestration
  `CREATE TABLE IF NOT EXISTS "Agent" (
    "id" TEXT PRIMARY KEY,
    "role" TEXT NOT NULL DEFAULT 'executor',
    "capabilities" TEXT[] NOT NULL,
    "publicKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS "ActionPlan" (
    "id" TEXT PRIMARY KEY,
    "createdBy" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "idempotencyKey" TEXT NOT NULL UNIQUE,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS "Action" (
    "id" TEXT PRIMARY KEY,
    "planId" TEXT NOT NULL REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "agentId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "rollbackAction" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS "ExecutionResult" (
    "id" TEXT PRIMARY KEY,
    "planId" TEXT NOT NULL REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "actionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "signature" TEXT,
    "clearDecision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("planId", "actionId")
  )`,

  `CREATE TABLE IF NOT EXISTS "ClearScore" (
    "id" TEXT PRIMARY KEY,
    "planId" TEXT NOT NULL UNIQUE REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "clarity" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "efficiency" DOUBLE PRECISION NOT NULL,
    "alignment" DOUBLE PRECISION NOT NULL,
    "resilience" DOUBLE PRECISION NOT NULL,
    "overall" DOUBLE PRECISION NOT NULL,
    "decision" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Reasoning logs table for GPT-5.1 reasoning results
  `CREATE TABLE IF NOT EXISTS reasoning_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'
  )`,

  // Indexes for performance
  `CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_expires_at ON memory(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_logs_worker_timestamp ON execution_logs(worker_id, timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_worker_status ON job_data(worker_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_pending_schedule ON job_data(status, next_run_at ASC, priority ASC, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_running_lease ON job_data(status, lease_expires_at ASC, last_heartbeat_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_correlation_id ON job_data(correlation_id) WHERE correlation_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_gpt_fingerprint_lookup ON job_data(job_type, idempotency_scope_hash, request_fingerprint_hash, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_gpt_idempotency_lookup ON job_data(job_type, idempotency_scope_hash, idempotency_key_hash, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_gpt_retention ON job_data(job_type, status, retention_until ASC, expires_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_data_cancel_requested ON job_data(status, cancel_requested_at ASC)`,
  // idx_job_data_stats_worker_updated is migration-managed because its first
  // build must use CREATE INDEX CONCURRENTLY outside application startup.
  `CREATE INDEX IF NOT EXISTS idx_job_events_job_occurred ON job_events(job_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_trace_id ON job_events(trace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_event_type_occurred ON job_events(event_type, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_worker_occurred ON job_events(worker_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_occurred_at ON job_events(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_runs_session_updated ON dag_runs(session_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_runs_status_updated ON dag_runs(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_runs_updated_at_desc ON dag_runs(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_artifacts_run_created ON dag_artifacts(run_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_artifacts_node_attempt ON dag_artifacts(node_id, attempt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_runtime_health_updated ON worker_runtime_snapshots(health_status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_liveness_last_seen ON worker_liveness(last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_runtime_state_health_changed ON worker_runtime_state(health_status, changed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_runtime_history_worker_changed ON worker_runtime_history(worker_id, changed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_tag_updated_at ON sessions(tag, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_memory_type_updated_at ON sessions(memory_type, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_payload_memory_key ON sessions ((payload->>'memoryKey'))`,
  `CREATE INDEX IF NOT EXISTS idx_session_versions_session_version ON session_versions(session_id, version_number DESC)`,

  // Canonical tenant-scoped persistence for the protected productivity capability
  `CREATE TABLE IF NOT EXISTS productivity_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_productivity_projects_scope_id
      UNIQUE (owner_principal_id, workspace_id, id),
    CONSTRAINT ck_productivity_projects_owner
      CHECK (char_length(btrim(owner_principal_id)) > 0),
    CONSTRAINT ck_productivity_projects_workspace
      CHECK (char_length(btrim(workspace_id)) > 0),
    CONSTRAINT ck_productivity_projects_title
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
    CONSTRAINT ck_productivity_projects_description
      CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 20000),
    CONSTRAINT ck_productivity_projects_status
      CHECK (status IN ('active', 'blocked', 'on_hold', 'completed', 'archived')),
    CONSTRAINT ck_productivity_projects_version
      CHECK (version >= 1)
  )`,

  `CREATE TABLE IF NOT EXISTS productivity_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id UUID,
    title TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'inbox',
    priority SMALLINT NOT NULL DEFAULT 0,
    due_at TIMESTAMPTZ,
    defer_until TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_productivity_tasks_owner
      CHECK (char_length(btrim(owner_principal_id)) > 0),
    CONSTRAINT ck_productivity_tasks_workspace
      CHECK (char_length(btrim(workspace_id)) > 0),
    CONSTRAINT ck_productivity_tasks_title
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
    CONSTRAINT ck_productivity_tasks_details
      CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 20000),
    CONSTRAINT ck_productivity_tasks_status
      CHECK (status IN ('inbox', 'next', 'scheduled', 'waiting', 'done', 'cancelled')),
    CONSTRAINT ck_productivity_tasks_priority
      CHECK (priority BETWEEN 0 AND 4),
    CONSTRAINT ck_productivity_tasks_version
      CHECK (version >= 1),
    CONSTRAINT fk_productivity_tasks_project_scope
      FOREIGN KEY (owner_principal_id, workspace_id, project_id)
      REFERENCES productivity_projects(owner_principal_id, workspace_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  )`,

  `CREATE TABLE IF NOT EXISTS productivity_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id UUID,
    title TEXT,
    content TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_productivity_notes_owner
      CHECK (char_length(btrim(owner_principal_id)) > 0),
    CONSTRAINT ck_productivity_notes_workspace
      CHECK (char_length(btrim(workspace_id)) > 0),
    CONSTRAINT ck_productivity_notes_title
      CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 240),
    CONSTRAINT ck_productivity_notes_content
      CHECK (char_length(btrim(content)) BETWEEN 1 AND 100000),
    CONSTRAINT ck_productivity_notes_version
      CHECK (version >= 1),
    CONSTRAINT fk_productivity_notes_project_scope
      FOREIGN KEY (owner_principal_id, workspace_id, project_id)
      REFERENCES productivity_projects(owner_principal_id, workspace_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  )`,

  `CREATE TABLE IF NOT EXISTS productivity_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    review_date DATE NOT NULL,
    content JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_productivity_reviews_owner
      CHECK (char_length(btrim(owner_principal_id)) > 0),
    CONSTRAINT ck_productivity_reviews_workspace
      CHECK (char_length(btrim(workspace_id)) > 0),
    CONSTRAINT ck_productivity_reviews_kind
      CHECK (kind IN ('daily', 'weekly')),
    CONSTRAINT ck_productivity_reviews_content
      CHECK (jsonb_typeof(content) = 'object')
  )`,

  `CREATE TABLE IF NOT EXISTS productivity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_sequence BIGSERIAL NOT NULL,
    owner_principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    aggregate_version BIGINT,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_principal_id TEXT NOT NULL,
    request_id TEXT,
    trace_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    CONSTRAINT uq_productivity_events_sequence
      UNIQUE (event_sequence),
    CONSTRAINT ck_productivity_events_owner
      CHECK (char_length(btrim(owner_principal_id)) > 0),
    CONSTRAINT ck_productivity_events_workspace
      CHECK (char_length(btrim(workspace_id)) > 0),
    CONSTRAINT ck_productivity_events_aggregate_type
      CHECK (aggregate_type IN ('task', 'project', 'note', 'review')),
    CONSTRAINT ck_productivity_events_aggregate_version
      CHECK (aggregate_version IS NULL OR aggregate_version >= 1),
    CONSTRAINT ck_productivity_events_event_type
      CHECK (char_length(btrim(event_type)) > 0),
    CONSTRAINT ck_productivity_events_actor
      CHECK (char_length(btrim(actor_principal_id)) > 0),
    CONSTRAINT ck_productivity_events_payload
      CHECK (jsonb_typeof(payload) = 'object')
  )`,

  `CREATE TABLE IF NOT EXISTS productivity_command_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    action TEXT NOT NULL,
    idempotency_key_hash TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    CONSTRAINT uq_productivity_command_receipts_scope_key
      UNIQUE (owner_principal_id, workspace_id, action, idempotency_key_hash),
    CONSTRAINT ck_productivity_command_receipts_owner
      CHECK (char_length(btrim(owner_principal_id)) > 0),
    CONSTRAINT ck_productivity_command_receipts_workspace
      CHECK (char_length(btrim(workspace_id)) > 0),
    CONSTRAINT ck_productivity_command_receipts_action
      CHECK (char_length(btrim(action)) > 0),
    CONSTRAINT ck_productivity_command_receipts_key_hash
      CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_productivity_command_receipts_fingerprint
      CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_productivity_command_receipts_result
      CHECK (jsonb_typeof(result) = 'object'),
    CONSTRAINT ck_productivity_command_receipts_expiry
      CHECK (expires_at > created_at)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_productivity_projects_scope_status_updated
    ON productivity_projects(owner_principal_id, workspace_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_tasks_scope_status_due
    ON productivity_tasks(owner_principal_id, workspace_id, status, due_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_tasks_scope_project_status
    ON productivity_tasks(owner_principal_id, workspace_id, project_id, status)
    WHERE project_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_notes_scope_updated
    ON productivity_notes(owner_principal_id, workspace_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_reviews_scope_type_date
    ON productivity_reviews(owner_principal_id, workspace_id, kind, review_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_events_scope_occurred
    ON productivity_events(owner_principal_id, workspace_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_events_unpublished
    ON productivity_events(event_sequence)
    WHERE published_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_productivity_command_receipts_scope_expires
    ON productivity_command_receipts(owner_principal_id, workspace_id, expires_at)`,

  // Install the dedicated Notion snapshot store only after every protected
  // legacy Backstage table exists, because its authority guard covers all of them.
  ...BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS,

  // The partitioned store is additive and shadow-only. Its single transactional
  // bootstrap statement preserves migration parity without changing legacy reads.
  ...BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS,
  ...BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_TABLE_DEFINITIONS,

  `CREATE INDEX IF NOT EXISTS idx_agent_status_updated_at ON "Agent"("status", "updatedAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_status_created_at ON "ActionPlan"("status", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_created_by_created_at ON "ActionPlan"("createdBy", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_updated_at ON "ActionPlan"("updatedAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_expires_at ON "ActionPlan"("expiresAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_origin_created_at ON "ActionPlan"("origin", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_requires_confirmation ON "ActionPlan"("requiresConfirmation", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_confidence ON "ActionPlan"("confidence" DESC, "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_idempotency_key ON "ActionPlan"("idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS idx_action_plan_sort_order ON "Action"("planId", "sortOrder" ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_result_plan_created_at ON "ExecutionResult"("planId", "createdAt" ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_reasoning_logs_timestamp ON reasoning_logs(timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_saves_module_timestamp ON saves(module, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_event_timestamp ON audit_logs(event, timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_docs_url ON rag_docs(url)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_wrestlers_name ON backstage_wrestlers(name)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_events_created_at ON backstage_events(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_story_beats_created_at ON backstage_story_beats(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_wrestlers_universe_updated
    ON backstage_wrestlers(universe_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_events_universe_created
    ON backstage_events(universe_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_storylines_universe_updated
    ON backstage_storylines(universe_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_story_beats_universe_created
    ON backstage_story_beats(universe_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_self_reflections_created_at ON self_reflections(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_self_reflections_category_priority ON self_reflections(category, priority)`
];

const schemaReadyPools = new WeakSet<Pool>();
const pendingSchemaInitializationByPool = new WeakMap<Pool, Promise<boolean>>();

/**
 * Return whether the exact current connected pool has completed schema setup.
 */
export function isDatabaseSchemaReady(): boolean {
  const pool = getPool();
  return Boolean(
    pool &&
    isDatabaseConnected() &&
    schemaReadyPools.has(pool)
  );
}

async function initializeTablesForPool(pool: Pool): Promise<boolean> {
  try {
    for (const query of TABLE_DEFINITIONS) {
      await pool.query(query);
    }

    //audit Assumption: a pool can be replaced or disconnected while its DDL is in flight; failure risk: completion from an obsolete pool marks a replacement ready; expected invariant: readiness belongs only to the exact current connected pool; handling strategy: re-check identity and connectivity before recording readiness.
    if (getPool() !== pool || !isDatabaseConnected()) {
      return false;
    }

    schemaReadyPools.add(pool);
    console.log('[🔌 DB] ✅ Database tables initialized successfully');
    return true;
  } catch (error: unknown) {
    //audit Assumption: initialization errors should surface; Handling: log + throw
    console.error('[🔌 DB] ❌ Failed to initialize tables:', getErrorMessage(error));
    throw error;
  }
}

/**
 * Initialize required database tables
 */
export function initializeTables(): Promise<boolean> {
  const pool = getPool();
  //audit Assumption: no pool means DB unavailable; Handling: report false without recording readiness.
  if (!pool) {
    return Promise.resolve(false);
  }

  if (schemaReadyPools.has(pool)) {
    return Promise.resolve(isDatabaseConnected());
  }

  const pendingInitialization = pendingSchemaInitializationByPool.get(pool);
  if (pendingInitialization) {
    return pendingInitialization;
  }

  const initialization = initializeTablesForPool(pool);
  pendingSchemaInitializationByPool.set(pool, initialization);
  void initialization.then(
    () => {
      if (pendingSchemaInitializationByPool.get(pool) === initialization) {
        pendingSchemaInitializationByPool.delete(pool);
      }
    },
    () => {
      if (pendingSchemaInitializationByPool.get(pool) === initialization) {
        pendingSchemaInitializationByPool.delete(pool);
      }
    }
  );

  return initialization;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'Unknown error';
}
