#!/usr/bin/env node
/**
 * Database Module for ARCANOS (Backward Compatibility Layer)
 * 
 * This file maintains backward compatibility with the original db.ts interface.
 * The actual implementation has been refactored into a modular structure:
 * 
 * - src/db/client.ts: Connection pooling and initialization
 * - src/db/schema.ts: Table schemas and Zod validation
 * - src/db/query.ts: Query helpers with caching and retry logic
 * - src/db/repositories/: Entity-specific data access logic
 * - src/db/index.ts: Unified export
 * 
 * All exports are re-exported from the modular structure for compatibility.
 */

export {
  initializeDatabaseWithSchema as initializeDatabase,
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
} from './db/index.js';