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
  value: z.any(),
  created_at: z.date(),
  updated_at: z.date()
});

export const ExecutionLogSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  timestamp: z.date(),
  level: z.string(),
  message: z.string(),
  metadata: z.any()
});

export const JobDataSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  job_type: z.string(),
  status: z.string(),
  input: z.any(),
  output: z.any().optional(),
  error_message: z.string().optional(),
  created_at: z.date(),
  updated_at: z.date(),
  completed_at: z.date().optional()
});

export const ReasoningLogSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  input: z.string(),
  output: z.string(),
  metadata: z.any()
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

// TypeScript types from Zod schemas
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type ExecutionLog = z.infer<typeof ExecutionLogSchema>;
export type JobData = z.infer<typeof JobDataSchema>;
export type ReasoningLog = z.infer<typeof ReasoningLogSchema>;
export type RagDoc = z.infer<typeof RagDocSchema>;

/**
 * Refresh database collation if version mismatch detected
 */
export async function refreshDatabaseCollation(): Promise<void> {
  const pool = getPool();
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

    if (!dbRows.length) {
      return;
    }

    const { name, datcollate, datcollversion } = dbRows[0];

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

    if (!collationRows.length) {
      return;
    }

    const latestCollationVersion = collationRows[0].collversion;

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
    } catch (reindexError) {
      console.warn('[🔌 DB] Database reindex skipped:', (reindexError as Error).message);
    }

    await pool.query(`ALTER DATABASE "${safeName}" REFRESH COLLATION VERSION`);
    console.log('[🔌 DB] Collation version refreshed successfully');
  } catch (error) {
    console.warn('[🔌 DB] Collation refresh skipped:', (error as Error).message);
  }
}

/**
 * Initialize required database tables
 */
export async function initializeTables(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const queries = [
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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`,
    
    // Reasoning logs table for GPT-5 reasoning results
    `CREATE TABLE IF NOT EXISTS reasoning_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'
    )`,
    
    // Indexes for performance
    `CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key)`,
    `CREATE INDEX IF NOT EXISTS idx_execution_logs_worker_timestamp ON execution_logs(worker_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_job_data_worker_status ON job_data(worker_id, status)`,
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

  try {
    for (const query of queries) {
      await pool.query(query);
    }
    console.log('[🔌 DB] ✅ Database tables initialized successfully');
  } catch (error) {
    console.error('[🔌 DB] ❌ Failed to initialize tables:', (error as Error).message);
    throw error;
  }
}
