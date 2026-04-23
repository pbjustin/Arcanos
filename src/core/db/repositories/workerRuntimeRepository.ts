/**
 * Worker Runtime Snapshot Repository for ARCANOS
 *
 * Persists async worker health and recovery state for cross-instance inspection.
 */

import { initializeDatabase, isDatabaseConnected } from '@core/db/client.js';
import { query } from '@core/db/query.js';
import { initializeTables } from '@core/db/schema.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';
import { safeJSONParse, safeJSONStringify } from '@shared/jsonHelpers.js';
import { logger } from '@platform/logging/structuredLogging.js';

export interface WorkerRuntimeSnapshotRecord {
  workerId: string;
  workerType: string;
  healthStatus: string;
  currentJobId: string | null;
  lastError: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastInspectorRunAt: string | null;
  updatedAt: string;
  snapshot: Record<string, unknown>;
}

export interface UpsertWorkerRuntimeSnapshotOptions {
  source?: string;
}

const WORKER_RUNTIME_REPOSITORY_WORKER_ID = 'worker-runtime-snapshots';
const WORKER_RUNTIME_BOOTSTRAP_RETRY_COOLDOWN_MS = 30_000;
const WORKER_RUNTIME_UPSERT_SLOW_LOG_MIN_MS = 250;

let pendingBootstrap: Promise<boolean> | null = null;
let lastBootstrapFailureAtMs = 0;

/**
 * Ensure worker runtime persistence can reach PostgreSQL.
 * Purpose: lazily bootstrap database access for worker health inspection when app startup ordering varies.
 * Inputs/outputs: no inputs, returns a readiness boolean.
 * Edge case behavior: throttles repeated failed initialization attempts with a cooldown.
 */
async function ensureWorkerRuntimePersistenceReady(): Promise<boolean> {
  //audit Assumption: an already connected database can serve worker snapshot persistence immediately; failure risk: redundant initialization churn; expected invariant: connected DB short-circuits bootstrap; handling strategy: return early when connected.
  if (isDatabaseConnected()) {
    return true;
  }

  const nowMs = Date.now();
  const cooldownActive =
    lastBootstrapFailureAtMs > 0 &&
    nowMs - lastBootstrapFailureAtMs < WORKER_RUNTIME_BOOTSTRAP_RETRY_COOLDOWN_MS;

  //audit Assumption: repeated bootstrap failures should be rate-limited; failure risk: noisy retries under database outage; expected invariant: failed bootstrap attempts respect cooldown; handling strategy: fail closed until cooldown expires.
  if (cooldownActive) {
    return false;
  }

  //audit Assumption: concurrent calls should share one bootstrap attempt; failure risk: duplicated pool initialization and DDL contention; expected invariant: one shared in-flight bootstrap; handling strategy: reuse the pending promise.
  if (pendingBootstrap) {
    return pendingBootstrap;
  }

  pendingBootstrap = (async () => {
    try {
      const connected = await initializeDatabase(WORKER_RUNTIME_REPOSITORY_WORKER_ID);
      if (!connected || !isDatabaseConnected()) {
        lastBootstrapFailureAtMs = Date.now();
        return false;
      }

      await initializeTables();
      lastBootstrapFailureAtMs = 0;
      return true;
    } catch (error: unknown) {
      //audit Assumption: worker snapshot persistence failures should not crash request handling; failure risk: health endpoints become fatal during DB issues; expected invariant: callers receive a readiness boolean; handling strategy: warn and fail closed.
      lastBootstrapFailureAtMs = Date.now();
      console.warn('[Worker Runtime] Failed to initialize database persistence:', resolveErrorMessage(error));
      return false;
    } finally {
      pendingBootstrap = null;
    }
  })();

  return pendingBootstrap;
}

/**
 * Persist the latest worker runtime snapshot.
 * Purpose: keep async worker health state available across Railway instances and restarts.
 * Inputs/outputs: accepts one normalized runtime snapshot record and upserts it into PostgreSQL.
 * Edge case behavior: throws when persistence is unavailable so callers can decide whether to degrade or fail.
 */
export async function upsertWorkerRuntimeSnapshot(
  record: WorkerRuntimeSnapshotRecord,
  options: UpsertWorkerRuntimeSnapshotOptions = {}
): Promise<void> {
  const source =
    options.source ??
    (typeof record.snapshot.lastPersistSource === 'string'
      ? record.snapshot.lastPersistSource
      : 'unspecified');
  const startedAtMs = Date.now();
  const persistenceReady = await ensureWorkerRuntimePersistenceReady();
  if (!persistenceReady) {
    throw new Error('Worker runtime persistence is unavailable');
  }

  const serializedSnapshot = safeJSONStringify(
    record.snapshot,
    'workerRuntimeRepository.upsertWorkerRuntimeSnapshot'
  );

  //audit Assumption: runtime snapshots must remain JSON-serializable before writing to JSONB; failure risk: malformed snapshot payload breaks health persistence; expected invariant: snapshots serialize cleanly; handling strategy: throw when serialization fails.
  if (!serializedSnapshot) {
    throw new Error('Failed to serialize worker runtime snapshot');
  }

  let outcome: 'ok' | 'error' = 'ok';
  try {
    await query(
      `INSERT INTO worker_runtime_snapshots (
         worker_id,
         worker_type,
         health_status,
         current_job_id,
         last_error,
         started_at,
         last_heartbeat_at,
         last_inspector_run_at,
         updated_at,
         snapshot
       )
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb)
       ON CONFLICT (worker_id)
       DO UPDATE SET
         worker_type = EXCLUDED.worker_type,
         health_status = EXCLUDED.health_status,
         current_job_id = EXCLUDED.current_job_id,
         last_error = EXCLUDED.last_error,
         started_at = EXCLUDED.started_at,
         last_heartbeat_at = EXCLUDED.last_heartbeat_at,
         last_inspector_run_at = EXCLUDED.last_inspector_run_at,
         updated_at = EXCLUDED.updated_at,
         snapshot = EXCLUDED.snapshot`,
      [
        record.workerId,
        record.workerType,
        record.healthStatus,
        record.currentJobId,
        record.lastError,
        record.startedAt,
        record.lastHeartbeatAt,
        record.lastInspectorRunAt,
        record.updatedAt,
        serializedSnapshot
      ]
    );
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const durationMs = Date.now() - startedAtMs;
    const logContext = {
      module: 'worker-runtime',
      workerId: record.workerId,
      source,
      outcome,
      durationMs,
      snapshotBytes: Buffer.byteLength(serializedSnapshot, 'utf8')
    };
    if (outcome === 'error' || durationMs >= WORKER_RUNTIME_UPSERT_SLOW_LOG_MIN_MS) {
      logger.warn('worker.runtime_snapshot.upsert.slow', logContext);
    } else {
      logger.debug('worker.runtime_snapshot.upsert.completed', logContext);
    }
  }
}

/**
 * Load one worker runtime snapshot by worker id.
 * Purpose: let app and helper routes inspect the latest async worker health state.
 * Inputs/outputs: accepts a worker id and returns the stored snapshot record or `null`.
 * Edge case behavior: returns `null` when persistence is unavailable or the worker does not exist.
 */
export async function getWorkerRuntimeSnapshotById(
  workerId: string
): Promise<WorkerRuntimeSnapshotRecord | null> {
  const persistenceReady = await ensureWorkerRuntimePersistenceReady();

  //audit Assumption: missing persistence should degrade observability instead of hard-failing status reads; failure risk: helper routes return 500 during DB outages; expected invariant: read callers can handle `null`; handling strategy: fail closed with `null`.
  if (!persistenceReady) {
    return null;
  }

  const result = await query(
    `SELECT
       worker_id,
       worker_type,
       health_status,
       current_job_id,
       last_error,
       started_at,
       last_heartbeat_at,
       last_inspector_run_at,
       updated_at,
       snapshot
     FROM worker_runtime_snapshots
     WHERE worker_id = $1
     LIMIT 1`,
    [workerId]
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return buildWorkerRuntimeSnapshotRecord(row);
}

/**
 * List all persisted worker runtime snapshots.
 * Purpose: support helper health endpoints and operator inspection across worker instances.
 * Inputs/outputs: no inputs, returns worker snapshots ordered by freshness.
 * Edge case behavior: returns an empty array when persistence is unavailable.
 */
export async function listWorkerRuntimeSnapshots(): Promise<WorkerRuntimeSnapshotRecord[]> {
  const persistenceReady = await ensureWorkerRuntimePersistenceReady();

  //audit Assumption: snapshot listing should degrade cleanly when persistence is unavailable; failure risk: status endpoints fail closed on transient DB issues; expected invariant: callers can handle an empty list; handling strategy: return an empty array.
  if (!persistenceReady) {
    return [];
  }

  const result = await query(
    `SELECT
       worker_id,
       worker_type,
       health_status,
       current_job_id,
       last_error,
       started_at,
       last_heartbeat_at,
       last_inspector_run_at,
       updated_at,
       snapshot
     FROM worker_runtime_snapshots
     ORDER BY updated_at DESC`,
    []
  );

  return result.rows
    .map(row => buildWorkerRuntimeSnapshotRecord(row as Record<string, unknown>))
    .filter((record): record is WorkerRuntimeSnapshotRecord => Boolean(record));
}

function buildWorkerRuntimeSnapshotRecord(
  row: Record<string, unknown>
): WorkerRuntimeSnapshotRecord | null {
  const normalizedSnapshot = normalizeSnapshotObject(row.snapshot);
  if (!normalizedSnapshot) {
    return null;
  }

  return {
    workerId: String(row.worker_id ?? ''),
    workerType: String(row.worker_type ?? ''),
    healthStatus: String(row.health_status ?? ''),
    currentJobId: normalizeNullableString(row.current_job_id),
    lastError: normalizeNullableString(row.last_error),
    startedAt: normalizeNullableIsoString(row.started_at),
    lastHeartbeatAt: normalizeNullableIsoString(row.last_heartbeat_at),
    lastInspectorRunAt: normalizeNullableIsoString(row.last_inspector_run_at),
    updatedAt: normalizeIsoString(row.updated_at),
    snapshot: normalizedSnapshot
  };
}

function normalizeSnapshotObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    const parsedSnapshot = safeJSONParse<Record<string, unknown>>(
      value,
      'workerRuntimeRepository.normalizeSnapshotObject'
    );
    if (parsedSnapshot.success && parsedSnapshot.data && typeof parsedSnapshot.data === 'object') {
      return parsedSnapshot.data;
    }
  }

  return null;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeNullableIsoString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}

function normalizeIsoString(value: unknown): string {
  return normalizeNullableIsoString(value) ?? new Date().toISOString();
}
