/**
 * Session Repository for ARCANOS
 *
 * Persists the canonical public session API in PostgreSQL with immutable version history.
 */

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { initializeDatabase, isDatabaseConnected } from '@core/db/client.js';
import { query, transaction } from '@core/db/query.js';
import { initializeTables } from '@core/db/schema.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';

const SESSION_REPOSITORY_WORKER_ID = 'session-repository';
const SESSION_BOOTSTRAP_RETRY_COOLDOWN_MS = 30_000;

let pendingBootstrap: Promise<boolean> | null = null;
let sessionSchemaReady = false;
let lastBootstrapFailureAtMs = 0;

interface SessionRow {
  id: string;
  label: string;
  tag: string | null;
  memory_type: string;
  payload: unknown;
  transcript_summary: string | null;
  audit_trace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionVersionRow {
  id: string;
  session_id: string;
  version_number: number;
  payload: unknown;
  created_at: string;
}

interface SessionListRow extends SessionRow {
  latest_version_number: number;
}

interface CountRow {
  total: string;
}

interface StorageCountRow {
  session_count: string;
  version_count: string;
}

export interface CreateStoredSessionInput {
  id?: string;
  label: string;
  tag?: string | null;
  memoryType: string;
  payload: unknown;
  transcriptSummary?: string | null;
  auditTraceId?: string | null;
}

export interface StoredSessionRecord {
  id: string;
  label: string;
  tag: string | null;
  memoryType: string;
  payload: unknown;
  transcriptSummary: string | null;
  auditTraceId: string | null;
  createdAt: string;
  updatedAt: string;
  latestVersionNumber: number;
}

export interface StoredSessionVersionRecord {
  id: string;
  sessionId: string;
  versionNumber: number;
  payload: unknown;
  createdAt: string;
}

export interface StoredSessionListOptions {
  limit?: number;
  search?: string | null;
}

export interface StoredSessionListResult {
  items: StoredSessionRecord[];
  total: number;
}

export interface SessionStorageMetrics {
  status: 'live' | 'offline';
  storage: 'postgres';
  sessionCount: number;
  versionCount: number;
  databaseConnected: boolean;
  timestamp: string;
}

/**
 * Ensure the canonical session repository can reach PostgreSQL and that schema DDL has run.
 *
 * Purpose:
 * - Lazily bootstrap durable session persistence for HTTP routes, diagnostics, and integration tests.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: readiness boolean for session persistence.
 *
 * Edge case behavior:
 * - Repeated bootstrap failures are throttled with a cooldown to avoid request-time retry storms.
 */
async function ensureSessionPersistenceReady(): Promise<boolean> {
  //audit Assumption: once the DB is connected and schema initialization has completed, session persistence can proceed without repeated bootstrap work; failure risk: each request re-runs schema DDL and adds latency; expected invariant: a ready repository exits fast; handling strategy: short-circuit on connected + schema-ready state.
  if (isDatabaseConnected() && sessionSchemaReady) {
    return true;
  }

  const nowMs = Date.now();
  const cooldownActive =
    lastBootstrapFailureAtMs > 0 &&
    nowMs - lastBootstrapFailureAtMs < SESSION_BOOTSTRAP_RETRY_COOLDOWN_MS;

  //audit Assumption: repeated bootstrap failures should fail closed briefly instead of hammering the database; failure risk: request amplification during outages; expected invariant: retries respect the cooldown window; handling strategy: return false until the cooldown expires.
  if (cooldownActive) {
    return false;
  }

  //audit Assumption: concurrent requests should share one bootstrap attempt; failure risk: duplicate pool initialization and DDL races; expected invariant: at most one bootstrap promise is active; handling strategy: reuse the in-flight promise.
  if (pendingBootstrap) {
    return pendingBootstrap;
  }

  pendingBootstrap = (async () => {
    try {
      if (!isDatabaseConnected()) {
        const connected = await initializeDatabase(SESSION_REPOSITORY_WORKER_ID);
        if (!connected || !isDatabaseConnected()) {
          lastBootstrapFailureAtMs = Date.now();
          return false;
        }
      }

      await initializeTables();
      sessionSchemaReady = true;
      lastBootstrapFailureAtMs = 0;
      return true;
    } catch (error: unknown) {
      //audit Assumption: bootstrap failures must remain explicit and should not silently downgrade to memory-only state; failure risk: callers believe data is durable when it is not; expected invariant: readiness returns false on failure; handling strategy: warn and fail closed.
      sessionSchemaReady = false;
      lastBootstrapFailureAtMs = Date.now();
      console.warn('[Sessions] Failed to initialize persistent session storage:', resolveErrorMessage(error));
      return false;
    } finally {
      pendingBootstrap = null;
    }
  })();

  return pendingBootstrap;
}

function normalizeStoredSessionRecord(row: SessionListRow): StoredSessionRecord {
  return {
    id: row.id,
    label: row.label,
    tag: row.tag,
    memoryType: row.memory_type,
    payload: row.payload,
    transcriptSummary: row.transcript_summary,
    auditTraceId: row.audit_trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestVersionNumber: row.latest_version_number
  };
}

function normalizeStoredSessionVersionRecord(row: SessionVersionRow): StoredSessionVersionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    versionNumber: row.version_number,
    payload: row.payload,
    createdAt: row.created_at
  };
}

function normalizeBoundedLimit(limit?: number): number {
  if (!Number.isInteger(limit) || !limit || limit <= 0) {
    return 25;
  }

  return Math.min(limit, 100);
}

function normalizeSearch(search?: string | null): string | null {
  if (typeof search !== 'string') {
    return null;
  }

  const normalized = search.trim();
  return normalized.length > 0 ? normalized : null;
}

function ensureJsonbSerializable(value: unknown, context: string): string {
  const serialized = safeJSONStringify(value, context);

  //audit Assumption: JSONB columns require serializable payloads; failure risk: partial transaction writes or opaque Postgres serialization failures; expected invariant: payloads stringify before insert; handling strategy: throw an explicit error when serialization fails.
  if (!serialized) {
    throw new Error(`Failed to serialize JSON payload for ${context}`);
  }

  return serialized;
}

async function resolveNextSessionVersionNumber(
  client: PoolClient,
  sessionId: string
): Promise<number> {
  const result = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
     FROM session_versions
     WHERE session_id = $1`,
    [sessionId]
  );

  return result.rows[0]?.next_version ?? 1;
}

/**
 * Create one durable session row and its initial immutable version snapshot.
 *
 * Purpose:
 * - Provide the canonical storage-backed session create operation for the public API.
 *
 * Inputs/outputs:
 * - Input: normalized session create payload.
 * - Output: created current-session row with latest version metadata.
 *
 * Edge case behavior:
 * - Creates both `sessions` and `session_versions` inside one transaction so partial saves cannot commit.
 */
export async function createStoredSession(
  input: CreateStoredSessionInput
): Promise<StoredSessionRecord> {
  const persistenceReady = await ensureSessionPersistenceReady();
  if (!persistenceReady) {
    throw new Error('Persistent session storage is unavailable');
  }

  const sessionId = input.id ?? crypto.randomUUID();
  const serializedPayload = ensureJsonbSerializable(
    input.payload,
    'sessionRepository.createStoredSession.payload'
  );

  return transaction(async client => {
    const nextVersionNumber = await resolveNextSessionVersionNumber(client, sessionId);

    //audit Assumption: the public session create API must either persist both the current row and the immutable version row or fail atomically; failure risk: replay reads diverge from current session reads after a partial write; expected invariant: both tables commit together; handling strategy: execute both inserts inside one transaction.
    const sessionResult = await client.query<SessionListRow>(
      `INSERT INTO sessions (
         id,
         label,
         tag,
         memory_type,
         payload,
         transcript_summary,
         audit_trace_id,
         created_at,
         updated_at
       )
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, NOW(), NOW())
       RETURNING
         id,
         label,
         tag,
         memory_type,
         payload,
         transcript_summary,
         audit_trace_id,
         created_at::text,
         updated_at::text,
         $8::integer AS latest_version_number`,
      [
        sessionId,
        input.label,
        input.tag ?? null,
        input.memoryType,
        serializedPayload,
        input.transcriptSummary ?? null,
        input.auditTraceId ?? null,
        nextVersionNumber
      ]
    );

    await client.query(
      `INSERT INTO session_versions (
         id,
         session_id,
         version_number,
         payload,
         created_at
       )
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NOW())`,
      [
        crypto.randomUUID(),
        sessionId,
        nextVersionNumber,
        serializedPayload
      ]
    );

    const createdSession = sessionResult.rows[0];
    if (!createdSession) {
      throw new Error('Session insert returned no row');
    }

    return normalizeStoredSessionRecord(createdSession);
  });
}

/**
 * Load one canonical stored session by UUID.
 *
 * Purpose:
 * - Back `GET /api/sessions/:id` with durable PostgreSQL state instead of memory-only cache views.
 *
 * Inputs/outputs:
 * - Input: session UUID.
 * - Output: stored session record or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when storage is unavailable or the session does not exist.
 */
export async function getStoredSessionById(sessionId: string): Promise<StoredSessionRecord | null> {
  const persistenceReady = await ensureSessionPersistenceReady();

  //audit Assumption: callers need an explicit null when storage is unavailable or a row is missing; failure risk: route handlers fabricate session data; expected invariant: repository only returns DB-backed rows; handling strategy: fail closed with `null`.
  if (!persistenceReady) {
    return null;
  }

  const result = await query(
    `SELECT
       sessions.id,
       sessions.label,
       sessions.tag,
       sessions.memory_type,
       sessions.payload,
       sessions.transcript_summary,
       sessions.audit_trace_id,
       sessions.created_at::text,
       sessions.updated_at::text,
       COALESCE(MAX(session_versions.version_number), 0)::integer AS latest_version_number
     FROM sessions
     LEFT JOIN session_versions
       ON session_versions.session_id = sessions.id
     WHERE sessions.id = $1::uuid
     GROUP BY sessions.id
     LIMIT 1`,
    [sessionId]
  );

  const row = result.rows[0] as SessionListRow | undefined;
  return row ? normalizeStoredSessionRecord(row) : null;
}

/**
 * List stored sessions directly from PostgreSQL.
 *
 * Purpose:
 * - Back the canonical `GET /api/sessions` list endpoint with real durable rows and total counts.
 *
 * Inputs/outputs:
 * - Input: optional limit and search string.
 * - Output: paged list result with total count.
 *
 * Edge case behavior:
 * - Search matches `id`, `label`, `tag`, `memory_type`, `transcript_summary`, and serialized `payload` using case-insensitive LIKE filters.
 */
export async function listStoredSessions(
  options: StoredSessionListOptions = {}
): Promise<StoredSessionListResult> {
  const persistenceReady = await ensureSessionPersistenceReady();
  if (!persistenceReady) {
    throw new Error('Persistent session storage is unavailable');
  }

  const limit = normalizeBoundedLimit(options.limit);
  const search = normalizeSearch(options.search);
  const searchPattern = search ? `%${search}%` : null;

  const [itemsResult, countResult] = await Promise.all([
    query(
      `SELECT
         sessions.id,
         sessions.label,
         sessions.tag,
         sessions.memory_type,
         sessions.payload,
         sessions.transcript_summary,
         sessions.audit_trace_id,
         sessions.created_at::text,
         sessions.updated_at::text,
         COALESCE(MAX(session_versions.version_number), 0)::integer AS latest_version_number
       FROM sessions
       LEFT JOIN session_versions
         ON session_versions.session_id = sessions.id
       WHERE
         $1::text IS NULL
         OR sessions.id::text ILIKE $1
         OR sessions.label ILIKE $1
         OR COALESCE(sessions.tag, '') ILIKE $1
         OR sessions.memory_type ILIKE $1
         OR COALESCE(sessions.transcript_summary, '') ILIKE $1
         OR sessions.payload::text ILIKE $1
       GROUP BY sessions.id
       ORDER BY sessions.updated_at DESC
       LIMIT $2`,
      [searchPattern, limit]
    ),
    query(
      `SELECT COUNT(*)::text AS total
       FROM sessions
       WHERE
         $1::text IS NULL
         OR id::text ILIKE $1
         OR label ILIKE $1
         OR COALESCE(tag, '') ILIKE $1
         OR memory_type ILIKE $1
         OR COALESCE(transcript_summary, '') ILIKE $1
         OR payload::text ILIKE $1`,
      [searchPattern]
    )
  ]);

  return {
    items: itemsResult.rows.map(row => normalizeStoredSessionRecord(row as SessionListRow)),
    total: Number(countResult.rows[0]?.total ?? 0)
  };
}

/**
 * Load one immutable session version for replay/restore requests.
 *
 * Purpose:
 * - Provide historical payload reads for the canonical replay endpoint.
 *
 * Inputs/outputs:
 * - Input: session UUID and optional version number.
 * - Output: requested version row, or the latest version when unspecified.
 *
 * Edge case behavior:
 * - Returns `null` when the version or session does not exist.
 */
export async function getStoredSessionVersion(
  sessionId: string,
  versionNumber?: number
): Promise<StoredSessionVersionRecord | null> {
  const persistenceReady = await ensureSessionPersistenceReady();
  if (!persistenceReady) {
    return null;
  }

  const result = versionNumber && versionNumber > 0
    ? await query(
        `SELECT
           id,
           session_id,
           version_number,
           payload,
           created_at::text
         FROM session_versions
         WHERE session_id = $1::uuid AND version_number = $2
         LIMIT 1`,
        [sessionId, versionNumber]
      )
    : await query(
        `SELECT
           id,
           session_id,
           version_number,
           payload,
           created_at::text
         FROM session_versions
         WHERE session_id = $1::uuid
         ORDER BY version_number DESC
         LIMIT 1`,
        [sessionId]
      );

  const row = result.rows[0] as SessionVersionRow | undefined;
  return row ? normalizeStoredSessionVersionRecord(row) : null;
}

/**
 * Report storage metrics for the canonical session API.
 *
 * Purpose:
 * - Back machine-verifiable diagnostics with direct PostgreSQL counts.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: storage health snapshot with session/version counts.
 *
 * Edge case behavior:
 * - Returns `offline` metrics when the repository cannot reach PostgreSQL.
 */
export async function getSessionStorageMetrics(): Promise<SessionStorageMetrics> {
  const persistenceReady = await ensureSessionPersistenceReady();
  const timestamp = new Date().toISOString();

  //audit Assumption: diagnostics must not fabricate live storage counts when the database is unavailable; failure risk: infrastructure probes report healthy persistence during an outage; expected invariant: offline storage reports zero counts and `databaseConnected=false`; handling strategy: return an explicit offline snapshot.
  if (!persistenceReady) {
    return {
      status: 'offline',
      storage: 'postgres',
      sessionCount: 0,
      versionCount: 0,
      databaseConnected: false,
      timestamp
    };
  }

  try {
    const result = await query(
      `SELECT
         (SELECT COUNT(*)::text FROM sessions) AS session_count,
         (SELECT COUNT(*)::text FROM session_versions) AS version_count`
    );
    const row = (result.rows[0] as StorageCountRow | undefined) ?? {
      session_count: '0',
      version_count: '0'
    };

    return {
      status: 'live',
      storage: 'postgres',
      sessionCount: Number(row.session_count),
      versionCount: Number(row.version_count),
      databaseConnected: true,
      timestamp
    };
  } catch (error: unknown) {
    //audit Assumption: diagnostics must fail closed when counting rows fails; failure risk: stale counts are interpreted as current truth; expected invariant: storage status falls back to offline on count failure; handling strategy: log and return offline metrics.
    console.warn('[Sessions] Failed to query session storage metrics:', resolveErrorMessage(error));
    return {
      status: 'offline',
      storage: 'postgres',
      sessionCount: 0,
      versionCount: 0,
      databaseConnected: false,
      timestamp
    };
  }
}
