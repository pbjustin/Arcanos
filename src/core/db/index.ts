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
  inspectDatabaseCollation,
  refreshDatabaseCollation,
  initializeTables,
  isDatabaseSchemaReady,
  MemoryEntrySchema,
  ExecutionLogSchema,
  JobDataSchema,
  ReasoningLogSchema,
  RagDocSchema,
  type MemoryEntry,
  type ExecutionLog,
  type JobData,
  type DatabaseCollationInspectionStatus,
  type ReasoningLog,
  type RagDoc
} from './schema.js';

// Query exports
export {
  isTransactionCommitAmbiguousError,
  query,
  transaction,
  TransactionCommitAmbiguousError,
  TRANSACTION_COMMIT_AMBIGUOUS_ERROR_CODE,
  type DbQueryOptions,
  type DbQueryTraceContext,
  type DbTransactionOptions
} from './query.js';
export {
  AUDITED_TRANSIENT_READ_QUERIES,
  type AuditedTransientReadQuery,
  type AuditedTransientReadQueryId
} from './transientReadRegistry.js';

// Repository exports
export {
  saveMemory,
  loadMemory,
  deleteMemory,
  loadMemoryRecordById,
  getMemoryRecordByKey,
  getMemoryRecordByRecordId,
  getMemoryRecordByLegacyRowId,
  type DurableMemoryRecord,
  type StoredMemoryRecord
} from './repositories/memoryRepository.js';

export {
  saveRagDoc,
  loadRagDocById,
  loadRagDocsByIds,
  loadAllRagDocs
} from './repositories/ragRepository.js';

export {
  applyBackstageRosterMutation,
  type BackstageRosterMutationResult
} from './repositories/backstageRosterRepository.js';

export {
  applyBackstageStorylineMutation,
  type BackstageStorylineMutationResult
} from './repositories/backstageStorylineRepository.js';

export {
  createGamingSourceRepository,
  findGamingSourceById,
  getGamingSourceById,
  persistGamingSourceRevision,
  queryActiveGamingKnowledge,
  searchActiveGamingKnowledge,
  GamingSourceCanonicalHashCollisionError,
  GamingSourceRepositoryUnavailableError,
  PostgresGamingSourceRepository,
  GAMING_KNOWLEDGE_RECORD_TYPES,
  GAMING_SOURCE_TYPES,
  type GamingDateInput,
  type GamingKnowledgeProvenanceRecord,
  type GamingKnowledgeRecordStatus,
  type GamingKnowledgeRecordType,
  type GamingSourceLatestRevision,
  type GamingSourceRecord,
  type GamingSourceRevisionState,
  type GamingSourceStatus,
  type GamingSourceType,
  type PersistGamingKnowledgeRecordInput,
  type PersistGamingSourceRevisionInput,
  type PersistGamingSourceRevisionResult,
  type QueryActiveGamingKnowledgeInput
} from './repositories/gamingSourceRepository.js';

export {
  logExecution,
  logExecutionBatch
} from './repositories/executionLogRepository.js';

export {
  createJob,
  createClaimedJobFence,
  claimNextPendingJob,
  deferJobForProviderRecovery,
  failPendingJobIfUnclaimed,
  normalizeJobClaimGeneration,
  recordJobHeartbeat,
  scheduleJobRetry,
  recoverStaleJobs,
  updateClaimedJobTerminal,
  updateJob,
  getJobById,
  getLatestJob,
  getJobQueueSummary,
  getJobExecutionStatsSince,
  type JobQueueSummary,
  type JobExecutionStats,
  type CreateJobOptions,
  type ClaimNextPendingJobOptions,
  type ClaimedJobFence,
  type ClaimedJobTerminalStatus,
  type DeferJobForProviderRecoveryOptions,
  type FailPendingJobIfUnclaimedOptions,
  type RecordJobHeartbeatOptions,
  type ScheduleJobRetryOptions,
  type UpdateClaimedJobTerminalOptions,
  type RecoverStaleJobsOptions,
  type RecoverStaleJobsResult
} from './repositories/jobRepository.js';

export {
  cleanupJobEvents,
  listJobEventTimeline,
  recordJobEvent,
  DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE,
  DEFAULT_JOB_EVENT_RETENTION_DAYS,
  DEFAULT_JOB_EVENT_TIMELINE_LIMIT,
  JOB_EVENT_TYPES,
  type CleanupJobEventsOptions,
  type CleanupJobEventsResult,
  type JobEventTimelineRow,
  type JobEventType,
  type ListJobEventTimelineInput,
  type ListJobEventTimelineResult,
  type RecordJobEventInput,
  type RecordJobEventResult
} from './repositories/jobEventRepository.js';

export {
  upsertDagRunSnapshot,
  getDagRunSnapshotById,
  type DagRunSnapshotRecord
} from './repositories/dagRunRepository.js';

export {
  appendWorkerRuntimeHistory,
  listWorkerLiveness,
  upsertWorkerRuntimeSnapshot,
  upsertWorkerRuntimeState,
  recordWorkerLiveness,
  getWorkerRuntimeSnapshotById,
  listWorkerRuntimeStateSnapshots,
  listWorkerRuntimeSnapshots,
  type WorkerLivenessSnapshotRecord,
  type WorkerRuntimeSnapshotRecord
} from './repositories/workerRuntimeRepository.js';

export {
  logReasoning
} from './repositories/reasoningLogRepository.js';

export {
  saveSelfReflection
} from './repositories/selfReflectionRepository.js';

export {
  createStoredSession,
  getStoredSessionById,
  listStoredSessions,
  getStoredSessionVersion,
  getSessionStorageMetrics,
  type CreateStoredSessionInput,
  type StoredSessionRecord,
  type StoredSessionVersionRecord,
  type StoredSessionListOptions,
  type StoredSessionListResult,
  type SessionStorageMetrics
} from './repositories/sessionRepository.js';

export {
  createProductivityRepository,
  getProductivityRepository
} from './repositories/productivityRepository.js';

// Adapter exports
export {
  createAuditStore,
  type AuditStore,
  type AuditStoreTransaction,
  type AuditStoreConfig
} from './auditStore.js';

export {
  createSessionCacheStore,
  type SessionCacheStore,
  type SessionCacheStoreConfig,
  type SessionCacheRow
} from './sessionCacheStore.js';

/**
 * Initialize database with full schema setup
 * This is the main entry point for database initialization
 */
import {
  initializeDatabase as initDB,
  getPool,
  isDatabaseConnected
} from './client.js';
import {
  inspectDatabaseCollation,
  initializeTables,
  isDatabaseSchemaReady
} from './schema.js';

export async function initializeDatabaseWithSchema(workerId = ''): Promise<boolean> {
  if (!isDatabaseConnected() || !getPool()) {
    const connected = await initDB(workerId);
    if (!connected) {
      return false;
    }
  }

  const startupPool = getPool();
  if (!startupPool || !isDatabaseConnected()) {
    return false;
  }

  await inspectDatabaseCollation();
  if (getPool() !== startupPool || !isDatabaseConnected()) {
    return false;
  }

  const schemaInitialized = await initializeTables();
  if (
    !schemaInitialized ||
    getPool() !== startupPool ||
    !isDatabaseConnected() ||
    !isDatabaseSchemaReady()
  ) {
    return false;
  }

  if (workerId) {
    try {
      await startupPool.query(
        'INSERT INTO execution_logs (worker_id, timestamp, level, message, metadata) VALUES ($1, NOW(), $2, $3, $4)',
        [workerId, 'status', 'online', {}]
      );
    } catch (hbErr) {
      console.error('[🔌 DB] Heartbeat insert failed:', (hbErr as Error).message);
    }
  }

  return (
    getPool() === startupPool &&
    isDatabaseConnected() &&
    isDatabaseSchemaReady()
  );
}
