import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
} from '@shared/backstage/backstageNotionScopeIndex.js';
import {
  BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES,
  BACKSTAGE_NOTION_SYNC_FAILURE_PHASES,
  BACKSTAGE_NOTION_SYNC_FAILURE_REASONS,
  type BackstageNotionLatestSyncAttemptObservation,
  type BackstageNotionLatestSyncAttemptState,
  type BackstageNotionSyncAttemptOutcome,
  type BackstageNotionSyncFailurePhase,
  type BackstageNotionSyncFailureReason,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';
import { getPool } from '../client.js';
import {
  BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT,
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
} from './backstageNotionRagRepository.js';

const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAXIMUM_BOUNDED_SYNC_COUNT = 1_000_000;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MONOLITH_AUTHORITY_STATUS_READ_TIMEOUT_SQL = `SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '5s'`;
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

export interface BackstageNotionMonolithAuthorityOperationalState {
  readonly observedAt: Date;
  readonly durableAuthority: 'postgres' | 'notion' | null;
  readonly durableRootPresent: boolean;
  readonly configuredRootMatchesDurable: boolean | null;
  readonly activeSnapshotPresent: boolean;
  readonly activeSnapshotVerifiedAt: Date | null;
  readonly activeSnapshotPageCount: number;
  readonly activeSnapshotChunkCount: number;
  readonly activeSnapshotReadable: boolean;
  readonly latestSyncAttempt: BackstageNotionLatestSyncAttemptObservation | null;
  readonly syncInProgress: boolean;
}

export interface LoadBackstageNotionMonolithAuthorityOperationalStateInput {
  readonly universeId: string;
  readonly configuredRootPageId: string | null;
  readonly expectedEmbeddingModel: string;
}

/** Identifier-free read surface for status and protected-literal admission. */
export interface BackstageNotionMonolithAuthorityStatusRepository {
  loadMonolithAuthorityOperationalState(
    input: LoadBackstageNotionMonolithAuthorityOperationalStateInput
  ): Promise<BackstageNotionMonolithAuthorityOperationalState>;
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

interface MonolithAuthorityOperationalStateRow {
  observed_at: TimestampValue;
  durable_authority: string | null;
  durable_root_present: boolean;
  configured_root_matches_durable: boolean | null;
  active_snapshot_present: boolean;
  active_snapshot_verified_at: TimestampValue | null;
  active_snapshot_page_count: number | string | null;
  active_snapshot_chunk_count: number | string | null;
  active_snapshot_readable: boolean;
  sync_in_progress: boolean;
  latest_attempt_present: boolean;
  latest_started_at: TimestampValue | null;
  latest_completed_at: TimestampValue | null;
  latest_outcome: string | null;
  latest_failure_phase: string | null;
  latest_failure_reason: string | null;
  latest_successful_snapshot_matches_active: boolean | null;
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

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

async function withBoundedMonolithAuthorityStatusRead<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(MONOLITH_AUTHORITY_STATUS_READ_TIMEOUT_SQL);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    discardClient = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(discardClient);
  }
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

function mapLatestAttemptFromOperationalState(
  row: MonolithAuthorityOperationalStateRow
): BackstageNotionLatestSyncAttemptObservation | null {
  const latestAttemptPresent = requireBoolean(
    row.latest_attempt_present,
    'latest_attempt_present'
  );
  if (!latestAttemptPresent) {
    const nullableFields = [
      row.latest_started_at,
      row.latest_completed_at,
      row.latest_outcome,
      row.latest_failure_phase,
      row.latest_failure_reason,
      row.latest_successful_snapshot_matches_active,
    ];
    if (nullableFields.some(value => value !== null)) {
      throw new Error('Stored Backstage Notion sync status is incomplete.');
    }
    return null;
  }
  if (
    row.latest_started_at === null
    || row.latest_outcome === null
    || !OUTCOMES.has(row.latest_outcome)
  ) {
    throw new Error('Stored Backstage Notion sync status is incomplete.');
  }
  if (
    (row.latest_failure_phase !== null
      && !FAILURE_PHASES.has(row.latest_failure_phase))
    || (row.latest_failure_reason !== null
      && !FAILURE_REASONS.has(row.latest_failure_reason))
  ) {
    throw new Error('Stored Backstage Notion sync status is unsupported.');
  }
  const failurePhase = row.latest_failure_phase as
    BackstageNotionSyncFailurePhase | null;
  const failureReason = row.latest_failure_reason as
    BackstageNotionSyncFailureReason | null;
  const outcome = row.latest_outcome as BackstageNotionSyncAttemptOutcome;
  if (
    (outcome === 'failed'
      ? failurePhase === null
        || failureReason === null
        || row.latest_completed_at === null
        || row.latest_successful_snapshot_matches_active !== null
      : failurePhase !== null || failureReason !== null)
    || (outcome === 'running'
      ? row.latest_completed_at !== null
        || row.latest_successful_snapshot_matches_active !== null
      : outcome !== 'failed'
        && (
          row.latest_completed_at === null
          || typeof row.latest_successful_snapshot_matches_active !== 'boolean'
        ))
  ) {
    throw new Error('Stored Backstage Notion sync status is inconsistent.');
  }
  return Object.freeze({
    startedAt: parseDate(row.latest_started_at, 'latest_started_at'),
    completedAt: row.latest_completed_at === null
      ? null
      : parseDate(row.latest_completed_at, 'latest_completed_at'),
    outcome,
    successfulSnapshotMatchesActive:
      row.latest_successful_snapshot_matches_active,
    failurePhase,
    failureReason,
  });
}

function mapMonolithAuthorityOperationalState(
  row: MonolithAuthorityOperationalStateRow
): BackstageNotionMonolithAuthorityOperationalState {
  const durableAuthority = row.durable_authority === null
    ? null
    : row.durable_authority === 'postgres' || row.durable_authority === 'notion'
      ? row.durable_authority
      : (() => {
          throw new Error('Stored Backstage Notion authority is unsupported.');
        })();
  const durableRootPresent = requireBoolean(
    row.durable_root_present,
    'durable_root_present'
  );
  const configuredRootMatchesDurable = row.configured_root_matches_durable;
  if (
    configuredRootMatchesDurable !== null
    && typeof configuredRootMatchesDurable !== 'boolean'
  ) {
    throw new Error('configured_root_matches_durable is invalid.');
  }
  const activeSnapshotPresent = requireBoolean(
    row.active_snapshot_present,
    'active_snapshot_present'
  );
  const activeSnapshotVerifiedAt = row.active_snapshot_verified_at === null
    ? null
    : parseDate(row.active_snapshot_verified_at, 'active_snapshot_verified_at');
  const activeSnapshotChunkCount = row.active_snapshot_chunk_count === null
    ? 0
    : parseBoundedCount(
        row.active_snapshot_chunk_count,
        'active_snapshot_chunk_count'
      );
  const activeSnapshotPageCount = row.active_snapshot_page_count === null
    ? 0
    : parseBoundedCount(
        row.active_snapshot_page_count,
        'active_snapshot_page_count'
      );
  const activeSnapshotReadable = requireBoolean(
    row.active_snapshot_readable,
    'active_snapshot_readable'
  );
  const syncInProgress = requireBoolean(
    row.sync_in_progress,
    'sync_in_progress'
  );
  if (
    activeSnapshotReadable
    && (
      durableAuthority !== 'notion'
      || !durableRootPresent
      || !activeSnapshotPresent
      || activeSnapshotVerifiedAt === null
      || activeSnapshotPageCount < 1
      || activeSnapshotPageCount > BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT
      || activeSnapshotChunkCount < 1
      || activeSnapshotChunkCount
        > BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT
    )
  ) {
    throw new Error('Stored Backstage Notion active snapshot is not readable.');
  }
  return Object.freeze({
    observedAt: parseDate(row.observed_at, 'observed_at'),
    durableAuthority,
    durableRootPresent,
    configuredRootMatchesDurable,
    activeSnapshotPresent,
    activeSnapshotVerifiedAt,
    activeSnapshotPageCount,
    activeSnapshotChunkCount,
    activeSnapshotReadable,
    latestSyncAttempt: mapLatestAttemptFromOperationalState(row),
    syncInProgress,
  });
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
implements BackstageNotionSyncStatusRepository,
BackstageNotionMonolithAuthorityStatusRepository {
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

  async loadMonolithAuthorityOperationalState(
    input: LoadBackstageNotionMonolithAuthorityOperationalStateInput
  ): Promise<BackstageNotionMonolithAuthorityOperationalState> {
    const normalizedUniverseId = requireUniverseId(input.universeId);
    const configuredRootPageId = input.configuredRootPageId === null
      ? null
      : requireUuid(input.configuredRootPageId, 'configuredRootPageId');
    const expectedEmbeddingModel = input.expectedEmbeddingModel.trim();
    if (!expectedEmbeddingModel || expectedEmbeddingModel.length > 200) {
      throw new TypeError('expectedEmbeddingModel is invalid.');
    }
    const result = await withBoundedMonolithAuthorityStatusRead(
      this.pool,
      client => client.query<MonolithAuthorityOperationalStateRow>(
        `WITH observation AS MATERIALIZED (
           SELECT clock_timestamp() AS observed_at
         ), requested AS (
           SELECT $1::TEXT AS universe_id
         )
         SELECT
           observation.observed_at,
           head.authority AS durable_authority,
           COALESCE(
             head.authority = 'notion'
             AND snapshot.id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM backstage_notion_snapshot_pages AS durable_root_page
               WHERE durable_root_page.universe_id = requested.universe_id
                 AND durable_root_page.snapshot_id = snapshot.id
                 AND durable_root_page.page_id = snapshot.root_page_id
                 AND durable_root_page.parent_page_id IS NULL
                 AND durable_root_page.depth = 0
                 AND jsonb_typeof(durable_root_page.path) = 'array'
                 AND jsonb_array_length(durable_root_page.path) = 1
             ),
             FALSE
           ) AS durable_root_present,
           CASE
             WHEN $2::TEXT IS NULL OR head.authority IS DISTINCT FROM 'notion'
             THEN NULL
             ELSE COALESCE(snapshot.root_page_id = $2::TEXT, FALSE)
           END AS configured_root_matches_durable,
           COALESCE(
             head.active_snapshot_id IS NOT NULL AND snapshot.id IS NOT NULL,
             FALSE
           ) AS active_snapshot_present,
           head.last_verified_at AS active_snapshot_verified_at,
           snapshot.page_count AS active_snapshot_page_count,
           snapshot.chunk_count AS active_snapshot_chunk_count,
           COALESCE((
             head.authority = 'notion'
             AND head.active_snapshot_id IS NOT NULL
             AND snapshot.id IS NOT NULL
             AND head.last_verified_at IS NOT NULL
             AND pg_catalog.isfinite(head.last_verified_at)
             AND pg_catalog.isfinite(snapshot.created_at)
             AND head.last_verified_at >= snapshot.created_at
             AND head.last_verified_at
               <= observation.observed_at + INTERVAL '5 minutes'
             AND snapshot.created_at
               <= observation.observed_at + INTERVAL '5 minutes'
             AND snapshot.manifest_hash ~ '^[0-9a-f]{64}$'
             AND snapshot.embedding_model = $7::TEXT
             AND ($2::TEXT IS NULL OR snapshot.root_page_id = $2::TEXT)
             AND snapshot.page_count BETWEEN 1 AND $3::INTEGER
             AND snapshot.chunk_count BETWEEN 1 AND $4::INTEGER
             AND snapshot.page_count = (
               SELECT COUNT(*)
               FROM backstage_notion_snapshot_pages AS counted_page
               WHERE counted_page.universe_id = requested.universe_id
                 AND counted_page.snapshot_id = snapshot.id
             )
             AND snapshot.chunk_count = (
               SELECT COUNT(*)
               FROM backstage_notion_snapshot_chunks AS counted_chunk
               WHERE counted_chunk.universe_id = requested.universe_id
                 AND counted_chunk.snapshot_id = snapshot.id
             )
             AND EXISTS (
               SELECT 1
               FROM backstage_notion_snapshot_pages AS root_page
               WHERE root_page.universe_id = requested.universe_id
                 AND root_page.snapshot_id = snapshot.id
                 AND root_page.page_id = snapshot.root_page_id
                 AND root_page.parent_page_id IS NULL
                 AND root_page.depth = 0
                 AND jsonb_typeof(root_page.path) = 'array'
                 AND jsonb_array_length(root_page.path) = 1
             )
             AND NOT EXISTS (
               SELECT 1
               FROM backstage_notion_snapshot_pages AS page
               WHERE page.universe_id = requested.universe_id
                 AND page.snapshot_id = snapshot.id
                 AND (
                   jsonb_typeof(page.metadata) IS DISTINCT FROM 'object'
                   OR page.metadata ->> 'indexFormat' IS DISTINCT FROM $5
                   OR page.metadata ->> 'headingIndexVersion'
                     IS DISTINCT FROM $6::TEXT
                   OR jsonb_typeof(page.metadata -> 'scopeTitleKey')
                     IS DISTINCT FROM 'string'
                   OR page.metadata ->> 'scopeTitleKey'
                     !~ '^[0-9a-f]{64}$'
                   OR CASE
                     WHEN jsonb_typeof(page.metadata -> 'scopePathKey') = 'array'
                       AND jsonb_typeof(page.path) = 'array'
                     THEN
                       jsonb_array_length(page.metadata -> 'scopePathKey')
                         IS DISTINCT FROM jsonb_array_length(page.path)
                       OR jsonb_array_length(page.metadata -> 'scopePathKey')
                         NOT BETWEEN 1 AND 101
                       OR EXISTS (
                         SELECT 1
                         FROM jsonb_array_elements(
                           page.metadata -> 'scopePathKey'
                         ) AS scope_path_segment(value)
                         WHERE jsonb_typeof(scope_path_segment.value)
                           IS DISTINCT FROM 'string'
                           OR (scope_path_segment.value #>> '{}')
                             !~ '^[0-9a-f]{64}$'
                       )
                     ELSE TRUE
                   END
                 )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM backstage_notion_snapshot_chunks AS chunk
               WHERE chunk.universe_id = requested.universe_id
                 AND chunk.snapshot_id = snapshot.id
                 AND (
                   chunk.embedding_model IS DISTINCT FROM snapshot.embedding_model
                   OR jsonb_typeof(chunk.metadata) IS DISTINCT FROM 'object'
                   OR chunk.metadata ->> 'headingIndexVersion'
                     IS DISTINCT FROM $6::TEXT
                   OR CASE
                     WHEN jsonb_typeof(
                       chunk.metadata -> 'scopeHeadingPathKey'
                     ) = 'array'
                       AND jsonb_typeof(
                         chunk.metadata -> 'headingOccurrencePath'
                       ) = 'array'
                       AND jsonb_typeof(chunk.heading_path) = 'array'
                     THEN
                       jsonb_array_length(
                         chunk.metadata -> 'scopeHeadingPathKey'
                       ) IS DISTINCT FROM jsonb_array_length(chunk.heading_path)
                       OR jsonb_array_length(
                         chunk.metadata -> 'headingOccurrencePath'
                       ) IS DISTINCT FROM jsonb_array_length(chunk.heading_path)
                       OR jsonb_array_length(chunk.heading_path) > 32
                       OR EXISTS (
                         SELECT 1
                         FROM jsonb_array_elements(
                           chunk.metadata -> 'scopeHeadingPathKey'
                         ) AS scope_heading_segment(value)
                         WHERE jsonb_typeof(scope_heading_segment.value)
                           IS DISTINCT FROM 'string'
                           OR (scope_heading_segment.value #>> '{}')
                             !~ '^[0-9a-f]{64}$'
                       )
                       OR EXISTS (
                         SELECT 1
                         FROM jsonb_array_elements(
                           chunk.metadata -> 'headingOccurrencePath'
                         ) AS heading_occurrence(value)
                         WHERE CASE
                           WHEN jsonb_typeof(heading_occurrence.value) = 'number'
                             AND heading_occurrence.value::TEXT
                               ~ '^[1-9][0-9]{0,3}$'
                           THEN (heading_occurrence.value::TEXT)::INTEGER
                             BETWEEN 1 AND ${BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT}
                           ELSE FALSE
                         END IS NOT TRUE
                       )
                     ELSE TRUE
                   END
                 )
             )
           ), FALSE) AS active_snapshot_readable,
           EXISTS (
             SELECT 1
             FROM backstage_notion_sync_leases AS live_lease
             WHERE live_lease.universe_id = requested.universe_id
               AND live_lease.expires_at > observation.observed_at
           ) AS sync_in_progress,
           (latest.attempt_id IS NOT NULL) AS latest_attempt_present,
           latest.started_at AS latest_started_at,
           latest.completed_at AS latest_completed_at,
           latest.outcome AS latest_outcome,
           latest.failure_phase AS latest_failure_phase,
           latest.failure_reason AS latest_failure_reason,
           CASE
             WHEN latest.outcome IN ('activated', 'unchanged')
             THEN latest.activated_snapshot_id = head.active_snapshot_id
             ELSE NULL
           END AS latest_successful_snapshot_matches_active
         FROM requested
         CROSS JOIN observation
         LEFT JOIN backstage_notion_universe_heads AS head
           ON head.universe_id = requested.universe_id
         LEFT JOIN backstage_notion_snapshots AS snapshot
           ON snapshot.universe_id = head.universe_id
          AND snapshot.id = head.active_snapshot_id
         LEFT JOIN backstage_notion_latest_sync_attempts AS latest
           ON latest.universe_id = requested.universe_id`,
        [
          normalizedUniverseId,
          configuredRootPageId,
          BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT,
          BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
          BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
          BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
          expectedEmbeddingModel,
        ]
      )
    );
    if (result.rows.length !== 1 || !result.rows[0]) {
      throw new Error('Backstage Notion monolith authority status is unavailable.');
    }
    return mapMonolithAuthorityOperationalState(result.rows[0]);
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

export function getBackstageNotionMonolithAuthorityStatusRepository():
BackstageNotionMonolithAuthorityStatusRepository {
  const pool = getPool();
  if (!pool) {
    throw new BackstageNotionSyncStatusRepositoryUnavailableError();
  }
  return new PostgresBackstageNotionSyncStatusRepository(pool);
}
