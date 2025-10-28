#!/usr/bin/env node
/**
 * Centralized Database Module for ARCANOS
 * 
 * Provides PostgreSQL connection pool and helper functions for all workers.
 * Gracefully handles missing DATABASE_URL environment variable.
 */

import pkg from 'pg';
import type { Pool as PoolType, PoolClient, QueryResult } from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { queryCache } from './utils/cache.js';
import crypto from 'crypto';

// Load environment variables for worker runtime
dotenv.config();

let pool: PoolType | null = null;
let isConnected = false;
let connectionError: Error | null = null;

interface DatabaseStatus {
  connected: boolean;
  hasPool: boolean;
  error: string | null;
}

interface MemoryEntry {
  id: number;
  key: string;
  value: any;
  created_at: Date;
  updated_at: Date;
}

interface ExecutionLog {
  id: string;
  worker_id: string;
  timestamp: Date;
  level: string;
  message: string;
  metadata: any;
}

interface JobData {
  id: string;
  worker_id: string;
  job_type: string;
  status: string;
  input: any;
  output?: any;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
}

interface ReasoningLog {
  id: string;
  timestamp: Date;
  input: string;
  output: string;
  metadata: any;
}

interface RagDoc {
  id: string;
  url: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  created_at?: Date;
  updated_at?: Date;
}

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
 * Initialize database connection pool
 */
/**
 * Initialize database connection pool and verify connectivity
 * 
 * Sets up a PostgreSQL connection pool with optimized settings for ARCANOS:
 * - SSL configuration based on environment (localhost vs production)
 * - Connection pooling for efficient resource usage
 * - Graceful handling of missing DATABASE_URL
 * - Automatic table initialization on successful connection
 * 
 * @returns Promise<boolean> - True if database initialized successfully, false otherwise
 */
async function initializeDatabase(workerId = ''): Promise<boolean> {
  // Ensure all expected environment variables are loaded
  const envVars = [
    'DATABASE_URL',
    'DATABASE_PUBLIC_URL',
    'PGDATA',
    'PGDATABASE',
    'PGHOST',
    'PGPASSWORD',
    'PGPORT',
    'PGUSER',
    'POSTGRES_PASSWORD',
    'POSTGRES_USER'
  ];
  envVars.forEach(v => process.env[v] = process.env[v]);

  let databaseUrl = process.env.DATABASE_URL || '';

  // Construct DATABASE_URL if not provided
  if (!databaseUrl) {
    const required = ['PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'];
    const missing = required.filter(v => !process.env[v]);
    if (missing.length) {
      console.error('[🔌 DB] Missing environment variables:', missing.join(', '));
      return false;
    }
    databaseUrl = `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;
    process.env.DATABASE_URL = databaseUrl;
  }

  // Enforce SSL when not connecting to localhost
  const host = process.env.PGHOST || 'localhost';
  if (host !== 'localhost' && host !== '127.0.0.1' && !databaseUrl.includes('sslmode=')) {
    databaseUrl += databaseUrl.includes('?') ? '&sslmode=require' : '?sslmode=require';
    process.env.DATABASE_URL = databaseUrl;
  }

  console.log('[🔌 DB] Initializing PostgreSQL connection pool...');

  try {
    const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.PGHOST;
    pool = new Pool({
      connectionString: databaseUrl,
      ...(isRailway ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 10,
      min: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Handle unexpected errors to prevent crashes and enable automatic reconnection
    pool.on('error', (err: Error) => {
      console.error('[🔌 DB] Unexpected error on idle client', err);
      isConnected = false;
      // Clean up broken pool and attempt reinitialization after short delay
      pool?.end().catch(() => {});
      pool = null;
      setTimeout(() => {
        initializeDatabase(workerId).catch(reconnectErr =>
          console.error('[🔌 DB] Reconnection attempt failed:', reconnectErr)
        );
      }, 5000);
    });

    await pool.query('SELECT 1');
    isConnected = true;
    console.log('DB connection successful');

    // Initialize required tables for ARCANOS operations
    await refreshDatabaseCollation();
    await initializeTables();

    if (workerId) {
      try {
        await pool.query(
          'INSERT INTO execution_logs (worker_id, timestamp, level, message, metadata) VALUES ($1, NOW(), $2, $3, $4)',
          [workerId, 'status', 'online', {}]
        );
      } catch (hbErr) {
        console.error('[🔌 DB] Heartbeat insert failed:', (hbErr as Error).message);
      }
    }

    return true;
  } catch (error) {
    connectionError = error as Error;
    isConnected = false;
    console.error('[🔌 DB] Connection failed:', (error as Error).message);
    return false;
  }
}

async function refreshDatabaseCollation(): Promise<void> {
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
async function initializeTables(): Promise<void> {
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
    `CREATE INDEX IF NOT EXISTS idx_backstage_story_beats_created_at ON backstage_story_beats(created_at DESC)`
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

/**
 * Creates a cache key for database queries
 */
function createQueryCacheKey(text: string, params: any[]): string {
  const content = `${text}:${JSON.stringify(params)}`;
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Enhanced query helper with caching and optimization
 */
async function query(text: string, params: any[] = [], attempt = 1, useCache = false): Promise<QueryResult> {
  if (!isConnected || !pool) {
    throw new Error('Database not configured or not connected');
  }

  // Check cache for SELECT queries
  if (useCache && text.trim().toLowerCase().startsWith('select')) {
    const cacheKey = createQueryCacheKey(text, params);
    const cachedResult = queryCache.get(cacheKey);
    if (cachedResult) {
      console.log('💾 Database cache hit for query');
      return cachedResult;
    }
  }

  const client = await pool.connect();

  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    console.log(`[🔌 DB] Query executed in ${duration}ms (rows: ${result.rowCount || 0})`);
    
    // Cache SELECT queries that return data
    if (useCache && text.trim().toLowerCase().startsWith('select') && result.rows.length > 0) {
      const cacheKey = createQueryCacheKey(text, params);
      const cacheTtl = result.rows.length < 100 ? 10 * 60 * 1000 : 5 * 60 * 1000; // Smaller results cached longer
      queryCache.set(cacheKey, result, cacheTtl);
    }

    return result;
  } catch (error) {
    console.error('[🔌 DB] Query error:', (error as Error).message);

    if (attempt < 3) {
      console.log(`[🔌 DB] Retry attempt ${attempt} for query`);
      return query(text, params, attempt + 1, useCache);
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction helper function
 */
async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isConnected || !pool) {
    throw new Error('Database not configured or not connected');
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[🔌 DB] Transaction error:', (error as Error).message);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Memory storage functions
 */
async function saveMemory(key: string, value: any): Promise<MemoryEntry> {
  if (!isConnected) {
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

async function loadMemory(key: string): Promise<any | null> {
  if (!isConnected) {
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

async function deleteMemory(key: string): Promise<boolean> {
  if (!isConnected) {
    throw new Error('Database not configured');
  }

  const result = await query('DELETE FROM memory WHERE key = $1 RETURNING *', [key]);
  return (result.rowCount || 0) > 0;
}

/**
 * RAG document storage functions
 */
async function saveRagDoc(doc: RagDoc): Promise<RagDoc> {
  if (!isConnected) {
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

async function loadAllRagDocs(): Promise<RagDoc[]> {
  if (!isConnected) {
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

/**
 * Execution logging functions - optimized with batch processing capability
 */
async function logExecution(workerId: string, level: string, message: string, metadata: any = {}): Promise<void> {
  if (!isConnected) {
    console.log(`[${workerId}] ${level.toUpperCase()}: ${message}`);
    return;
  }

  try {
    await query(
      'INSERT INTO execution_logs (worker_id, level, message, metadata) VALUES ($1, $2, $3, $4)',
      [workerId, level, message, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error('[🔌 DB] Failed to log execution:', (error as Error).message);
    // Fallback to console logging
    console.log(`[${workerId}] ${level.toUpperCase()}: ${message}`);
  }
}

/**
 * Batch log multiple execution entries for improved performance
 */
async function logExecutionBatch(entries: Array<{workerId: string, level: string, message: string, metadata?: any}>): Promise<void> {
  if (!isConnected || entries.length === 0) {
    entries.forEach(entry => console.log(`[${entry.workerId}] ${entry.level.toUpperCase()}: ${entry.message}`));
    return;
  }

  try {
    const values = entries.map((_, index) => {
      const base = index * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(', ');
    
    const params = entries.flatMap(entry => [
      entry.workerId,
      entry.level,
      entry.message,
      JSON.stringify(entry.metadata || {})
    ]);

    await query(
      `INSERT INTO execution_logs (worker_id, level, message, metadata) VALUES ${values}`,
      params
    );
  } catch (error) {
    console.error('[🔌 DB] Failed to batch log execution:', (error as Error).message);
    // Fallback to individual console logging
    entries.forEach(entry => console.log(`[${entry.workerId}] ${entry.level.toUpperCase()}: ${entry.message}`));
  }
}

/**
 * Job data functions
 */
async function createJob(workerId: string, jobType: string, input: any, status: string = 'pending'): Promise<JobData> {
  if (!isConnected) {
    throw new Error('Database not configured');
  }

  const result = await query(
    'INSERT INTO job_data (worker_id, job_type, status, input) VALUES ($1, $2, $3, $4) RETURNING *',
    [workerId, jobType, status, JSON.stringify(input)]
  );

  return result.rows[0];
}

async function updateJob(jobId: string, status: string, output: any = null, errorMessage: string | null = null): Promise<JobData> {
  if (!isConnected) {
    throw new Error('Database not configured');
  }

  const completedAt = status === 'completed';
  const result = await query(
    `UPDATE job_data
     SET status = $1, output = $2, error_message = $3, updated_at = NOW(), completed_at = ${completedAt ? 'NOW()' : 'completed_at'}
     WHERE id = $4 RETURNING *`,
    [status, JSON.stringify(output), errorMessage, jobId]
  );
  
  return result.rows[0];
}

async function getLatestJob(): Promise<JobData | null> {
  if (!isConnected) {
    return null;
  }

  try {
    const result = await query(
      'SELECT * FROM job_data ORDER BY created_at DESC LIMIT 1',
      []
    );
    
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error fetching latest job:', error);
    return null;
  }
}

/**
 * Reasoning logs functions
 */
async function logReasoning(input: string, output: string, metadata: any = {}): Promise<ReasoningLog | undefined> {
  if (!isConnected) {
    console.log('[🧠 REASONING] Input:', input.substring(0, 100) + '...');
    console.log('[🧠 REASONING] Output:', output.substring(0, 100) + '...');
    return;
  }

  try {
    const result = await query(
      'INSERT INTO reasoning_logs (input, output, metadata) VALUES ($1, $2, $3) RETURNING *',
      [input, output, JSON.stringify(metadata)]
    );
    
    console.log('[🧠 REASONING] ✅ Reasoning logged to database');
    return result.rows[0];
  } catch (error) {
    console.error('[🔌 DB] Failed to log reasoning:', (error as Error).message);
    // Fallback to console logging
    console.log('[🧠 REASONING] Input:', input.substring(0, 100) + '...');
    console.log('[🧠 REASONING] Output:', output.substring(0, 100) + '...');
  }
}

/**
 * Get database status
 */
function getStatus(): DatabaseStatus {
  return {
    connected: isConnected,
    hasPool: pool !== null,
    error: connectionError?.message || null
  };
}

/**
 * Close database connection
 */
async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    isConnected = false;
    console.log('[🔌 DB] Connection pool closed');
  }
}

// Export all functions
export {
  initializeDatabase,
  query,
  transaction,
  saveMemory,
  loadMemory,
  deleteMemory,
  saveRagDoc,
  loadAllRagDocs,
  logExecution,
  logExecutionBatch,
  createJob,
  updateJob,
  getLatestJob,
  logReasoning,
  getStatus,
  close,
  type DatabaseStatus,
  type MemoryEntry,
  type ExecutionLog,
  type JobData,
  type ReasoningLog,
  type RagDoc
};