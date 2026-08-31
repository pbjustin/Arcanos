import { randomUUID } from 'node:crypto';

import type { PoolClient, QueryResult } from 'pg';

import { getPool } from '@core/db/client.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';

export const WORKER_BUDGET_WINDOW_MS = 60 * 60 * 1_000;
export const WORKER_BUDGET_LOCK_TIMEOUT_MS = 1_000;
export const WORKER_BUDGET_STATEMENT_TIMEOUT_MS = 5_000;
export const WORKER_BUDGET_TRANSACTION_TIMEOUT_MS = 10_000;
/** Reserved job_events subject for worker-owned provider work outside a queued job. */
export const WORKER_BUDGET_NON_JOB_SUBJECT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Persisted event names are a compatibility contract. In particular,
 * `worker.budget.ai_provider_attempt` records conservative admitted provider
 * capacity; it is not proof that native transport dispatch began.
 */
export type WorkerBudgetKind = 'job_claim' | 'ai_provider_attempt';

export interface WorkerBudgetPolicy {
  statsWorkerId: string;
  limit: number;
}

export interface WorkerBudgetAdmission {
  kind: WorkerBudgetKind;
  statsWorkerId: string;
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  evaluatedAt: string;
  nextAvailableAt: string | null;
  reservationId?: string;
  alreadyReserved?: boolean;
}

export interface WorkerBudgetWindowUsage {
  statsWorkerId: string;
  evaluatedAt: string;
  jobClaims: number;
  aiProviderAttempts: number;
  nextJobClaimAvailableAt: string | null;
  nextAiProviderAttemptAvailableAt: string | null;
}

export interface WorkerBudgetReservationInput extends WorkerBudgetPolicy {
  jobId: string;
  workerId: string;
  operation?: string | null;
  claimGeneration?: string | null;
  reservationId?: string;
  /** Controlled database-window time for disposable integration tests only. */
  now?: Date;
}

interface WorkerBudgetWindowRow {
  used_count: number | string;
  recovery_reservation_at: Date | string | null;
}

const WORKER_BUDGET_TRANSACTION_BOUNDS_SQL = `SELECT
  set_config('lock_timeout', $1::text, TRUE),
  set_config('statement_timeout', $2::text, TRUE),
  set_config('transaction_timeout', $3::text, TRUE)`;

export interface WorkerBudgetInspection {
  kind: WorkerBudgetKind;
  policy: WorkerBudgetPolicy;
}

function normalizeRequiredString(value: string, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Worker budget limit must be a positive safe integer.');
  }
  return value;
}

function parseTimestamp(value: Date | string, name: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} returned an invalid timestamp.`);
  }
  return parsed;
}

function readControlledBudgetClock(now: Date | undefined): string | null {
  if (!now) {
    return null;
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Controlled worker budget clocks are available only during tests.');
  }
  return parseTimestamp(now, 'Controlled worker budget clock').toISOString();
}

/** Apply fail-closed PostgreSQL 18 bounds to the caller's current transaction. */
export async function configureWorkerBudgetTransactionBoundsWithClient(
  client: Pick<PoolClient, 'query'>,
  transactionTimeoutMs = WORKER_BUDGET_TRANSACTION_TIMEOUT_MS
): Promise<void> {
  const normalizedTransactionTimeoutMs = normalizeLimit(transactionTimeoutMs);
  await client.query(
    WORKER_BUDGET_TRANSACTION_BOUNDS_SQL,
    [
      WORKER_BUDGET_LOCK_TIMEOUT_MS,
      WORKER_BUDGET_STATEMENT_TIMEOUT_MS,
      normalizedTransactionTimeoutMs
    ]
  );
}

function buildAdmission(input: {
  kind: WorkerBudgetKind;
  statsWorkerId: string;
  limit: number;
  used: number;
  evaluatedAt: Date;
  recoveryReservationAt: Date | null;
}): WorkerBudgetAdmission {
  const allowed = input.used < input.limit;
  const exhaustsOnAdmission = allowed && input.used === input.limit - 1;
  const recoveryReservationAt = input.recoveryReservationAt
    ?? (exhaustsOnAdmission ? input.evaluatedAt : null);
  const nextAvailableAt = (!allowed || exhaustsOnAdmission) && recoveryReservationAt
    ? new Date(recoveryReservationAt.getTime() + WORKER_BUDGET_WINDOW_MS).toISOString()
    : null;
  return {
    kind: input.kind,
    statsWorkerId: input.statsWorkerId,
    allowed,
    used: input.used,
    limit: input.limit,
    remaining: Math.max(0, input.limit - input.used),
    evaluatedAt: input.evaluatedAt.toISOString(),
    nextAvailableAt
  };
}

/**
 * Serialize one rolling-window budget group for the lifetime of the caller's transaction.
 * Hash collisions only serialize unrelated groups; they cannot admit an overshoot.
 */
export async function lockWorkerBudgetWithClient(
  client: Pick<PoolClient, 'query'>,
  kind: WorkerBudgetKind,
  statsWorkerId: string
): Promise<void> {
  const normalizedStatsWorkerId = normalizeRequiredString(statsWorkerId, 'statsWorkerId');
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('arcanos-worker-budget-v1:' || $1::text || ':' || $2::text, 0)
     )`,
    [kind, normalizedStatsWorkerId]
  );
}

/**
 * Read one strict `(T - 1 hour, T]` window after the caller owns its group lock.
 * Production samples `clock_timestamp()` after lock acquisition. The optional time is
 * reserved for controlled disposable-database tests and is never supplied by runtime code.
 */
async function readWorkerBudgetClockWithClient(
  client: Pick<PoolClient, 'query'>,
  options: { now?: Date } = {}
): Promise<Date> {
  const clockResult = await client.query(
    `SELECT COALESCE($1::timestamptz, clock_timestamp()) AS evaluated_at`,
    [readControlledBudgetClock(options.now)]
  );
  return parseTimestamp(
    (clockResult.rows[0] as { evaluated_at?: Date | string } | undefined)?.evaluated_at ?? '',
    'Worker budget clock'
  );
}

async function inspectWorkerBudgetAtWithClient(
  client: Pick<PoolClient, 'query'>,
  kind: WorkerBudgetKind,
  policy: WorkerBudgetPolicy,
  evaluatedAt: Date
): Promise<WorkerBudgetAdmission> {
  const statsWorkerId = normalizeRequiredString(policy.statsWorkerId, 'statsWorkerId');
  const limit = normalizeLimit(policy.limit);
  const result = await client.query(
    `WITH active_reservations AS (
       SELECT occurred_at, id
       FROM job_events
       WHERE stats_worker_id = $1::text
         AND event_type = $2::text
         AND occurred_at > $3::timestamptz - ($4::bigint * INTERVAL '1 millisecond')
         AND occurred_at <= $3::timestamptz
     )
     SELECT
       COUNT(*)::int AS used_count,
       (ARRAY_AGG(occurred_at ORDER BY occurred_at ASC, id ASC))[
         GREATEST(COUNT(*)::int - $5::int + 1, 1)
       ] AS recovery_reservation_at
     FROM active_reservations`,
    [
      statsWorkerId,
      kind === 'job_claim' ? 'worker.budget.job_claim' : 'worker.budget.ai_provider_attempt',
      evaluatedAt.toISOString(),
      WORKER_BUDGET_WINDOW_MS,
      limit
    ]
  );
  const row = result.rows[0] as WorkerBudgetWindowRow | undefined;
  const used = Number(row?.used_count ?? 0);
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new Error('Worker budget query returned an invalid usage count.');
  }
  return buildAdmission({
    kind,
    statsWorkerId,
    limit,
    used,
    evaluatedAt,
    recoveryReservationAt: row?.recovery_reservation_at
      ? parseTimestamp(row.recovery_reservation_at, 'Worker budget recovery reservation')
      : null
  });
}

/** Inspect multiple locked budget kinds against one database-clock sample. */
export async function inspectWorkerBudgetsWithClient(
  client: Pick<PoolClient, 'query'>,
  inspections: readonly WorkerBudgetInspection[],
  options: { now?: Date } = {}
): Promise<WorkerBudgetAdmission[]> {
  if (inspections.length === 0) {
    return [];
  }
  const evaluatedAt = await readWorkerBudgetClockWithClient(client, options);
  const admissions: WorkerBudgetAdmission[] = [];
  for (const inspection of inspections) {
    admissions.push(await inspectWorkerBudgetAtWithClient(
      client,
      inspection.kind,
      inspection.policy,
      evaluatedAt
    ));
  }
  return admissions;
}

export async function inspectWorkerBudgetWithClient(
  client: Pick<PoolClient, 'query'>,
  kind: WorkerBudgetKind,
  policy: WorkerBudgetPolicy,
  options: { now?: Date } = {}
): Promise<WorkerBudgetAdmission> {
  const [admission] = await inspectWorkerBudgetsWithClient(
    client,
    [{ kind, policy }],
    options
  );
  if (!admission) {
    throw new Error('Worker budget inspection did not return an admission decision.');
  }
  return admission;
}

export async function recordWorkerBudgetReservationWithClient(
  client: Pick<PoolClient, 'query'>,
  kind: WorkerBudgetKind,
  input: WorkerBudgetReservationInput,
  evaluatedAt: string
): Promise<void> {
  const statsWorkerId = normalizeRequiredString(input.statsWorkerId, 'statsWorkerId');
  const workerId = normalizeRequiredString(input.workerId, 'workerId');
  const jobId = normalizeRequiredString(input.jobId, 'jobId');
  const metadata = safeJSONStringify(
    {
      budgetKind: kind,
      workerId,
      operation: input.operation?.trim() || null,
      claimGeneration: input.claimGeneration?.trim() || null,
      windowMs: WORKER_BUDGET_WINDOW_MS
    },
    'workerBudgetRepository.recordWorkerBudgetReservationWithClient'
  );
  const reservationId = input.reservationId?.trim() || randomUUID();
  await client.query(
    `INSERT INTO job_events (
       id,
       job_id,
       event_type,
       worker_id,
       stats_worker_id,
       claim_generation,
       operation,
       occurred_at,
       metadata
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::text,
       $4::text,
       $5::text,
       $6::bigint,
       $7::text,
       $8::timestamptz,
       $9::jsonb
     )`,
    [
      reservationId,
      jobId,
      kind === 'job_claim' ? 'worker.budget.job_claim' : 'worker.budget.ai_provider_attempt',
      workerId,
      statsWorkerId,
      input.claimGeneration?.trim() || null,
      input.operation?.trim() || null,
      evaluatedAt,
      metadata
    ]
  );
}

/** Read current hard-budget usage using one post-lock-compatible database clock. */
export async function getWorkerBudgetWindowUsage(
  statsWorkerIdInput: string,
  options: { now?: Date; jobLimit?: number; aiLimit?: number } = {}
): Promise<WorkerBudgetWindowUsage> {
  const statsWorkerId = normalizeRequiredString(statsWorkerIdInput, 'statsWorkerId');
  const jobLimit = options.jobLimit === undefined ? null : normalizeLimit(options.jobLimit);
  const aiLimit = options.aiLimit === undefined ? null : normalizeLimit(options.aiLimit);
  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable for worker budget diagnostics.');
  }
  const client = await pool.connect();
  let result: QueryResult;
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await configureWorkerBudgetTransactionBoundsWithClient(client);
    result = await client.query(
      `WITH budget_clock AS (
         SELECT COALESCE($2::timestamptz, clock_timestamp()) AS evaluated_at
       )
       SELECT
         budget_clock.evaluated_at,
         COUNT(*) FILTER (
           WHERE event.event_type = 'worker.budget.job_claim'
         )::int AS job_claim_count,
         COUNT(*) FILTER (
           WHERE event.event_type = 'worker.budget.ai_provider_attempt'
         )::int AS ai_provider_attempt_count,
         ARRAY_AGG(event.occurred_at ORDER BY event.occurred_at ASC, event.id ASC) FILTER (
           WHERE event.event_type = 'worker.budget.job_claim'
         ) AS job_claim_times,
         ARRAY_AGG(event.occurred_at ORDER BY event.occurred_at ASC, event.id ASC) FILTER (
           WHERE event.event_type = 'worker.budget.ai_provider_attempt'
         ) AS ai_provider_attempt_times
       FROM budget_clock
       LEFT JOIN job_events AS event
         ON event.stats_worker_id = $1::text
        AND event.event_type IN (
          'worker.budget.job_claim',
          'worker.budget.ai_provider_attempt'
        )
        AND event.occurred_at > budget_clock.evaluated_at - ($3::bigint * INTERVAL '1 millisecond')
        AND event.occurred_at <= budget_clock.evaluated_at
       GROUP BY budget_clock.evaluated_at`,
      [statsWorkerId, readControlledBudgetClock(options.now), WORKER_BUDGET_WINDOW_MS]
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error
        ? rollbackError
        : new Error('Worker budget diagnostics rollback failed.');
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
  const row = result.rows[0] as {
    evaluated_at?: Date | string;
    job_claim_count?: number | string;
    ai_provider_attempt_count?: number | string;
    job_claim_times?: Array<Date | string> | null;
    ai_provider_attempt_times?: Array<Date | string> | null;
  } | undefined;
  const evaluatedAt = parseTimestamp(row?.evaluated_at ?? '', 'Worker budget diagnostics clock');
  const jobClaims = Number(row?.job_claim_count ?? 0);
  const aiProviderAttempts = Number(row?.ai_provider_attempt_count ?? 0);
  if (
    !Number.isSafeInteger(jobClaims) || jobClaims < 0 ||
    !Number.isSafeInteger(aiProviderAttempts) || aiProviderAttempts < 0
  ) {
    throw new Error('Worker budget diagnostics returned invalid usage counts.');
  }
  const toNextAvailableAt = (
    values: Array<Date | string> | null | undefined,
    used: number,
    limit: number | null
  ): string | null => {
    if (limit === null || used < limit || !values) {
      return null;
    }
    const recoveryReservation = values[used - limit];
    return recoveryReservation
      ? new Date(parseTimestamp(
          recoveryReservation,
          'Worker budget diagnostics recovery reservation'
        ).getTime() + WORKER_BUDGET_WINDOW_MS).toISOString()
      : null;
  };
  return {
    statsWorkerId,
    evaluatedAt: evaluatedAt.toISOString(),
    jobClaims,
    aiProviderAttempts,
    nextJobClaimAvailableAt: toNextAvailableAt(row?.job_claim_times, jobClaims, jobLimit),
    nextAiProviderAttemptAvailableAt: toNextAvailableAt(
      row?.ai_provider_attempt_times,
      aiProviderAttempts,
      aiLimit
    )
  };
}

/**
 * Atomically reserve conservative capacity for one worker-originated provider
 * transport handoff. Once the database commit succeeds, that unit remains
 * charged if cancellation wins before native dispatch or the provider later fails.
 */
export async function reserveWorkerAiProviderAttempt(
  input: WorkerBudgetReservationInput
): Promise<WorkerBudgetAdmission> {
  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool unavailable for worker AI-call budget admission.');
  }
  const client = await pool.connect();
  const reservationId = input.reservationId?.trim() || randomUUID();
  const normalizedJobId = normalizeRequiredString(input.jobId, 'jobId');
  const normalizedStatsWorkerId = normalizeRequiredString(input.statsWorkerId, 'statsWorkerId');
  const normalizedWorkerId = normalizeRequiredString(input.workerId, 'workerId');
  const normalizedOperation = input.operation?.trim() || null;
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await configureWorkerBudgetTransactionBoundsWithClient(client);
    await lockWorkerBudgetWithClient(client, 'ai_provider_attempt', normalizedStatsWorkerId);
    const admission = await inspectWorkerBudgetWithClient(
      client,
      'ai_provider_attempt',
      { ...input, statsWorkerId: normalizedStatsWorkerId },
      { now: input.now }
    );
    const existing = await client.query(
      `SELECT job_id::text, event_type, stats_worker_id, worker_id, operation, occurred_at
       FROM job_events
       WHERE id = $1::uuid`,
      [reservationId]
    );
    const existingRow = existing.rows[0] as {
      job_id?: string;
      event_type?: string;
      stats_worker_id?: string;
      worker_id?: string;
      operation?: string | null;
      occurred_at?: Date | string;
    } | undefined;
    if (existingRow) {
      if (
        existingRow.job_id !== normalizedJobId ||
        existingRow.event_type !== 'worker.budget.ai_provider_attempt' ||
        existingRow.stats_worker_id !== normalizedStatsWorkerId ||
        existingRow.worker_id !== normalizedWorkerId ||
        (existingRow.operation?.trim() || null) !== normalizedOperation
      ) {
        throw new Error('Worker AI-call reservation id is already bound to different budget evidence.');
      }
      const occurredAt = parseTimestamp(
        existingRow.occurred_at ?? '',
        'Worker AI-call reservation timestamp'
      );
      const evaluatedAt = parseTimestamp(admission.evaluatedAt, 'Worker budget admission clock');
      if (
        occurredAt.getTime() <= evaluatedAt.getTime() - WORKER_BUDGET_WINDOW_MS ||
        occurredAt.getTime() > evaluatedAt.getTime()
      ) {
        throw new Error('Worker AI-call reservation id cannot be reused outside its active budget window.');
      }
      await client.query('COMMIT');
      return {
        ...admission,
        allowed: false,
        reservationId,
        alreadyReserved: true
      };
    }
    if (admission.allowed) {
      await recordWorkerBudgetReservationWithClient(
        client,
        'ai_provider_attempt',
        {
          ...input,
          jobId: normalizedJobId,
          statsWorkerId: normalizedStatsWorkerId,
          workerId: normalizedWorkerId,
          operation: normalizedOperation,
          reservationId
        },
        admission.evaluatedAt
      );
    }
    await client.query('COMMIT');
    return admission.allowed
      ? {
          ...admission,
          used: admission.used + 1,
          remaining: Math.max(0, admission.remaining - 1),
          reservationId,
          alreadyReserved: false
        }
      : { ...admission, reservationId, alreadyReserved: false };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Preserve the owner-seam failure that caused the transaction to abort.
      releaseError = rollbackError instanceof Error
        ? rollbackError
        : new Error('Worker AI-call budget rollback failed.');
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
