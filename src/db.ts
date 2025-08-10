#!/usr/bin/env node
/**
 * Centralized Database Module for ARCANOS
 * 
 * Provides PostgreSQL connection pool and helper functions for all workers.
 * Gracefully handles missing DATABASE_URL environment variable.
 */

import { Pool, PoolClient, QueryResult } from 'pg';

let pool: Pool | null = null;
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
async function initializeDatabase(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.log('[🔌 DB] DATABASE_URL not set - database features disabled');
    return false;
  }

  try {
    console.log('[🔌 DB] Initializing PostgreSQL connection pool...');
    
    // Optimized connection pool configuration for ARCANOS workloads
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10, // Reduced from 20 - sufficient for typical ARCANOS usage
      min: 2,  // Maintain minimum connections for responsiveness
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Test the connection with a simple query
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    isConnected = true;
    console.log('[🔌 DB] ✅ Database connection established successfully');
    
    // Initialize required tables for ARCANOS operations
    await initializeTables();
    
    return true;
  } catch (error) {
    connectionError = error as Error;
    console.error('[🔌 DB] ❌ Failed to connect to database:', (error as Error).message);
    console.error('[🔌 DB] Database features will be disabled');
    return false;
  }
}

/**
 * Initialize required database tables
 */
async function initializeTables(): Promise<void> {
  if (!pool) return;

  const queries = [
    // Memory table for persistent worker memory
    `CREATE TABLE IF NOT EXISTS memory (
      id SERIAL PRIMARY KEY,
      key VARCHAR(255) UNIQUE NOT NULL,
      value JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
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
    `CREATE INDEX IF NOT EXISTS idx_reasoning_logs_timestamp ON reasoning_logs(timestamp DESC)`
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
 * Generic query helper function
 */
async function query(text: string, params: any[] = [], attempt = 1): Promise<QueryResult> {
  if (!isConnected || !pool) {
    throw new Error('Database not configured or not connected');
  }

  const client = await pool.connect();

  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    console.log(`[🔌 DB] Query executed in ${duration}ms`);
    return result;
  } catch (error) {
    console.error('[🔌 DB] Query error:', (error as Error).message);

    if (attempt < 3) {
      console.log(`[🔌 DB] Retry attempt ${attempt} for query`);
      return query(text, params, attempt + 1);
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

  const result = await query('SELECT value FROM memory WHERE key = $1', [key]);
  
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
    const values = entries.map((entry, index) => {
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
  type ReasoningLog
};