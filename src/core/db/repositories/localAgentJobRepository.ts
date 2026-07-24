import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { isDatabaseConnected } from '@core/db/client.js';
import type { JobData } from '@core/db/schema.js';
import { transaction } from '@core/db/query.js';
import { dbLogger } from '@platform/logging/structuredLogging.js';
import {
  recordJobEvent,
  recordJobEventWithClient,
  type JobEventType,
  type RecordJobEventInput
} from './jobEventRepository.js';

export const LOCAL_AGENT_JOB_TYPE = 'local-agent';
export const LOCAL_AGENT_JOB_PROTOCOL_VERSION = 'local-agent-job-v1';
const LOCAL_AGENT_RECOVERY_BATCH_SIZE = 100;
const LOCAL_AGENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE = 100;

export type LocalAgentAuthorizationDecision = 'allow' | 'confirmed';

export interface LocalAgentJobEnvelope {
  protocolVersion: typeof LOCAL_AGENT_JOB_PROTOCOL_VERSION;
  requestPath: '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run';
  executionModeReason: 'gpt_access_local_agent_capability';
  job: {
    action: string;
    payload: unknown;
    principal: string;
    workspace: string;
    deviceId: string;
    traceId: string;
    requestId: string;
    idempotencyKey: string;
    authorization: {
      decision: LocalAgentAuthorizationDecision;
      evidenceId: string;
      evaluatedAt: string;
    };
    expiresAt: string;
    timeoutMs: number;
    requiredDeviceScopes: string[];
    readOnly: boolean;
    mayModifyFiles: boolean;
  };
}

export interface FindOrCreateLocalAgentJobOptions {
  deviceId: string;
  envelope: LocalAgentJobEnvelope;
  requestFingerprintHash: string;
  idempotencyKeyHash: string;
  idempotencyScopeHash: string;
  idempotencyOrigin: 'explicit' | 'derived';
  expiresAt: string;
  idempotencyUntil: string;
  retentionUntil: string;
}

export interface FindOrCreateLocalAgentJobResult {
  job: JobData;
  created: boolean;
  deduped: boolean;
  dedupeReason: 'new_job' | 'reused_inflight_job' | 'reused_terminal_result';
}

interface LocalAgentIdempotencyBindingRow {
  id: string;
  principal_id: string;
  workspace_id: string;
  device_id: string;
  action: string;
  idempotency_key_hash: string;
  idempotency_scope_hash: string;
  request_fingerprint_hash: string;
  idempotency_origin: 'explicit' | 'derived';
  job_id: string;
  idempotency_until: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export type LocalAgentClaimDisposition =
  | 'CLAIMED'
  | 'CLAIM_REPLAY'
  | 'TERMINAL_REPLAY';

export interface ClaimLocalAgentJobResult {
  disposition: LocalAgentClaimDisposition;
  job: JobData;
}

export interface SubmitLocalAgentJobResultOptions {
  jobId: string;
  deviceId: string;
  resultKeyHash: string;
  resultFingerprintHash: string;
  outcome: 'succeeded' | 'failed';
  output?: unknown;
  error?: {
    code: string;
    message: string;
    classification: string;
    retryable: boolean;
  };
  metrics: {
    durationMs: number;
    outputTruncated: boolean;
  };
  correlation: {
    traceId: string;
    requestId: string;
    deviceId: string;
  };
}

export interface SubmitLocalAgentJobResult {
  job: JobData;
  replayed: boolean;
}

export class LocalAgentJobRepositoryError extends Error {
  constructor(
    public readonly code:
      | 'LOCAL_AGENT_JOBS_UNAVAILABLE'
      | 'LOCAL_AGENT_IDEMPOTENCY_CONFLICT'
      | 'LOCAL_AGENT_JOB_NOT_FOUND'
      | 'LOCAL_AGENT_JOB_STATE_CONFLICT'
      | 'LOCAL_AGENT_JOB_LEASE_EXPIRED'
      | 'LOCAL_AGENT_RESULT_CONFLICT'
      | 'LOCAL_AGENT_RESULT_CORRELATION_MISMATCH',
    message: string
  ) {
    super(message);
    this.name = 'LocalAgentJobRepositoryError';
  }
}

function assertDatabaseReady(): void {
  if (!isDatabaseConnected()) {
    throw new LocalAgentJobRepositoryError(
      'LOCAL_AGENT_JOBS_UNAVAILABLE',
      'Durable local-agent job persistence is unavailable.'
    );
  }
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new LocalAgentJobRepositoryError(
      'LOCAL_AGENT_JOB_STATE_CONFLICT',
      'Local-agent job data could not be serialized.'
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readLocalAgentState(job: JobData): Record<string, unknown> {
  const autonomyState = asRecord(job.autonomy_state);
  return asRecord(autonomyState?.localAgent) ?? {};
}

export function readLocalAgentJobEnvelope(job: JobData): LocalAgentJobEnvelope | null {
  const input = asRecord(job.input);
  const assignment = asRecord(input?.job);
  if (
    input?.protocolVersion !== LOCAL_AGENT_JOB_PROTOCOL_VERSION
    || input?.requestPath !== '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run'
    || input?.executionModeReason !== 'gpt_access_local_agent_capability'
    || !assignment
  ) {
    return null;
  }
  return input as unknown as LocalAgentJobEnvelope;
}

function buildLocalAgentJobEvent(
  job: JobData,
  eventType: JobEventType,
  metadata: Record<string, unknown> = {}
): RecordJobEventInput {
  const envelope = readLocalAgentJobEnvelope(job);
  return {
    jobId: job.id,
    eventType,
    traceId: envelope?.job.traceId ?? job.correlation_id ?? null,
    workerId: job.last_worker_id ?? job.worker_id,
    metadata: {
      jobType: LOCAL_AGENT_JOB_TYPE,
      action: envelope?.job.action ?? null,
      principal: envelope?.job.principal ?? null,
      workspace: envelope?.job.workspace ?? null,
      requestId: envelope?.job.requestId ?? null,
      deviceId: envelope?.job.deviceId ?? job.worker_id,
      authorizationDecision: envelope?.job.authorization.decision ?? null,
      authorizationEvidenceId: envelope?.job.authorization.evidenceId ?? null,
      ...metadata
    }
  };
}

async function persistLocalAgentJobEvent(
  client: PoolClient,
  job: JobData,
  eventType: JobEventType,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await recordJobEventWithClient(
    client,
    buildLocalAgentJobEvent(job, eventType, metadata)
  );
}

function emitBestEffortLocalAgentJobEvent(
  job: JobData,
  eventType: JobEventType,
  metadata: Record<string, unknown> = {}
): void {
  void recordJobEvent(buildLocalAgentJobEvent(job, eventType, metadata));
}

async function acquireLocalAgentLock(
  client: PoolClient,
  namespace: string,
  key: string
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [namespace, key]
  );
}

function classifyReuse(job: JobData): FindOrCreateLocalAgentJobResult['dedupeReason'] {
  return ['completed', 'failed', 'cancelled', 'expired'].includes(job.status)
    ? 'reused_terminal_result'
    : 'reused_inflight_job';
}

async function insertLocalAgentJobRow(
  client: PoolClient,
  jobId: string,
  options: FindOrCreateLocalAgentJobOptions
): Promise<JobData> {
  const autonomyState = {
    localAgent: {
      protocolVersion: LOCAL_AGENT_JOB_PROTOCOL_VERSION,
      action: options.envelope.job.action,
      principal: options.envelope.job.principal,
      workspace: options.envelope.job.workspace,
      deviceId: options.deviceId,
      requestId: options.envelope.job.requestId,
      authorizationDecision: options.envelope.job.authorization.decision
    }
  };
  const createdResult = await client.query(
    `INSERT INTO job_data (
       id,
       worker_id,
       job_type,
       status,
       input,
       retry_count,
       max_retries,
       next_run_at,
       priority,
       correlation_id,
       autonomy_state,
       request_fingerprint_hash,
       idempotency_key_hash,
       idempotency_scope_hash,
       idempotency_origin,
       idempotency_until,
       retention_until,
       expires_at
     )
     VALUES (
       $1::uuid,
       $2,
       $3,
       'pending',
       $4::jsonb,
       0,
       0,
       NOW(),
       100,
       $5,
       $6::jsonb,
       $7,
       $8,
       $9,
       $10,
       $11::timestamptz,
       $12::timestamptz,
       $13::timestamptz
     )
     RETURNING *`,
    [
      jobId,
      options.deviceId,
      LOCAL_AGENT_JOB_TYPE,
      serializeJson(options.envelope),
      options.envelope.job.traceId,
      serializeJson(autonomyState),
      options.requestFingerprintHash,
      options.idempotencyKeyHash,
      options.idempotencyScopeHash,
      options.idempotencyOrigin,
      options.idempotencyUntil,
      options.retentionUntil,
      options.expiresAt
    ]
  );
  const createdJob = createdResult.rows[0] as JobData;
  await persistLocalAgentJobEvent(client, createdJob, 'job.created');
  await persistLocalAgentJobEvent(client, createdJob, 'job.queued');
  return createdJob;
}

async function readIdempotencyBinding(
  client: PoolClient,
  options: FindOrCreateLocalAgentJobOptions
): Promise<{
  binding: LocalAgentIdempotencyBindingRow;
  job: JobData;
  reusable: boolean;
} | null> {
  const result = await client.query(
    `SELECT
       binding.*,
       row_to_json(job_row.*) AS linked_job,
       (
         job_row.status IN ('completed', 'failed', 'cancelled', 'expired')
         AND binding.idempotency_until <= NOW()
       ) AS binding_reusable
     FROM local_agent_job_idempotency AS binding
     INNER JOIN job_data AS job_row
       ON job_row.id = binding.job_id
      AND job_row.job_type = $1
     WHERE binding.principal_id = $2
       AND binding.workspace_id = $3
       AND binding.device_id = $4
       AND binding.action = $5
       AND binding.idempotency_key_hash = $6
     LIMIT 1
     FOR UPDATE OF binding, job_row`,
    [
      LOCAL_AGENT_JOB_TYPE,
      options.envelope.job.principal,
      options.envelope.job.workspace,
      options.deviceId,
      options.envelope.job.action,
      options.idempotencyKeyHash
    ]
  );
  const row = result.rows[0] as
    | (LocalAgentIdempotencyBindingRow & {
      linked_job: JobData;
      binding_reusable: boolean;
    })
    | undefined;
  if (!row) {
    return null;
  }
  const {
    linked_job: job,
    binding_reusable: bindingReusable,
    ...binding
  } = row;
  return { binding, job, reusable: bindingReusable };
}

async function cleanupExpiredLocalAgentIdempotencyBindings(
  client: PoolClient
): Promise<void> {
  await client.query(
    `WITH candidates AS (
       SELECT binding.id
       FROM local_agent_job_idempotency AS binding
       INNER JOIN job_data AS job_row
         ON job_row.id = binding.job_id
        AND job_row.job_type = $1
       WHERE binding.idempotency_until <= NOW()
         AND job_row.status IN ('completed', 'failed', 'cancelled', 'expired')
       ORDER BY binding.idempotency_until, binding.id
       FOR UPDATE OF binding SKIP LOCKED
       LIMIT $2
     )
     DELETE FROM local_agent_job_idempotency AS binding
     USING candidates
     WHERE binding.id = candidates.id`,
    [LOCAL_AGENT_JOB_TYPE, LOCAL_AGENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE]
  );
}

export async function findOrCreateLocalAgentJob(
  options: FindOrCreateLocalAgentJobOptions
): Promise<FindOrCreateLocalAgentJobResult> {
  assertDatabaseReady();

  try {
    return await transaction(async (client) => {
      await acquireLocalAgentLock(
        client,
        'job_data.local_agent.idempotency_scope',
        options.idempotencyScopeHash
      );
      await acquireLocalAgentLock(
        client,
        'job_data.local_agent.idempotency_key',
        options.idempotencyKeyHash
      );
      await recoverLocalAgentClaims(client, options.deviceId);
      await cleanupExpiredLocalAgentIdempotencyBindings(client);

      const candidateJobId = randomUUID();
      const insertedBinding = await client.query(
        `INSERT INTO local_agent_job_idempotency (
           principal_id,
           workspace_id,
           device_id,
           action,
           idempotency_key_hash,
           idempotency_scope_hash,
           request_fingerprint_hash,
           idempotency_origin,
           job_id,
           idempotency_until
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::timestamptz)
         ON CONFLICT (
           principal_id,
           workspace_id,
           device_id,
           action,
           idempotency_key_hash
         )
         DO NOTHING
         RETURNING *`,
        [
          options.envelope.job.principal,
          options.envelope.job.workspace,
          options.deviceId,
          options.envelope.job.action,
          options.idempotencyKeyHash,
          options.idempotencyScopeHash,
          options.requestFingerprintHash,
          options.idempotencyOrigin,
          candidateJobId,
          options.idempotencyUntil
        ]
      );

      if (insertedBinding.rowCount === 1) {
        const createdJob = await insertLocalAgentJobRow(client, candidateJobId, options);
        return {
          job: createdJob,
          created: true,
          deduped: false,
          dedupeReason: 'new_job'
        };
      }

      const existing = await readIdempotencyBinding(client, options);
      if (!existing) {
        throw new LocalAgentJobRepositoryError(
          'LOCAL_AGENT_JOB_STATE_CONFLICT',
          'The local-agent idempotency binding could not be resolved.'
        );
      }
      if (existing.binding.idempotency_scope_hash !== options.idempotencyScopeHash) {
        throw new LocalAgentJobRepositoryError(
          'LOCAL_AGENT_JOB_STATE_CONFLICT',
          'The local-agent idempotency scope does not match its database binding.'
        );
      }

      if (!existing.reusable) {
        if (existing.binding.request_fingerprint_hash !== options.requestFingerprintHash) {
          throw new LocalAgentJobRepositoryError(
            'LOCAL_AGENT_IDEMPOTENCY_CONFLICT',
            'The idempotency key is already bound to a different local-agent action or payload.'
          );
        }
        return {
          job: existing.job,
          created: false,
          deduped: true,
          dedupeReason: classifyReuse(existing.job)
        };
      }

      const replacedBinding = await client.query(
        `UPDATE local_agent_job_idempotency
         SET
           idempotency_scope_hash = $1,
           request_fingerprint_hash = $2,
           idempotency_origin = $3,
           job_id = $4::uuid,
           idempotency_until = $5::timestamptz,
           updated_at = NOW()
         WHERE id = $6
         RETURNING id`,
        [
          options.idempotencyScopeHash,
          options.requestFingerprintHash,
          options.idempotencyOrigin,
          candidateJobId,
          options.idempotencyUntil,
          existing.binding.id
        ]
      );
      if (replacedBinding.rowCount !== 1) {
        throw new LocalAgentJobRepositoryError(
          'LOCAL_AGENT_JOB_STATE_CONFLICT',
          'The local-agent idempotency binding changed before reuse.'
        );
      }
      const createdJob = await insertLocalAgentJobRow(client, candidateJobId, options);
      return {
        job: createdJob,
        created: true,
        deduped: false,
        dedupeReason: 'new_job'
      };
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === '42P01') {
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_JOBS_UNAVAILABLE',
        'The verified local-agent job hardening migration is not available.'
      );
    }
    throw error;
  }
}

async function recoverLocalAgentClaims(
  client: PoolClient,
  deviceId: string
): Promise<void> {
  const candidatesResult = await client.query(
    `SELECT *
     FROM job_data
     WHERE job_type = $1
       AND worker_id = $2
       AND status IN ('pending', 'running')
       AND (
         (expires_at IS NOT NULL AND expires_at <= NOW())
         OR (
           status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < NOW()
           AND (expires_at IS NULL OR expires_at > NOW())
         )
       )
     ORDER BY COALESCE(expires_at, lease_expires_at), created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $3`,
    [LOCAL_AGENT_JOB_TYPE, deviceId, LOCAL_AGENT_RECOVERY_BATCH_SIZE]
  );

  for (const [index, candidate] of (candidatesResult.rows as JobData[]).entries()) {
    const savepoint = `local_agent_recovery_${index}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const expired = await transitionExpiredLocalAgentJob(client, candidate);
      if (!expired) {
        await transitionLostLeaseLocalAgentJob(client, candidate);
      }
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      dbLogger.warn(
        'local_agent_job.recovery_failed',
        {
          module: 'local-agent-job-repository',
          operation: 'recoverLocalAgentClaims',
          jobId: candidate.id,
          deviceId
        },
        {
          errorType: error instanceof Error ? error.name : typeof error
        }
      );
    }
  }
}

async function transitionExpiredLocalAgentJob(
  client: PoolClient,
  currentJob: JobData
): Promise<JobData | null> {
  const updatedResult = await client.query(
    `UPDATE job_data
     SET
       status = CASE
         WHEN status = 'running'
           AND COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
           THEN 'failed'
         ELSE 'expired'
       END,
       error_message = COALESCE(
         error_message,
         CASE
           WHEN status = 'running'
             AND COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
             THEN 'Mutating local-agent assignment expired after execution began; manual reconciliation is required.'
           ELSE 'Local-agent job expired before execution completed.'
         END
       ),
       updated_at = NOW(),
       completed_at = COALESCE(completed_at, NOW()),
       last_heartbeat_at = NULL,
       lease_expires_at = NULL,
       autonomy_state = jsonb_set(
         COALESCE(autonomy_state, '{}'::jsonb),
         '{localAgent}',
         COALESCE(autonomy_state->'localAgent', '{}'::jsonb)
           || jsonb_build_object(
             'expiryReconciledAt', NOW(),
             'manualReconciliationRequired',
             status = 'running'
               AND COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
           ),
         true
       )
     WHERE id = $1
       AND job_type = $2
       AND status IN ('pending', 'running')
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
     RETURNING *`,
    [currentJob.id, LOCAL_AGENT_JOB_TYPE]
  );
  const updatedJob = updatedResult.rows[0] as JobData | undefined;
  if (!updatedJob) {
    return null;
  }

  const manualReconciliationRequired = updatedJob.status === 'failed';
  await persistLocalAgentJobEvent(
    client,
    updatedJob,
    manualReconciliationRequired ? 'job.failed' : 'job.expired',
    {
      priorStatus: currentJob.status,
      finalStatus: updatedJob.status,
      reason: manualReconciliationRequired
        ? 'mutation_expired_after_execution_started'
        : 'job_expired_before_completion',
      reconciledAt: new Date().toISOString(),
      failureCode: manualReconciliationRequired
        ? 'LOCAL_AGENT_MANUAL_RECONCILIATION_REQUIRED'
        : 'LOCAL_AGENT_JOB_EXPIRED',
      manualReconciliationRequired
    }
  );
  return updatedJob;
}

async function transitionLostLeaseLocalAgentJob(
  client: PoolClient,
  currentJob: JobData
): Promise<JobData | null> {
  const updatedResult = await client.query(
    `UPDATE job_data
     SET
       status = CASE
         WHEN COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
           THEN 'failed'
         ELSE 'pending'
       END,
       error_message = CASE
         WHEN COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
           THEN 'Mutating local-agent assignment lost its lease; manual reconciliation is required.'
         ELSE 'Read-only local-agent assignment was requeued after its lease expired.'
       END,
       retry_count = retry_count + 1,
       next_run_at = NOW(),
       updated_at = NOW(),
       completed_at = CASE
         WHEN COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
           THEN NOW()
         ELSE NULL
       END,
       started_at = CASE
         WHEN COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
           THEN started_at
         ELSE NULL
       END,
       last_heartbeat_at = NULL,
       lease_expires_at = NULL,
       last_worker_id = NULL,
       autonomy_state = jsonb_set(
         COALESCE(autonomy_state, '{}'::jsonb),
         '{localAgent}',
         (
           CASE
             WHEN COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)
               THEN COALESCE(autonomy_state->'localAgent', '{}'::jsonb)
             ELSE COALESCE(autonomy_state->'localAgent', '{}'::jsonb)
               - 'claimKeyHash'
               - 'claimedAt'
           END
         )
           || jsonb_build_object('leaseRecoveryAt', NOW(), 'manualReconciliationRequired',
             COALESCE((input->'job'->>'mayModifyFiles')::boolean, false)),
         true
       )
     WHERE id = $1
       AND job_type = $2
       AND status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING *`,
    [currentJob.id, LOCAL_AGENT_JOB_TYPE]
  );
  const updatedJob = updatedResult.rows[0] as JobData | undefined;
  if (!updatedJob) {
    return null;
  }

  if (updatedJob.status === 'failed') {
    await persistLocalAgentJobEvent(client, updatedJob, 'job.failed', {
      priorStatus: currentJob.status,
      finalStatus: updatedJob.status,
      reason: 'mutation_lease_lost_after_execution_started',
      reconciledAt: new Date().toISOString(),
      failureCode: 'LOCAL_AGENT_MANUAL_RECONCILIATION_REQUIRED',
      manualReconciliationRequired: true
    });
    return updatedJob;
  }

  const recoveryMetadata = {
    priorStatus: currentJob.status,
    finalStatus: updatedJob.status,
    reason: 'read_only_assignment_lease_expired',
    reconciledAt: new Date().toISOString(),
    retryCount: updatedJob.retry_count ?? null,
    manualReconciliationRequired: false
  };
  await persistLocalAgentJobEvent(
    client,
    updatedJob,
    'worker.stale_detected',
    recoveryMetadata
  );
  await persistLocalAgentJobEvent(
    client,
    updatedJob,
    'worker.recovered',
    recoveryMetadata
  );
  return updatedJob;
}

export async function reconcileExpiredLocalAgentJob(
  jobId: string
): Promise<JobData | null> {
  assertDatabaseReady();

  const result = await transaction(async (client) => {
    const currentResult = await client.query(
      `SELECT *
       FROM job_data
       WHERE id = $1
         AND job_type = $2
       LIMIT 1
       FOR UPDATE`,
      [jobId, LOCAL_AGENT_JOB_TYPE]
    );
    const currentJob = currentResult.rows[0] as JobData | undefined;
    if (!currentJob) {
      return null;
    }
    return (await transitionExpiredLocalAgentJob(client, currentJob)) ?? currentJob;
  });
  return result;
}

export async function claimLocalAgentJob(options: {
  deviceId: string;
  claimKeyHash: string;
  leaseMs: number;
  deviceScopes: readonly string[];
}): Promise<ClaimLocalAgentJobResult | null> {
  assertDatabaseReady();

  const result = await transaction(async (client) => {
    await acquireLocalAgentLock(
      client,
      'job_data.local_agent.device_claim',
      `${options.deviceId}:${options.claimKeyHash}`
    );
    await recoverLocalAgentClaims(client, options.deviceId);

    const replayResult = await client.query(
      `SELECT *
       FROM job_data
       WHERE job_type = $1
         AND worker_id = $2
         AND autonomy_state->'localAgent'->>'claimKeyHash' = $3
       ORDER BY updated_at DESC
       LIMIT 1
       FOR UPDATE`,
      [LOCAL_AGENT_JOB_TYPE, options.deviceId, options.claimKeyHash]
    );
    const replayJob = replayResult.rows[0] as JobData | undefined;
    if (replayJob && replayJob.status !== 'pending') {
      return {
        disposition: replayJob.status === 'running'
          ? 'CLAIM_REPLAY'
          : 'TERMINAL_REPLAY',
        job: replayJob
      } satisfies ClaimLocalAgentJobResult;
    }

    const claimState = serializeJson({
      claimKeyHash: options.claimKeyHash,
      claimedAt: new Date().toISOString()
    });
    const claimedResult = await client.query(
      `UPDATE job_data
       SET
         status = 'running',
         updated_at = NOW(),
         started_at = COALESCE(started_at, NOW()),
         last_heartbeat_at = NOW(),
         lease_expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond'),
         last_worker_id = $2,
         autonomy_state = jsonb_set(
           COALESCE(autonomy_state, '{}'::jsonb),
           '{localAgent}',
           COALESCE(autonomy_state->'localAgent', '{}'::jsonb) || $3::jsonb,
           true
         )
       WHERE id = (
         SELECT id
         FROM job_data
         WHERE job_type = $4
           AND worker_id = $2
           AND status = 'pending'
           AND next_run_at <= NOW()
           AND expires_at > NOW()
           AND COALESCE(input->'job'->'requiredDeviceScopes', '[]'::jsonb) <@ $5::jsonb
         ORDER BY priority ASC, next_run_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [
        Math.max(1_000, options.leaseMs),
        options.deviceId,
        claimState,
        LOCAL_AGENT_JOB_TYPE,
        serializeJson([...options.deviceScopes])
      ]
    );
    const claimedJob = claimedResult.rows[0] as JobData | undefined;
    if (!claimedJob) {
      return null;
    }
    await persistLocalAgentJobEvent(client, claimedJob, 'job.claimed', {
      leaseMs: Math.max(1_000, options.leaseMs)
    });
    await persistLocalAgentJobEvent(client, claimedJob, 'job.started');
    return {
      disposition: 'CLAIMED',
      job: claimedJob
    } satisfies ClaimLocalAgentJobResult;
  });
  return result;
}

export async function heartbeatLocalAgentJob(options: {
  jobId: string;
  deviceId: string;
  leaseMs: number;
}): Promise<JobData | null> {
  assertDatabaseReady();

  const result = await transaction(async (client) => {
    const heartbeatResult = await client.query(
      `UPDATE job_data
       SET
         updated_at = NOW(),
         last_heartbeat_at = NOW(),
         lease_expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond')
       WHERE id = $2
         AND job_type = $3
         AND worker_id = $4
         AND last_worker_id = $4
         AND status = 'running'
         AND lease_expires_at >= NOW()
         AND expires_at > NOW()
       RETURNING *`,
      [
        Math.max(1_000, options.leaseMs),
        options.jobId,
        LOCAL_AGENT_JOB_TYPE,
        options.deviceId
      ]
    );
    return (heartbeatResult.rows[0] as JobData | undefined) ?? null;
  });

  if (result) {
    emitBestEffortLocalAgentJobEvent(result, 'worker.heartbeat', {
      leaseMs: Math.max(1_000, options.leaseMs)
    });
  }
  return result;
}

export async function getLocalAgentJobForDevice(
  jobId: string,
  deviceId: string
): Promise<JobData | null> {
  assertDatabaseReady();
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT *
       FROM job_data
       WHERE id = $1
         AND job_type = $2
         AND worker_id = $3
       LIMIT 1`,
      [jobId, LOCAL_AGENT_JOB_TYPE, deviceId]
    );
    return (result.rows[0] as JobData | undefined) ?? null;
  });
}

function assertResultCorrelation(
  job: JobData,
  options: SubmitLocalAgentJobResultOptions
): void {
  const envelope = readLocalAgentJobEnvelope(job);
  if (
    !envelope
    || envelope.job.deviceId !== options.correlation.deviceId
    || envelope.job.traceId !== options.correlation.traceId
    || envelope.job.requestId !== options.correlation.requestId
  ) {
    throw new LocalAgentJobRepositoryError(
      'LOCAL_AGENT_RESULT_CORRELATION_MISMATCH',
      'Local-agent result correlation does not match the authorized assignment.'
    );
  }
}

export async function submitLocalAgentJobResult(
  options: SubmitLocalAgentJobResultOptions
): Promise<SubmitLocalAgentJobResult> {
  assertDatabaseReady();
  const manualReconciliationRequired =
    options.outcome === 'failed'
    && options.error?.code === 'LOCAL_EFFECT_OUTCOME_UNKNOWN';

  const result = await transaction(async (client) => {
    const currentResult = await client.query(
      `SELECT *
       FROM job_data
       WHERE id = $1
         AND job_type = $2
         AND worker_id = $3
       LIMIT 1
       FOR UPDATE`,
      [options.jobId, LOCAL_AGENT_JOB_TYPE, options.deviceId]
    );
    const currentJob = currentResult.rows[0] as JobData | undefined;
    if (!currentJob) {
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_JOB_NOT_FOUND',
        'The local-agent job was not found for this device.'
      );
    }
    assertResultCorrelation(currentJob, options);

    const localAgentState = readLocalAgentState(currentJob);
    if (['completed', 'failed', 'cancelled', 'expired'].includes(currentJob.status)) {
      if (
        localAgentState.resultKeyHash === options.resultKeyHash
        && localAgentState.resultFingerprintHash === options.resultFingerprintHash
      ) {
        return { job: currentJob, replayed: true } satisfies SubmitLocalAgentJobResult;
      }
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_RESULT_CONFLICT',
        'The local-agent job already has a different terminal result.'
      );
    }
    const jobExpiry = currentJob.expires_at
      ? new Date(currentJob.expires_at).getTime()
      : Number.NaN;
    if (!Number.isFinite(jobExpiry) || jobExpiry <= Date.now()) {
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_JOB_LEASE_EXPIRED',
        'The local-agent job expired before the result was submitted.'
      );
    }
    if (currentJob.status !== 'running' || currentJob.last_worker_id !== options.deviceId) {
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_JOB_STATE_CONFLICT',
        'The local-agent job is not actively leased to this device.'
      );
    }
    const leaseExpiry = currentJob.lease_expires_at
      ? new Date(currentJob.lease_expires_at).getTime()
      : Number.NaN;
    if (!Number.isFinite(leaseExpiry) || leaseExpiry < Date.now()) {
      throw new LocalAgentJobRepositoryError(
        'LOCAL_AGENT_JOB_LEASE_EXPIRED',
        'The local-agent job lease expired before the result was submitted.'
      );
    }

    const terminalStatus = options.outcome === 'succeeded' ? 'completed' : 'failed';
    const persistedOutput = {
      protocolVersion: LOCAL_AGENT_JOB_PROTOCOL_VERSION,
      outcome: options.outcome,
      ...(options.output === undefined ? {} : { output: options.output }),
      ...(options.error === undefined ? {} : { error: options.error }),
      metrics: options.metrics,
      correlation: options.correlation
    };
    const resultState = serializeJson({
      resultKeyHash: options.resultKeyHash,
      resultFingerprintHash: options.resultFingerprintHash,
      resultSubmittedAt: new Date().toISOString(),
      ...(manualReconciliationRequired ? { manualReconciliationRequired: true } : {})
    });
    const updatedResult = await client.query(
      `UPDATE job_data
       SET
         status = $1,
         output = $2::jsonb,
         error_message = $3,
         updated_at = NOW(),
         completed_at = NOW(),
         last_heartbeat_at = NULL,
         lease_expires_at = NULL,
         autonomy_state = jsonb_set(
           COALESCE(autonomy_state, '{}'::jsonb),
           '{localAgent}',
           COALESCE(autonomy_state->'localAgent', '{}'::jsonb) || $4::jsonb,
           true
         )
       WHERE id = $5
       RETURNING *`,
      [
        terminalStatus,
        serializeJson(persistedOutput),
        options.error?.message ?? null,
        resultState,
        options.jobId
      ]
    );
    const updatedJob = updatedResult.rows[0] as JobData;
    await persistLocalAgentJobEvent(
      client,
      updatedJob,
      options.outcome === 'succeeded' ? 'job.completed' : 'job.failed',
      {
        durationMs: options.metrics.durationMs,
        outputTruncated: options.metrics.outputTruncated,
        failureCode: options.error?.code ?? null,
        ...(manualReconciliationRequired ? { manualReconciliationRequired: true } : {})
      }
    );
    return {
      job: updatedJob,
      replayed: false
    } satisfies SubmitLocalAgentJobResult;
  });
  return result;
}
