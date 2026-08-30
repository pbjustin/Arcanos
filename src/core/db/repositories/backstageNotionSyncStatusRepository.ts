import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES,
  BACKSTAGE_NOTION_SYNC_FAILURE_PHASES,
  BACKSTAGE_NOTION_SYNC_FAILURE_REASONS,
  type BackstageNotionLatestSyncAttemptState,
  type BackstageNotionSyncAttemptOutcome,
  type BackstageNotionSyncFailurePhase,
  type BackstageNotionSyncFailureReason,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';
import { getPool } from '../client.js';

const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAXIMUM_BOUNDED_SYNC_COUNT = 1_000_000;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const OUTCOMES = new Set<string>(BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES);
const FAILURE_PHASES = new Set<string>(BACKSTAGE_NOTION_SYNC_FAILURE_PHASES);
const FAILURE_REASONS = new Set<string>(BACKSTAGE_NOTION_SYNC_FAILURE_REASONS);

type TimestampValue = Date | string;

export interface BackstageNotionSyncAttemptDiagnosticsState {
  pagesDiscovered: number;
  pagesFetched: number;
  blocksFetched: number;
  chunksProduced: number;
  chunksEmbedded: number;
  candidateSnapshotCreated: boolean;
  candidateSnapshotValidated: boolean;
  candidateSnapshotActivated: boolean;
}

export interface BackstageNotionSyncAttemptRecord
  extends BackstageNotionLatestSyncAttemptState,
  BackstageNotionSyncAttemptDiagnosticsState {
  universeId: string;
  generation: string;
}

export interface BeginBackstageNotionSyncAttemptInput {
  universeId: string;
  lease: {
    holderId: string;
    leaseToken: string;
  };
}

export interface CompleteBackstageNotionSyncAttemptInput
  extends BackstageNotionSyncAttemptDiagnosticsState {
  universeId: string;
  attemptId: string;
  generation: string;
  outcome: Exclude<BackstageNotionSyncAttemptOutcome, 'running'>;
  failurePhase: BackstageNotionSyncFailurePhase | null;
  failureReason: BackstageNotionSyncFailureReason | null;
  activatedSnapshotId: string | null;
}

export interface BackstageNotionSyncStatusRepository {
  beginSyncAttempt(
    input: BeginBackstageNotionSyncAttemptInput
  ): Promise<BackstageNotionSyncAttemptRecord>;
  completeSyncAttempt(
    input: CompleteBackstageNotionSyncAttemptInput
  ): Promise<BackstageNotionSyncAttemptRecord | null>;
  loadLatestSyncAttempt(
    universeId: string
  ): Promise<BackstageNotionSyncAttemptRecord | null>;
}

interface SyncAttemptRow {
  universe_id: string;
  attempt_id: string;
  attempt_generation: number | string;
  started_at: TimestampValue;
  completed_at: TimestampValue | null;
  outcome: string;
  failure_phase: string | null;
  failure_reason: string | null;
  pages_discovered: number | string;
  pages_fetched: number | string;
  blocks_fetched: number | string;
  chunks_produced: number | string;
  chunks_embedded: number | string;
  candidate_snapshot_created: boolean;
  candidate_snapshot_validated: boolean;
  candidate_snapshot_activated: boolean;
  activated_snapshot_id: string | null;
}

export class BackstageNotionSyncStatusLeaseError extends Error {
  constructor() {
    super('The Backstage Notion sync attempt is not protected by the current lease.');
    this.name = 'BackstageNotionSyncStatusLeaseError';
  }
}

export class BackstageNotionSyncStatusRepositoryUnavailableError extends Error {
  constructor() {
    super('The Backstage Notion sync-status repository is unavailable.');
    this.name = 'BackstageNotionSyncStatusRepositoryUnavailableError';
  }
}

function requireUniverseId(value: string): string {
  if (!UNIVERSE_ID_PATTERN.test(value)) {
    throw new TypeError('universeId is invalid.');
  }
  return value;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requireGeneration(value: string): string {
  if (
    !/^[1-9]\d{0,18}$/u.test(value)
    || BigInt(value) > POSTGRES_BIGINT_MAX
  ) {
    throw new TypeError('generation is invalid.');
  }
  return value;
}

function requireBoundedCount(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAXIMUM_BOUNDED_SYNC_COUNT
  ) {
    throw new TypeError(`${label} is outside its bounded range.`);
  }
  return value;
}

function parseBoundedCount(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return requireBoundedCount(parsed, label);
}

function parseDate(value: TimestampValue, label: string): Date {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function mapAttempt(row: SyncAttemptRow): BackstageNotionSyncAttemptRecord {
  if (!OUTCOMES.has(row.outcome)) {
    throw new Error('Stored Backstage Notion sync outcome is unsupported.');
  }
  const outcome = row.outcome as BackstageNotionSyncAttemptOutcome;
  const failurePhase = row.failure_phase === null
    ? null
    : FAILURE_PHASES.has(row.failure_phase)
      ? row.failure_phase as BackstageNotionSyncFailurePhase
      : null;
  const failureReason = row.failure_reason === null
    ? null
    : FAILURE_REASONS.has(row.failure_reason)
      ? row.failure_reason as BackstageNotionSyncFailureReason
      : null;
  if (
    (row.failure_phase !== null && failurePhase === null)
    || (row.failure_reason !== null && failureReason === null)
    || (outcome === 'failed' && (!failurePhase || !failureReason))
    || (outcome !== 'failed' && (failurePhase !== null || failureReason !== null))
  ) {
    throw new Error('Stored Backstage Notion sync failure state is inconsistent.');
  }
  const startedAt = parseDate(row.started_at, 'started_at');
  const completedAt = row.completed_at === null
    ? null
    : parseDate(row.completed_at, 'completed_at');
  const candidateSnapshotCreated = requireBoolean(
    row.candidate_snapshot_created,
    'candidate_snapshot_created'
  );
  const candidateSnapshotValidated = requireBoolean(
    row.candidate_snapshot_validated,
    'candidate_snapshot_validated'
  );
  const candidateSnapshotActivated = requireBoolean(
    row.candidate_snapshot_activated,
    'candidate_snapshot_activated'
  );
  const activatedSnapshotId = row.activated_snapshot_id === null
    ? null
    : requireUuid(row.activated_snapshot_id, 'activated_snapshot_id');
  const stateIsConsistent = completedAt === null
    ? outcome === 'running'
      && activatedSnapshotId === null
      && !candidateSnapshotCreated
      && !candidateSnapshotValidated
      && !candidateSnapshotActivated
    : completedAt.getTime() >= startedAt.getTime()
      && outcome !== 'running'
      && (outcome === 'failed'
        ? activatedSnapshotId === null && !candidateSnapshotActivated
        : activatedSnapshotId !== null
          && (outcome === 'activated'
            ? candidateSnapshotCreated
              && candidateSnapshotValidated
              && candidateSnapshotActivated
            : !candidateSnapshotCreated
              && !candidateSnapshotValidated
              && !candidateSnapshotActivated));
  if (
    !stateIsConsistent
    || (candidateSnapshotValidated && !candidateSnapshotCreated)
    || (candidateSnapshotActivated && !candidateSnapshotValidated)
  ) {
    throw new Error('Stored Backstage Notion sync completion state is inconsistent.');
  }
  return {
    universeId: requireUniverseId(row.universe_id),
    attemptId: requireUuid(row.attempt_id, 'attempt_id'),
    generation: requireGeneration(String(row.attempt_generation)),
    startedAt,
    completedAt,
    outcome,
    failurePhase,
    failureReason,
    pagesDiscovered: parseBoundedCount(row.pages_discovered, 'pages_discovered'),
    pagesFetched: parseBoundedCount(row.pages_fetched, 'pages_fetched'),
    blocksFetched: parseBoundedCount(row.blocks_fetched, 'blocks_fetched'),
    chunksProduced: parseBoundedCount(row.chunks_produced, 'chunks_produced'),
    chunksEmbedded: parseBoundedCount(row.chunks_embedded, 'chunks_embedded'),
    candidateSnapshotCreated,
    candidateSnapshotValidated,
    candidateSnapshotActivated,
    activatedSnapshotId,
  };
}

function validateDiagnostics(
  input: BackstageNotionSyncAttemptDiagnosticsState
): BackstageNotionSyncAttemptDiagnosticsState {
  return {
    pagesDiscovered: requireBoundedCount(input.pagesDiscovered, 'pagesDiscovered'),
    pagesFetched: requireBoundedCount(input.pagesFetched, 'pagesFetched'),
    blocksFetched: requireBoundedCount(input.blocksFetched, 'blocksFetched'),
    chunksProduced: requireBoundedCount(input.chunksProduced, 'chunksProduced'),
    chunksEmbedded: requireBoundedCount(input.chunksEmbedded, 'chunksEmbedded'),
    candidateSnapshotCreated: requireBoolean(
      input.candidateSnapshotCreated,
      'candidateSnapshotCreated'
    ),
    candidateSnapshotValidated: requireBoolean(
      input.candidateSnapshotValidated,
      'candidateSnapshotValidated'
    ),
    candidateSnapshotActivated: requireBoolean(
      input.candidateSnapshotActivated,
      'candidateSnapshotActivated'
    ),
  };
}

const ATTEMPT_PROJECTION_SQL = `
  universe_id,
  attempt_id,
  attempt_generation,
  started_at,
  completed_at,
  outcome,
  failure_phase,
  failure_reason,
  pages_discovered,
  pages_fetched,
  blocks_fetched,
  chunks_produced,
  chunks_embedded,
  candidate_snapshot_created,
  candidate_snapshot_validated,
  candidate_snapshot_activated,
  activated_snapshot_id`;

export class PostgresBackstageNotionSyncStatusRepository
implements BackstageNotionSyncStatusRepository {
  constructor(private readonly pool: Pool) {}

  async beginSyncAttempt(
    input: BeginBackstageNotionSyncAttemptInput
  ): Promise<BackstageNotionSyncAttemptRecord> {
    const universeId = requireUniverseId(input.universeId);
    const holderId = input.lease.holderId.trim();
    if (!holderId || holderId.length > 200) {
      throw new TypeError('holderId is invalid.');
    }
    const leaseToken = requireUuid(input.lease.leaseToken, 'leaseToken');
    const attemptId = randomUUID();
    const result = await this.pool.query<SyncAttemptRow>(
      `INSERT INTO backstage_notion_latest_sync_attempts (
         universe_id,
         attempt_id,
         attempt_generation,
         started_at,
         completed_at,
         outcome,
         failure_phase,
         failure_reason,
         pages_discovered,
         pages_fetched,
         blocks_fetched,
         chunks_produced,
         chunks_embedded,
         candidate_snapshot_created,
         candidate_snapshot_validated,
         candidate_snapshot_activated,
         activated_snapshot_id,
         updated_at
       )
       SELECT
         $1,
         $4::UUID,
         1,
         clock_timestamp(),
         NULL,
         'running',
         NULL,
         NULL,
         0,
         0,
         0,
         0,
         0,
         FALSE,
         FALSE,
         FALSE,
         NULL,
         clock_timestamp()
       FROM backstage_notion_sync_leases AS lease
       WHERE lease.universe_id = $1
         AND lease.holder_id = $2
         AND lease.lease_token = $3::UUID
         AND lease.expires_at > clock_timestamp()
       ON CONFLICT (universe_id) DO UPDATE
       SET
         attempt_id = EXCLUDED.attempt_id,
         attempt_generation =
           backstage_notion_latest_sync_attempts.attempt_generation + 1,
         started_at = EXCLUDED.started_at,
         completed_at = NULL,
         outcome = 'running',
         failure_phase = NULL,
         failure_reason = NULL,
         pages_discovered = 0,
         pages_fetched = 0,
         blocks_fetched = 0,
         chunks_produced = 0,
         chunks_embedded = 0,
         candidate_snapshot_created = FALSE,
         candidate_snapshot_validated = FALSE,
         candidate_snapshot_activated = FALSE,
         activated_snapshot_id = NULL,
         updated_at = clock_timestamp()
       WHERE EXISTS (
         SELECT 1
         FROM backstage_notion_sync_leases AS current_lease
         WHERE current_lease.universe_id = EXCLUDED.universe_id
           AND current_lease.holder_id = $2
           AND current_lease.lease_token = $3::UUID
           AND current_lease.expires_at > clock_timestamp()
       )
       RETURNING ${ATTEMPT_PROJECTION_SQL}`,
      [universeId, holderId, leaseToken, attemptId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new BackstageNotionSyncStatusLeaseError();
    }
    const attempt = mapAttempt(row);
    if (
      attempt.universeId !== universeId
      || attempt.attemptId !== attemptId.toLowerCase()
      || attempt.outcome !== 'running'
    ) {
      throw new Error('Started Backstage Notion sync attempt escaped its lease scope.');
    }
    return attempt;
  }

  async completeSyncAttempt(
    input: CompleteBackstageNotionSyncAttemptInput
  ): Promise<BackstageNotionSyncAttemptRecord | null> {
    const universeId = requireUniverseId(input.universeId);
    const attemptId = requireUuid(input.attemptId, 'attemptId');
    const generation = requireGeneration(input.generation);
    const diagnostics = validateDiagnostics(input);
    if (!['activated', 'unchanged', 'failed'].includes(input.outcome)) {
      throw new TypeError('Sync attempt outcome is invalid.');
    }
    if (input.outcome === 'failed') {
      if (
        typeof input.failurePhase !== 'string'
        || !FAILURE_PHASES.has(input.failurePhase)
        || typeof input.failureReason !== 'string'
        || !FAILURE_REASONS.has(input.failureReason)
        || input.activatedSnapshotId
        || diagnostics.candidateSnapshotActivated
      ) {
        throw new TypeError('A failed sync attempt requires bounded failure state only.');
      }
    } else if (
      input.failurePhase !== null
      || input.failureReason !== null
      || !input.activatedSnapshotId
      || (input.outcome === 'activated' && (
        !diagnostics.candidateSnapshotCreated
        || !diagnostics.candidateSnapshotValidated
        || !diagnostics.candidateSnapshotActivated
      ))
      || (input.outcome === 'unchanged' && (
        diagnostics.candidateSnapshotCreated
        || diagnostics.candidateSnapshotValidated
        || diagnostics.candidateSnapshotActivated
      ))
    ) {
      throw new TypeError('A successful sync attempt requires its active snapshot only.');
    }
    if (
      (diagnostics.candidateSnapshotValidated && !diagnostics.candidateSnapshotCreated)
      || (diagnostics.candidateSnapshotActivated && !diagnostics.candidateSnapshotValidated)
    ) {
      throw new TypeError('Candidate snapshot lifecycle diagnostics are inconsistent.');
    }
    const activatedSnapshotId = input.activatedSnapshotId === null
      ? null
      : requireUuid(input.activatedSnapshotId, 'activatedSnapshotId');
    const result = await this.pool.query<SyncAttemptRow>(
      `UPDATE backstage_notion_latest_sync_attempts
       SET
         completed_at = clock_timestamp(),
         outcome = $4,
         failure_phase = $5,
         failure_reason = $6,
         pages_discovered = $7,
         pages_fetched = $8,
         blocks_fetched = $9,
         chunks_produced = $10,
         chunks_embedded = $11,
         candidate_snapshot_created = $12,
         candidate_snapshot_validated = $13,
         candidate_snapshot_activated = $14,
         activated_snapshot_id = $15::UUID,
         updated_at = clock_timestamp()
       WHERE universe_id = $1
         AND attempt_id = $2::UUID
         AND attempt_generation = $3::BIGINT
         AND outcome = 'running'
       RETURNING ${ATTEMPT_PROJECTION_SQL}`,
      [
        universeId,
        attemptId,
        generation,
        input.outcome,
        input.failurePhase,
        input.failureReason,
        diagnostics.pagesDiscovered,
        diagnostics.pagesFetched,
        diagnostics.blocksFetched,
        diagnostics.chunksProduced,
        diagnostics.chunksEmbedded,
        diagnostics.candidateSnapshotCreated,
        diagnostics.candidateSnapshotValidated,
        diagnostics.candidateSnapshotActivated,
        activatedSnapshotId,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const attempt = mapAttempt(row);
    if (
      attempt.universeId !== universeId
      || attempt.attemptId !== attemptId
      || attempt.generation !== generation
      || attempt.outcome !== input.outcome
    ) {
      throw new Error('Completed Backstage Notion sync attempt escaped its generation scope.');
    }
    return attempt;
  }

  async loadLatestSyncAttempt(
    universeId: string
  ): Promise<BackstageNotionSyncAttemptRecord | null> {
    const normalizedUniverseId = requireUniverseId(universeId);
    const result = await this.pool.query<SyncAttemptRow>(
      `SELECT ${ATTEMPT_PROJECTION_SQL}
       FROM backstage_notion_latest_sync_attempts
       WHERE universe_id = $1`,
      [normalizedUniverseId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const attempt = mapAttempt(row);
    if (attempt.universeId !== normalizedUniverseId) {
      throw new Error('Latest Backstage Notion sync attempt escaped its universe scope.');
    }
    return attempt;
  }
}

export function getBackstageNotionSyncStatusRepository():
BackstageNotionSyncStatusRepository {
  const pool = getPool();
  if (!pool) {
    throw new BackstageNotionSyncStatusRepositoryUnavailableError();
  }
  return new PostgresBackstageNotionSyncStatusRepository(pool);
}
