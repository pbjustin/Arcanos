/**
 * Canonical durable session storage service for ARCANOS.
 *
 * Purpose:
 * - Provide one explicit read/write/list/replay API over the durable PostgreSQL session store.
 */

import {
  createStoredSession,
  getStoredSessionByPayloadMemoryKey,
  getStoredSessionById,
  getStoredSessionVersion,
  listStoredSessions,
  type CreateStoredSessionInput,
  type StoredSessionRecord,
  type StoredSessionVersionRecord,
  type StoredSessionListResult
} from '@core/db/repositories/sessionRepository.js';

export interface StoredSession {
  id: string;
  label: string;
  tag: string | null;
  memoryType: string;
  payload: unknown;
  transcriptSummary: string | null;
  auditTraceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WriteSessionInput {
  label: string;
  tag?: string | null;
  memoryType: string;
  payload: unknown;
  transcriptSummary?: string | null;
  auditTraceId?: string | null;
}

export interface ListSessionsOptions {
  limit?: number;
  search?: string | null;
}

export interface FindSessionsOptions {
  limit?: number;
  search?: string | null;
  memoryType?: string | null;
}

export interface ListSessionsResult {
  items: Array<Pick<StoredSession, 'id' | 'label' | 'tag' | 'memoryType' | 'createdAt' | 'updatedAt'>>;
  total: number;
}

export interface ReplayedSession {
  sessionId: string;
  replayedVersion: number;
  mode: 'readonly';
  payload: unknown;
  auditTraceId: string | null;
  replayedAt: string;
}

function normalizeStoredSession(record: StoredSessionRecord): StoredSession {
  return {
    id: record.id,
    label: record.label,
    tag: record.tag,
    memoryType: record.memoryType,
    payload: record.payload,
    transcriptSummary: record.transcriptSummary,
    auditTraceId: record.auditTraceId,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString()
  };
}

function normalizeListSessionsResult(result: StoredSessionListResult): ListSessionsResult {
  return {
    items: result.items.map(item => ({
      id: item.id,
      label: item.label,
      tag: item.tag,
      memoryType: item.memoryType,
      createdAt: new Date(item.createdAt).toISOString(),
      updatedAt: new Date(item.updatedAt).toISOString()
    })),
    total: result.total
  };
}

function buildReplayedSession(
  currentSession: StoredSessionRecord,
  versionRecord: StoredSessionVersionRecord
): ReplayedSession {
  return {
    sessionId: currentSession.id,
    replayedVersion: versionRecord.versionNumber,
    mode: 'readonly',
    payload: versionRecord.payload,
    auditTraceId: currentSession.auditTraceId,
    replayedAt: new Date().toISOString()
  };
}

/**
 * Report the canonical session storage backend type.
 *
 * Purpose:
 * - Expose one stable backend label for diagnostics and verification output.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: fixed storage backend label.
 *
 * Edge case behavior:
 * - Always returns `postgres` because the public session API is DB-backed only.
 */
export function getSessionStorageBackendType(): 'postgres' {
  return 'postgres';
}

/**
 * Persist one new session into the durable session store.
 *
 * Purpose:
 * - Back the canonical session create flow with a stable storage abstraction.
 *
 * Inputs/outputs:
 * - Input: normalized public session payload.
 * - Output: stored session in the public API shape.
 *
 * Edge case behavior:
 * - Throws when the repository cannot commit the current row and version row atomically.
 */
export async function writeSession(input: WriteSessionInput): Promise<StoredSession> {
  const repositoryInput: CreateStoredSessionInput = {
    label: input.label,
    tag: input.tag,
    memoryType: input.memoryType,
    payload: input.payload,
    transcriptSummary: input.transcriptSummary,
    auditTraceId: input.auditTraceId
  };

  return normalizeStoredSession(await createStoredSession(repositoryInput));
}

/**
 * Load one durable session by UUID.
 *
 * Purpose:
 * - Provide a storage-backed read helper for the canonical public API.
 *
 * Inputs/outputs:
 * - Input: session UUID.
 * - Output: stored session or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when the session is absent or the repository is unavailable.
 */
export async function readSession(sessionId: string): Promise<StoredSession | null> {
  const storedSession = await getStoredSessionById(sessionId);
  return storedSession ? normalizeStoredSession(storedSession) : null;
}

/**
 * List durable sessions from the canonical store.
 *
 * Purpose:
 * - Back the public session list API with one explicit storage helper.
 *
 * Inputs/outputs:
 * - Input: optional bounded list filters.
 * - Output: list response with real stored rows and total count.
 *
 * Edge case behavior:
 * - Delegates limit clamping and search normalization to the repository.
 */
export async function listSessions(
  options: ListSessionsOptions = {}
): Promise<ListSessionsResult> {
  return normalizeListSessionsResult(
    await listStoredSessions({
      limit: options.limit,
      search: options.search
    })
  );
}

/**
 * Find durable sessions with full payload data.
 *
 * Purpose:
 * - Support internal reuse flows that need canonical session payloads without follow-up reads.
 *
 * Inputs/outputs:
 * - Input: optional bounded search criteria and exact memory-type filter.
 * - Output: normalized stored sessions including payload bodies.
 *
 * Edge case behavior:
 * - Returns an empty list when no durable sessions satisfy the requested filters.
 */
export async function findSessions(
  options: FindSessionsOptions = {}
): Promise<StoredSession[]> {
  const result = await listStoredSessions({
    limit: options.limit,
    search: options.search,
    memoryType: options.memoryType
  });

  return result.items.map(normalizeStoredSession);
}

/**
 * Load one durable session by the originating payload memory key.
 *
 * Purpose:
 * - Provide exact idempotency lookup for cross-store mirroring workflows.
 *
 * Inputs/outputs:
 * - Input: payload `memoryKey` plus optional exact `memoryType`.
 * - Output: stored session or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when no stored session references the requested payload memory key.
 */
export async function findSessionByMemoryKey(
  memoryKey: string,
  memoryType?: string | null
): Promise<StoredSession | null> {
  const storedSession = await getStoredSessionByPayloadMemoryKey(memoryKey, memoryType);
  return storedSession ? normalizeStoredSession(storedSession) : null;
}

/**
 * Replay one stored session version without mutating the durable record.
 *
 * Purpose:
 * - Rehydrate the stored historical payload into a readonly replay response.
 *
 * Inputs/outputs:
 * - Input: session UUID and optional version number.
 * - Output: readonly replay payload or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when either the current session metadata or the requested version is missing.
 */
export async function replaySession(
  sessionId: string,
  versionNumber?: number
): Promise<ReplayedSession | null> {
  const [currentSession, versionRecord] = await Promise.all([
    getStoredSessionById(sessionId),
    getStoredSessionVersion(sessionId, versionNumber)
  ]);

  //audit Assumption: replay responses must be anchored to both the current session metadata and an immutable historical version; failure risk: callers receive a payload without audit context or a version without a parent session; expected invariant: both records exist before replay succeeds; handling strategy: return `null` when either side is missing.
  if (!currentSession || !versionRecord) {
    return null;
  }

  return buildReplayedSession(currentSession, versionRecord);
}
