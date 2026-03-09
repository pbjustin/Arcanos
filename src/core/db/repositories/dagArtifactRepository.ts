/**
 * DAG Artifact Repository for ARCANOS
 *
 * Persists DAG artifact payloads so API and worker services can share artifact-backed DAG state.
 */

import { initializeDatabase, isDatabaseConnected } from '@core/db/client.js';
import { query } from '@core/db/query.js';
import { initializeTables } from '@core/db/schema.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';

export interface DagArtifactRecord {
  artifactReference: string;
  runId: string;
  nodeId: string;
  attempt: number;
  artifactKind: string;
  payload: unknown;
  createdAt: string;
}

const DAG_ARTIFACT_REPOSITORY_WORKER_ID = 'dag-artifacts';
const DAG_ARTIFACT_BOOTSTRAP_RETRY_COOLDOWN_MS = 30_000;

let pendingBootstrap: Promise<boolean> | null = null;
let lastBootstrapFailureAtMs = 0;

/**
 * Ensure DAG artifact persistence can reach PostgreSQL.
 * Purpose: lazily bootstrap shared artifact storage for multi-service DAG execution.
 * Inputs/outputs: no inputs, returns a readiness boolean.
 * Edge case behavior: throttles repeated failed initialization attempts with a cooldown.
 */
async function ensureDagArtifactPersistenceReady(): Promise<boolean> {
  //audit Assumption: an active database connection means artifact persistence can proceed immediately; failure risk: redundant bootstrap attempts add latency and noise; expected invariant: connected DB returns fast; handling strategy: short-circuit when already connected.
  if (isDatabaseConnected()) {
    return true;
  }

  const nowMs = Date.now();
  const cooldownActive =
    lastBootstrapFailureAtMs > 0 &&
    nowMs - lastBootstrapFailureAtMs < DAG_ARTIFACT_BOOTSTRAP_RETRY_COOLDOWN_MS;

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
      const connected = await initializeDatabase(DAG_ARTIFACT_REPOSITORY_WORKER_ID);
      if (!connected || !isDatabaseConnected()) {
        lastBootstrapFailureAtMs = Date.now();
        return false;
      }

      await initializeTables();
      lastBootstrapFailureAtMs = 0;
      return true;
    } catch (error: unknown) {
      //audit Assumption: artifact bootstrap failures should not crash unrelated startup work; failure risk: DAG execution fails before service health settles; expected invariant: callers receive boolean readiness; handling strategy: warn and fail closed.
      lastBootstrapFailureAtMs = Date.now();
      console.warn('[DAG Artifacts] Failed to initialize database persistence:', resolveErrorMessage(error));
      return false;
    } finally {
      pendingBootstrap = null;
    }
  })();

  return pendingBootstrap;
}

/**
 * Persist one DAG artifact payload by stable reference.
 * Purpose: store queue-offloaded dependency payloads in shared PostgreSQL storage.
 * Inputs/outputs: accepts one normalized artifact record and upserts it into PostgreSQL.
 * Edge case behavior: throws when persistence is unavailable or the payload is not JSON-serializable.
 */
export async function upsertDagArtifact(record: DagArtifactRecord): Promise<void> {
  const persistenceReady = await ensureDagArtifactPersistenceReady();
  if (!persistenceReady) {
    throw new Error('DAG artifact persistence is unavailable');
  }

  const serializedPayload = safeJSONStringify(record.payload, 'dagArtifactRepository.upsertDagArtifact');

  //audit Assumption: artifact payloads must remain JSON-serializable before writing to JSONB; failure risk: malformed dependency payloads break distributed DAG hydration; expected invariant: payload serializes to JSON; handling strategy: throw when serialization fails.
  if (serializedPayload === null) {
    throw new Error(`Failed to serialize DAG artifact "${record.artifactReference}"`);
  }

  await query(
    `INSERT INTO dag_artifacts (
       artifact_ref,
       run_id,
       node_id,
       attempt,
       artifact_kind,
       payload,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
     ON CONFLICT (artifact_ref)
     DO UPDATE SET
       run_id = EXCLUDED.run_id,
       node_id = EXCLUDED.node_id,
       attempt = EXCLUDED.attempt,
       artifact_kind = EXCLUDED.artifact_kind,
       payload = EXCLUDED.payload,
       updated_at = EXCLUDED.updated_at`,
    [
      record.artifactReference,
      record.runId,
      record.nodeId,
      record.attempt,
      record.artifactKind,
      serializedPayload,
      record.createdAt,
      record.createdAt
    ]
  );
}

/**
 * Load one DAG artifact payload by reference.
 * Purpose: hydrate artifact-backed dependency payloads across Railway services.
 * Inputs/outputs: accepts one artifact reference and returns the stored payload or `null`.
 * Edge case behavior: returns `null` when persistence is unavailable or the artifact is missing.
 */
export async function getDagArtifactPayloadByReference(
  artifactReference: string
): Promise<unknown | null> {
  const persistenceReady = await ensureDagArtifactPersistenceReady();

  //audit Assumption: missing persistence should degrade to a cache miss instead of crashing all readers; failure risk: transient DB outages surface as broad worker crashes; expected invariant: callers can distinguish missing payloads from valid data; handling strategy: fail closed with `null`.
  if (!persistenceReady) {
    return null;
  }

  const result = await query(
    `SELECT payload
     FROM dag_artifacts
     WHERE artifact_ref = $1
     LIMIT 1`,
    [artifactReference]
  );

  const row = result.rows[0] as { payload?: unknown } | undefined;
  if (!row || !('payload' in row)) {
    return null;
  }

  return row.payload ?? null;
}
