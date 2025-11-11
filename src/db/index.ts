#!/usr/bin/env node
/**
 * Unified Database Module for ARCANOS
 * 
 * Modular database architecture with clear separation of concerns:
 * - client.ts: Connection pooling and initialization
 * - schema.ts: Table schemas and Zod validation
 * - query.ts: Query helpers with caching and retry logic
 * - repositories/: Entity-specific data access logic
 * 
 * This module provides backward compatibility with the original db.ts interface
 * while offering a cleaner, more maintainable structure.
 */

// Client exports
export {
  initializeDatabase,
  getPool,
  isDatabaseConnected,
  getStatus,
  close,
  type DatabaseStatus
} from './client.js';

// Schema exports
export {
  refreshDatabaseCollation,
  initializeTables,
  MemoryEntrySchema,
  ExecutionLogSchema,
  JobDataSchema,
  ReasoningLogSchema,
  RagDocSchema,
  type MemoryEntry,
  type ExecutionLog,
  type JobData,
  type ReasoningLog,
  type RagDoc
} from './schema.js';

// Query exports
export {
  query,
  transaction
} from './query.js';

// Repository exports
export {
  saveMemory,
  loadMemory,
  deleteMemory
} from './repositories/memoryRepository.js';

export {
  saveRagDoc,
  loadAllRagDocs
} from './repositories/ragRepository.js';

export {
  logExecution,
  logExecutionBatch
} from './repositories/executionLogRepository.js';

export {
  createJob,
  updateJob,
  getLatestJob
} from './repositories/jobRepository.js';

export {
  logReasoning
} from './repositories/reasoningLogRepository.js';

export {
  saveSelfReflection
} from './repositories/selfReflectionRepository.js';

/**
 * Initialize database with full schema setup
 * This is the main entry point for database initialization
 */
import { initializeDatabase as initDB, getPool } from './client.js';
import { refreshDatabaseCollation, initializeTables } from './schema.js';

export async function initializeDatabaseWithSchema(workerId = ''): Promise<boolean> {
  const success = await initDB(workerId);
  
  if (success && getPool()) {
    // Initialize required tables for ARCANOS operations
    await refreshDatabaseCollation();
    await initializeTables();

    if (workerId) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            'INSERT INTO execution_logs (worker_id, timestamp, level, message, metadata) VALUES ($1, NOW(), $2, $3, $4)',
            [workerId, 'status', 'online', {}]
          );
        } catch (hbErr) {
          console.error('[🔌 DB] Heartbeat insert failed:', (hbErr as Error).message);
        }
      }
    }
  }
  
  return success;
}
