/**
 * Database Schema Module for ARCANOS
 * 
 * Defines database table schemas and initialization logic.
 * Uses Zod for schema validation and type safety.
 */

import { z } from 'zod';
import { getPool } from './client.js';

// Zod Schemas for Database Entities
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
  last_worker_id: z.string().optional(),
  autonomy_state: z.unknown().optional(),
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
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type SessionVersionRecord = z.infer<typeof SessionVersionRecordSchema>;

/**
 * Refresh database collation if version mismatch detected
 */
export async function refreshDatabaseCollation(): Promise<void> {
  const pool = getPool();
  //audit Assumption: no pool means DB unavailable; Handling: exit
  if (!pool) return;

  try {
    const { rows: dbRows } = await pool.query<{
      name: string;
      datcollate: string;
      datcollversion: string | null;
    }>(
      `SELECT datname AS name, datcollate, datcollversion
       FROM pg_database
       WHERE datname = current_database()`
    );

    //audit Assumption: missing database row means no current DB; Handling: exit
    if (!dbRows.length) {
      return;
    }

    const { name, datcollate, datcollversion } = dbRows[0];

    //audit Assumption: missing collation version means no refresh required
    if (!datcollversion) {
      return;
    }

    const { rows: collationRows } = await pool.query<{ collversion: string | null }>(
      `SELECT collversion
       FROM pg_collation
       WHERE collname = $1 AND collversion IS NOT NULL
       ORDER BY collversion DESC
       LIMIT 1`,
      [datcollate]
    );

    //audit Assumption: missing collation info means no refresh required
    if (!collationRows.length) {
      return;
    }

    const latestCollationVersion = collationRows[0].collversion;

    //audit Assumption: unchanged versions need no action; Handling: exit
    if (!latestCollationVersion || latestCollationVersion === datcollversion) {
      return;
    }

    console.warn(
      `[🔌 DB] Collation version mismatch detected (database=${datcollversion}, system=${latestCollationVersion}) - rebuilding indexes & refreshing...`
    );

    const safeName = name.replace(/"/g, '""');

    try {
      await pool.query(`REINDEX DATABASE "${safeName}"`);
      console.log('[🔌 DB] Database reindexed successfully prior to collation refresh');
    } catch (reindexError: unknown) {
      //audit Assumption: reindex failure should not block refresh; Handling: warn
      console.warn('[🔌 DB] Database reindex skipped:', getErrorMessage(reindexError));
    }

    await pool.query(`ALTER DATABASE "${safeName}" REFRESH COLLATION VERSION`);
    console.log('[🔌 DB] Collation version refreshed successfully');
  } catch (error: unknown) {
    //audit Assumption: refresh failure should be non-fatal; Handling: warn
    console.warn('[🔌 DB] Collation refresh skipped:', getErrorMessage(error));
  }
}

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

  // Backstage Booker tables for persistent wrestling data
  `CREATE TABLE IF NOT EXISTS backstage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_wrestlers (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    overall INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_storylines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_key TEXT UNIQUE NOT NULL,
    storyline TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS backstage_story_beats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

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
    autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 2`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS last_worker_id VARCHAR(255)`,
  `ALTER TABLE job_data ADD COLUMN IF NOT EXISTS autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb`,

  // DAG verification snapshot storage for cross-instance orchestration inspection
  `CREATE TABLE IF NOT EXISTS dag_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    template TEXT NOT NULL,
    status VARCHAR(50) NOT NULL,
    planner_node_id TEXT,
    root_node_id TEXT,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,

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
  `CREATE INDEX IF NOT EXISTS idx_dag_runs_session_updated ON dag_runs(session_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_runs_status_updated ON dag_runs(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_runs_updated_at_desc ON dag_runs(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_artifacts_run_created ON dag_artifacts(run_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dag_artifacts_node_attempt ON dag_artifacts(node_id, attempt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_runtime_health_updated ON worker_runtime_snapshots(health_status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_tag_updated_at ON sessions(tag, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_memory_type_updated_at ON sessions(memory_type, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_payload_memory_key ON sessions ((payload->>'memoryKey'))`,
  `CREATE INDEX IF NOT EXISTS idx_session_versions_session_version ON session_versions(session_id, version_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reasoning_logs_timestamp ON reasoning_logs(timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_saves_module_timestamp ON saves(module, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_event_timestamp ON audit_logs(event, timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_docs_url ON rag_docs(url)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_wrestlers_name ON backstage_wrestlers(name)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_events_created_at ON backstage_events(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backstage_story_beats_created_at ON backstage_story_beats(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_self_reflections_created_at ON self_reflections(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_self_reflections_category_priority ON self_reflections(category, priority)`
];

/**
 * Initialize required database tables
 */
export async function initializeTables(): Promise<void> {
  const pool = getPool();
  //audit Assumption: no pool means DB unavailable; Handling: exit
  if (!pool) return;

  try {
    for (const query of TABLE_DEFINITIONS) {
      await pool.query(query);
    }
    console.log('[🔌 DB] ✅ Database tables initialized successfully');
  } catch (error: unknown) {

    //audit Assumption: initialization errors should surface; Handling: log + throw
    console.error('[🔌 DB] ❌ Failed to initialize tables:', getErrorMessage(error));
    throw error;
  }
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
