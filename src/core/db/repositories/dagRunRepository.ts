/**
 * DAG Run Repository for ARCANOS
 *
 * Persists DAG verification snapshots so multi-instance deployments can inspect the same runs.
 */

import { initializeDatabase, isDatabaseConnected } from '@core/db/client.js';
import { query } from '@core/db/query.js';
import { initializeTables } from '@core/db/schema.js';
import { safeJSONParse, safeJSONStringify } from '@shared/jsonHelpers.js';

export interface DagRunSnapshotRecord {
  runId: string;
  sessionId: string;
  template: string;
  status: string;
  plannerNodeId: string | null;
  rootNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  snapshot: Record<string, unknown>;
}

const DAG_RUN_REPOSITORY_WORKER_ID = 'dag-runs';
const DAG_RUN_BOOTSTRAP_RETRY_COOLDOWN_MS = 30_000;

let pendingBootstrap: Promise<boolean> | null = null;
let lastBootstrapFailureAtMs = 0;

/**
 * Ensure DAG run persistence can reach PostgreSQL.
 * Purpose: lazily bootstrap database access for DAG verification flows that execute outside normal startup ordering.
 * Inputs/outputs: no inputs, returns a readiness boolean.
 * Edge cases: throttles repeated failed initialization attempts with a cooldown.
 */
async function ensureDagRunPersistenceReady(): Promise<boolean> {
  //audit Assumption: an active database connection means DAG persistence can proceed immediately; failure risk: redundant bootstrap attempts add latency and noise; expected invariant: connected DB returns fast; handling strategy: short-circuit when already connected.
  if (isDatabaseConnected()) {
    return true;
  }

  const nowMs = Date.now();
  const cooldownActive =
    lastBootstrapFailureAtMs > 0 &&
    nowMs - lastBootstrapFailureAtMs < DAG_RUN_BOOTSTRAP_RETRY_COOLDOWN_MS;

  //audit Assumption: repeated bootstrap failures should be rate-limited; failure risk: noisy retry storms under DB outage; expected invariant: retries respect cooldown; handling strategy: fail closed until cooldown expires.
  if (cooldownActive) {
    return false;
  }

  //audit Assumption: concurrent persistence calls should share one bootstrap attempt; failure risk: duplicate pool initialization and table DDL races; expected invariant: at most one bootstrap promise runs at a time; handling strategy: reuse the in-flight promise.
  if (pendingBootstrap) {
    return pendingBootstrap;
  }

  pendingBootstrap = (async () => {
    try {
      const connected = await initializeDatabase(DAG_RUN_REPOSITORY_WORKER_ID);
      if (!connected || !isDatabaseConnected()) {
        lastBootstrapFailureAtMs = Date.now();
        return false;
      }

      await initializeTables();
      lastBootstrapFailureAtMs = 0;
      return true;
    } catch (error: unknown) {
      //audit Assumption: persistence bootstrap failures should not crash orchestration flows; failure risk: DAG execution fails solely due to observability storage; expected invariant: callers receive boolean readiness; handling strategy: warn and fail closed.
      lastBootstrapFailureAtMs = Date.now();
      console.warn('[DAG Runs] Failed to initialize database persistence:', getErrorMessage(error));
      return false;
    } finally {
      pendingBootstrap = null;
    }
  })();

  return pendingBootstrap;
}

/**
 * Persist the latest DAG verification snapshot.
 * Purpose: keep run inspection state available across Railway instances and process restarts.
 * Inputs/outputs: accepts one normalized snapshot record and upserts it into PostgreSQL.
 * Edge cases: throws when persistence is unavailable so callers can decide whether to fail or degrade.
 */
export async function upsertDagRunSnapshot(record: DagRunSnapshotRecord): Promise<void> {
  const persistenceReady = await ensureDagRunPersistenceReady();
  if (!persistenceReady) {
    throw new Error('DAG run persistence is unavailable');
  }

  const serializedSnapshot = safeJSONStringify(record.snapshot, 'dagRunRepository.upsertDagRunSnapshot');
  //audit Assumption: DAG snapshots must remain JSON-serializable before writing to JSONB; failure risk: malformed snapshot payload prevents cross-instance inspection; expected invariant: snapshot is serialized to JSON; handling strategy: throw when serialization fails.
  if (!serializedSnapshot) {
    throw new Error('Failed to serialize DAG run snapshot');
  }

  await query(
    `INSERT INTO dag_runs (
       run_id,
       session_id,
       template,
       status,
       planner_node_id,
       root_node_id,
       snapshot,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)
     ON CONFLICT (run_id)
     DO UPDATE SET
       session_id = EXCLUDED.session_id,
       template = EXCLUDED.template,
       status = EXCLUDED.status,
       planner_node_id = EXCLUDED.planner_node_id,
       root_node_id = EXCLUDED.root_node_id,
       snapshot = EXCLUDED.snapshot,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
    [
      record.runId,
      record.sessionId,
      record.template,
      record.status,
      record.plannerNodeId,
      record.rootNodeId,
      serializedSnapshot,
      record.createdAt,
      record.updatedAt
    ]
  );
}

/**
 * Load one DAG verification snapshot by run id.
 * Purpose: let any app instance inspect a run created elsewhere.
 * Inputs/outputs: accepts a run id and returns the stored snapshot record or `null`.
 * Edge cases: returns `null` when persistence is unavailable or the run does not exist.
 */
export async function getDagRunSnapshotById(runId: string): Promise<DagRunSnapshotRecord | null> {
  const persistenceReady = await ensureDagRunPersistenceReady();
  //audit Assumption: missing persistence should degrade DAG inspection instead of throwing into every reader; failure risk: read endpoints hard-fail during transient DB outages; expected invariant: readers get `null` when persistence is unavailable; handling strategy: fail closed with `null`.
  if (!persistenceReady) {
    return null;
  }

  const result = await query(
    `SELECT
       run_id,
       session_id,
       template,
       status,
       planner_node_id,
       root_node_id,
       created_at,
       updated_at,
       snapshot
     FROM dag_runs
     WHERE run_id = $1
     LIMIT 1`,
    [runId]
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  const normalizedSnapshot = normalizeSnapshotObject(row.snapshot);
  if (!normalizedSnapshot) {
    return null;
  }

  return {
    runId: String(row.run_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    template: String(row.template ?? ''),
    status: String(row.status ?? ''),
    plannerNodeId: normalizeNullableString(row.planner_node_id),
    rootNodeId: normalizeNullableString(row.root_node_id),
    createdAt: normalizeIsoString(row.created_at),
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
      'dagRunRepository.normalizeSnapshotObject'
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

function normalizeIsoString(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}
