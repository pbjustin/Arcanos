/**
 * DAG Run Repository for ARCANOS
 *
 * Persists DAG verification snapshots so multi-instance deployments can inspect the same runs.
 */

import { getPool, initializeDatabase, isDatabaseConnected } from '@core/db/client.js';
import { query } from '@core/db/query.js';
import { initializeTables, isDatabaseSchemaReady } from '@core/db/schema.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';
import { safeJSONParse, safeJSONStringify } from '@shared/jsonHelpers.js';

export interface DagRunSnapshotRecord {
  runId: string;
  sessionId: string;
  template: string;
  status: string;
  snapshotGeneration: string;
  plannerNodeId: string | null;
  rootNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  snapshot: Record<string, unknown>;
}

export type DagRunSnapshotControlLookup =
  | { outcome: 'found'; record: DagRunSnapshotRecord }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' };

const DAG_RUN_REPOSITORY_WORKER_ID = 'dag-runs';
const DAG_RUN_BOOTSTRAP_RETRY_COOLDOWN_MS = 30_000;

let pendingBootstrap: Promise<boolean> | null = null;
let lastBootstrapFailureAtMs = 0;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function normalizeDagSnapshotGeneration(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)$/u.test(value)
  ) {
    throw new TypeError(
      'DAG snapshot generation must be a canonical non-negative decimal string.'
    );
  }

  if (value.length > 19) {
    throw new RangeError(
      'DAG snapshot generation exceeds the PostgreSQL BIGINT range.'
    );
  }

  const parsed = BigInt(value);
  if (parsed > POSTGRES_BIGINT_MAX) {
    throw new RangeError(
      'DAG snapshot generation exceeds the PostgreSQL BIGINT range.'
    );
  }

  return value;
}

/**
 * Ensure DAG run persistence can reach PostgreSQL.
 * Purpose: lazily bootstrap database access for DAG verification flows that execute outside normal startup ordering.
 * Inputs/outputs: no inputs, returns a readiness boolean.
 * Edge cases: throttles repeated failed initialization attempts with a cooldown.
 */
async function ensureDagRunPersistenceReady(): Promise<boolean> {
  //audit Assumption: DAG persistence is safe only after the exact current pool has completed shared schema initialization; failure risk: a connected replacement pool is mistaken for a schema-ready pool; expected invariant: the fast path requires current connectivity and central schema readiness; handling strategy: consult both shared states.
  if (isDatabaseConnected() && isDatabaseSchemaReady()) {
    return true;
  }

  //audit Assumption: concurrent persistence calls should share one bootstrap attempt even while a prior failure timestamp is still active; failure risk: followers fail closed instead of awaiting the active recovery; expected invariant: an in-flight bootstrap takes precedence over cooldown; handling strategy: reuse the pending promise first.
  if (pendingBootstrap) {
    return pendingBootstrap;
  }

  const nowMs = Date.now();
  const cooldownActive =
    lastBootstrapFailureAtMs > 0 &&
    nowMs - lastBootstrapFailureAtMs < DAG_RUN_BOOTSTRAP_RETRY_COOLDOWN_MS;

  //audit Assumption: repeated bootstrap failures should be rate-limited; failure risk: noisy retry storms under DB outage; expected invariant: retries respect cooldown; handling strategy: fail closed until cooldown expires.
  if (cooldownActive) {
    return false;
  }

  pendingBootstrap = (async () => {
    try {
      if (!isDatabaseConnected()) {
        await initializeDatabase(DAG_RUN_REPOSITORY_WORKER_ID);
      }

      if (!isDatabaseConnected()) {
        lastBootstrapFailureAtMs = Date.now();
        return false;
      }

      const bootstrapPool = getPool();
      if (!bootstrapPool) {
        lastBootstrapFailureAtMs = Date.now();
        return false;
      }

      const tablesInitialized = await initializeTables();
      const persistenceReady =
        tablesInitialized &&
        getPool() === bootstrapPool &&
        isDatabaseConnected() &&
        isDatabaseSchemaReady();
      if (!persistenceReady) {
        lastBootstrapFailureAtMs = Date.now();
        return false;
      }

      lastBootstrapFailureAtMs = 0;
      return true;
    } catch (error: unknown) {
      //audit Assumption: persistence bootstrap failures should not crash orchestration flows; failure risk: DAG execution fails solely due to observability storage; expected invariant: callers receive boolean readiness; handling strategy: warn and fail closed.
      lastBootstrapFailureAtMs = Date.now();
      console.warn('[DAG Runs] Failed to initialize database persistence:', resolveErrorMessage(error));
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
export async function upsertDagRunSnapshot(
  record: DagRunSnapshotRecord
): Promise<boolean> {
  const persistenceReady = await ensureDagRunPersistenceReady();
  if (!persistenceReady) {
    throw new Error('DAG run persistence is unavailable');
  }

  const serializedSnapshot = safeJSONStringify(record.snapshot, 'dagRunRepository.upsertDagRunSnapshot');
  //audit Assumption: DAG snapshots must remain JSON-serializable before writing to JSONB; failure risk: malformed snapshot payload prevents cross-instance inspection; expected invariant: snapshot is serialized to JSON; handling strategy: throw when serialization fails.
  if (!serializedSnapshot) {
    throw new Error('Failed to serialize DAG run snapshot');
  }
  const snapshotGeneration = normalizeDagSnapshotGeneration(
    record.snapshotGeneration
  );

  const result = await query(
    `INSERT INTO dag_runs (
       run_id,
       session_id,
       template,
       status,
       planner_node_id,
       root_node_id,
       snapshot_generation,
       snapshot,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::jsonb, $9::timestamptz, $10::timestamptz)
     ON CONFLICT (run_id)
     DO UPDATE SET
       session_id = EXCLUDED.session_id,
       template = EXCLUDED.template,
       status = EXCLUDED.status,
       planner_node_id = EXCLUDED.planner_node_id,
       root_node_id = EXCLUDED.root_node_id,
       snapshot_generation = EXCLUDED.snapshot_generation,
       snapshot = EXCLUDED.snapshot,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at
     WHERE dag_runs.snapshot_generation < EXCLUDED.snapshot_generation
     RETURNING run_id`,
    [
      record.runId,
      record.sessionId,
      record.template,
      record.status,
      record.plannerNodeId,
      record.rootNodeId,
      snapshotGeneration,
      serializedSnapshot,
      record.createdAt,
      record.updatedAt
    ]
  );

  return result.rows.length === 1;
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
       snapshot_generation::text AS snapshot_generation,
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
  const snapshotGeneration = normalizePersistedSnapshotGeneration(
    row.snapshot_generation
  );
  if (!normalizedSnapshot || !snapshotGeneration) {
    return null;
  }

  return {
    runId: String(row.run_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    template: String(row.template ?? ''),
    status: String(row.status ?? ''),
    snapshotGeneration,
    plannerNodeId: normalizeNullableString(row.planner_node_id),
    rootNodeId: normalizeNullableString(row.root_node_id),
    createdAt: normalizeIsoString(row.created_at),
    updatedAt: normalizeIsoString(row.updated_at),
    snapshot: normalizedSnapshot
  };
}

/**
 * Load one DAG snapshot for a lifecycle-changing control decision.
 *
 * Unlike the inspection reader, this path preserves the distinction between a
 * confirmed miss, unavailable persistence, and an invalid/mismatched row.
 */
export async function lookupDagRunSnapshotForControl(
  runId: string
): Promise<DagRunSnapshotControlLookup> {
  const persistenceReady = await ensureDagRunPersistenceReady();
  if (!persistenceReady) {
    return { outcome: 'unavailable' };
  }

  let row: Record<string, unknown> | undefined;
  try {
    const result = await query(
      `SELECT
         run_id,
         session_id,
         template,
         status,
         planner_node_id,
         root_node_id,
         snapshot_generation::text AS snapshot_generation,
         created_at,
         updated_at,
         snapshot
       FROM dag_runs
       WHERE run_id = $1
       LIMIT 1`,
      [runId]
    );
    row = result.rows[0] as Record<string, unknown> | undefined;
  } catch {
    return { outcome: 'unavailable' };
  }

  if (!row) {
    return { outcome: 'not_found' };
  }

  const normalizedSnapshot = normalizeSnapshotObject(row.snapshot);
  const snapshotGeneration = normalizePersistedSnapshotGeneration(
    row.snapshot_generation
  );
  if (!normalizedSnapshot || !snapshotGeneration) {
    return { outcome: 'invalid' };
  }

  const record: DagRunSnapshotRecord = {
    runId: String(row.run_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    template: String(row.template ?? ''),
    status: String(row.status ?? ''),
    snapshotGeneration,
    plannerNodeId: normalizeNullableString(row.planner_node_id),
    rootNodeId: normalizeNullableString(row.root_node_id),
    createdAt: normalizeIsoString(row.created_at),
    updatedAt: normalizeIsoString(row.updated_at),
    snapshot: normalizedSnapshot
  };
  const snapshotRunId = normalizedSnapshot.runId;
  const snapshotSessionId = normalizedSnapshot.sessionId;
  const snapshotTemplate = normalizedSnapshot.template;
  const snapshotStatus = normalizedSnapshot.status;
  const knownStatuses = new Set([
    'queued',
    'running',
    'complete',
    'failed',
    'cancelled'
  ]);

  //audit Assumption: lifecycle mutation must be based on one internally consistent persisted identity; failure risk: a denormalized row can authorize cancellation for a different or corrupt snapshot; expected invariant: requested id, row identity, snapshot identity, and status agree; handling strategy: reject mismatches as invalid instead of collapsing them into absence.
  if (
    record.runId !== runId ||
    snapshotRunId !== record.runId ||
    snapshotSessionId !== record.sessionId ||
    snapshotTemplate !== record.template ||
    snapshotStatus !== record.status ||
    !knownStatuses.has(record.status)
  ) {
    return { outcome: 'invalid' };
  }

  return {
    outcome: 'found',
    record
  };
}

/**
 * Load the most recently updated DAG verification snapshot.
 * Purpose: support bounded "latest run" inspection without requiring callers to scan or guess run ids.
 * Inputs/outputs: optional session id filter; returns the newest stored snapshot record or `null`.
 * Edge cases: returns `null` when persistence is unavailable or no matching runs exist.
 */
export async function getLatestDagRunSnapshot(
  sessionId?: string
): Promise<DagRunSnapshotRecord | null> {
  const persistenceReady = await ensureDagRunPersistenceReady();
  if (!persistenceReady) {
    return null;
  }

  const normalizedSessionId =
    typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
  const result = normalizedSessionId
    ? await query(
        `SELECT
           run_id,
           session_id,
           template,
           status,
           planner_node_id,
           root_node_id,
           snapshot_generation::text AS snapshot_generation,
           created_at,
           updated_at,
           snapshot
         FROM dag_runs
         WHERE session_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [normalizedSessionId]
      )
    : await query(
        `SELECT
           run_id,
           session_id,
           template,
           status,
           planner_node_id,
           root_node_id,
           snapshot_generation::text AS snapshot_generation,
           created_at,
           updated_at,
           snapshot
         FROM dag_runs
         ORDER BY updated_at DESC
         LIMIT 1`
      );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  const normalizedSnapshot = normalizeSnapshotObject(row.snapshot);
  const snapshotGeneration = normalizePersistedSnapshotGeneration(
    row.snapshot_generation
  );
  if (!normalizedSnapshot || !snapshotGeneration) {
    return null;
  }

  return {
    runId: String(row.run_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    template: String(row.template ?? ''),
    status: String(row.status ?? ''),
    snapshotGeneration,
    plannerNodeId: normalizeNullableString(row.planner_node_id),
    rootNodeId: normalizeNullableString(row.root_node_id),
    createdAt: normalizeIsoString(row.created_at),
    updatedAt: normalizeIsoString(row.updated_at),
    snapshot: normalizedSnapshot
  };
}

function normalizePersistedSnapshotGeneration(value: unknown): string | null {
  try {
    return normalizeDagSnapshotGeneration(value);
  } catch {
    return null;
  }
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
