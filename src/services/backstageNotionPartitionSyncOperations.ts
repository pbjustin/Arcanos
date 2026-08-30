import { createHash, timingSafeEqual } from 'node:crypto';
import type { JobData } from '@core/db/schema.js';
import {
  BackstageNotionPartitionSyncInProgressError,
  BackstageNotionPartitionSyncQueueSaturatedError,
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError,
  findOrCreateBackstageNotionPartitionSyncJob,
  getJobById,
  type FindOrCreateBackstageNotionPartitionSyncJobOptions,
  type FindOrCreateBackstageNotionPartitionSyncJobResult,
} from '@core/db/repositories/jobRepository.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
  isBackstageNotionPartitionSyncWriterEnabled,
  isBackstageNotionUniverseId,
  parseBackstageNotionPartitionConfiguration,
  parseBackstageNotionPartitionedIndexMode,
  resolveBackstageNotionPartitionUniverse,
  type BackstageNotionPartitionConfiguration,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_WINDOW_MS,
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
  BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
  parseBackstageNotionPartitionSyncJobInput,
  parseBackstageNotionPartitionSyncJobResult,
  parseBackstageNotionPartitionSyncRequestBody,
  type BackstageNotionPartitionSyncJobInput,
  type BackstageNotionPartitionSyncJobResult,
} from '@shared/jobs/backstageNotionPartitionSyncJob.js';

const ACTOR_SCOPE_HASH_DOMAIN =
  'arcanos:backstage-notion-partition-sync:actor-scope:v1';
const IDEMPOTENCY_KEY_HASH_DOMAIN =
  'arcanos:backstage-notion-partition-sync:idempotency-key:v1';
const REQUEST_FINGERPRINT_HASH_DOMAIN =
  'arcanos:backstage-notion-partition-sync:request-fingerprint:v1';
const DEFAULT_SYNC_WORKER_ID = 'backstage-notion-partition-sync';
const IDEMPOTENCY_KEY_MIN_CHARACTERS = 8;
const IDEMPOTENCY_KEY_MAX_CHARACTERS = 240;
const ACTOR_KEY_MAX_CHARACTERS = 512;
const CORRELATION_ID_MAX_CHARACTERS = 128;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]+$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

type ReadEnvironment = (name: string) => string | undefined;
type FindOrCreateSyncJob = (
  options: FindOrCreateBackstageNotionPartitionSyncJobOptions
) => Promise<FindOrCreateBackstageNotionPartitionSyncJobResult>;
type GetJobById = (jobId: string) => Promise<JobData | null>;

type ValidPartitionConfiguration = Extract<
  BackstageNotionPartitionConfiguration,
  { status: 'valid' }
>;

export type BackstageNotionPartitionSyncPublicStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BackstageNotionPartitionSyncOperationHttpResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
}

export interface BackstageNotionPartitionSyncOperationDependencies {
  readonly readEnvironment: ReadEnvironment;
  readonly findOrCreateSyncJob: FindOrCreateSyncJob;
  readonly getJob: GetJobById;
  readonly now: () => Date;
  readonly workerId: string;
}

export interface EnqueueBackstageNotionPartitionSyncOperationInput {
  readonly universeId: string;
  readonly body: unknown;
  readonly actorKey: string;
  readonly idempotencyKey: string | null | undefined;
  readonly correlationId?: string | null;
  readonly dependencies?: Partial<BackstageNotionPartitionSyncOperationDependencies>;
}

export interface GetBackstageNotionPartitionSyncOperationStatusInput {
  readonly universeId: string;
  readonly syncId: string;
  readonly actorKey: string;
  readonly dependencies?: Partial<BackstageNotionPartitionSyncOperationDependencies>;
}

function sha256(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function normalizeActorKey(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > ACTOR_KEY_MAX_CHARACTERS
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length < IDEMPOTENCY_KEY_MIN_CHARACTERS
    || value.length > IDEMPOTENCY_KEY_MAX_CHARACTERS
    || value !== value.trim()
    || !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeCorrelationId(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > CORRELATION_ID_MAX_CHARACTERS
    || value !== value.trim()
    || !CORRELATION_ID_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function hashesEqual(left: unknown, right: string): boolean {
  if (
    typeof left !== 'string'
    || !SHA256_PATTERN.test(left)
    || !SHA256_PATTERN.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function resolveDependencies(
  overrides: Partial<BackstageNotionPartitionSyncOperationDependencies> | undefined
): BackstageNotionPartitionSyncOperationDependencies {
  return {
    readEnvironment: overrides?.readEnvironment ?? (name => getEnv(name)),
    findOrCreateSyncJob:
      overrides?.findOrCreateSyncJob ?? findOrCreateBackstageNotionPartitionSyncJob,
    getJob: overrides?.getJob ?? getJobById,
    now: overrides?.now ?? (() => new Date()),
    workerId: overrides?.workerId ?? DEFAULT_SYNC_WORKER_ID,
  };
}

function response(
  statusCode: number,
  payload: Record<string, unknown>,
  retryAfterSeconds?: number
): BackstageNotionPartitionSyncOperationHttpResult {
  return retryAfterSeconds === undefined
    ? Object.freeze({ statusCode, payload: Object.freeze(payload) })
    : Object.freeze({
      statusCode,
      payload: Object.freeze(payload),
      retryAfterSeconds,
    });
}

function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  retryAfterSeconds?: number
): BackstageNotionPartitionSyncOperationHttpResult {
  return response(statusCode, {
    ok: false,
    error: Object.freeze({ code, message }),
  }, retryAfterSeconds);
}

function notFoundResponse(): BackstageNotionPartitionSyncOperationHttpResult {
  return errorResponse(
    404,
    'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
    'The partition synchronization was not found.'
  );
}

function configurationUnavailableResponse(): BackstageNotionPartitionSyncOperationHttpResult {
  return errorResponse(
    503,
    'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_UNAVAILABLE',
    'Partition synchronization configuration is unavailable.'
  );
}

function resolveEnabledConfiguration(
  readEnvironment: ReadEnvironment
):
  | Readonly<{ status: 'enabled'; configuration: ValidPartitionConfiguration }>
  | Readonly<{ status: 'disabled' | 'unavailable' }> {
  let rawMode: string | undefined;
  try {
    rawMode = readEnvironment(BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME);
  } catch {
    return Object.freeze({ status: 'unavailable' as const });
  }
  const mode = parseBackstageNotionPartitionedIndexMode(rawMode);
  if (!isBackstageNotionPartitionSyncWriterEnabled(mode)) {
    return Object.freeze({ status: 'disabled' as const });
  }

  let rawConfiguration: string | undefined;
  try {
    rawConfiguration = readEnvironment(BACKSTAGE_NOTION_PARTITIONS_ENV_NAME);
  } catch {
    return Object.freeze({ status: 'unavailable' as const });
  }
  const configuration = parseBackstageNotionPartitionConfiguration(rawConfiguration);
  if (configuration.status !== 'valid') {
    return Object.freeze({ status: 'unavailable' as const });
  }
  return Object.freeze({ status: 'enabled' as const, configuration });
}

function buildActorScopeHash(actorKey: string): string {
  return sha256(ACTOR_SCOPE_HASH_DOMAIN, actorKey);
}

function buildSyncStatusUrl(universeId: string, syncId: string): string {
  return `/api/backstage/notion-partitions/${encodeURIComponent(universeId)}/syncs/${syncId}`;
}

function mapStoredJobStatus(value: unknown): BackstageNotionPartitionSyncPublicStatus | null {
  switch (value) {
    case 'pending':
      return 'queued';
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return null;
  }
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function hasConsistentStatusTimestamps(
  job: JobData,
  publicStatus: BackstageNotionPartitionSyncPublicStatus
): boolean {
  if (
    !isFiniteDate(job.created_at)
    || !isFiniteDate(job.updated_at)
    || job.updated_at.getTime() < job.created_at.getTime()
  ) {
    return false;
  }
  const completedAt = job.completed_at;
  const terminal = publicStatus === 'completed'
    || publicStatus === 'failed'
    || publicStatus === 'cancelled';
  if (!terminal) {
    return completedAt === undefined || completedAt === null;
  }
  return isFiniteDate(completedAt)
    && completedAt.getTime() >= job.created_at.getTime()
    && completedAt.getTime() <= job.updated_at.getTime();
}

function projectResult(
  result: BackstageNotionPartitionSyncJobResult
): Record<string, unknown> {
  return Object.freeze({
    outcome: result.outcome,
    safeReasonCode: result.safeReasonCode,
    fullSourceScan: result.fullSourceScan,
    manifestStatus: result.manifestStatus,
    manifestId: result.manifestId,
    freshSnapshotId: result.freshSnapshotId,
    pageCount: result.pageCount,
    chunkCount: result.chunkCount,
    pageVersionReuseCount: result.pageVersionReuseCount,
    embeddedChunkCount: result.embeddedChunkCount,
    pageChanges: Object.freeze({ ...result.pageChanges }),
  });
}

function validateOwnedSyncJob(input: {
  readonly job: JobData | null;
  readonly requestedSyncId: string;
  readonly requestedUniverseId: string;
  readonly actorScopeHash: string;
}): Readonly<{
  job: JobData;
  jobInput: BackstageNotionPartitionSyncJobInput;
  publicStatus: BackstageNotionPartitionSyncPublicStatus;
}> | null {
  const { job } = input;
  if (
    !job
    || job.id !== input.requestedSyncId
    || job.job_type !== BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE
    || !hashesEqual(job.idempotency_scope_hash, input.actorScopeHash)
  ) {
    return null;
  }
  const jobInput = parseBackstageNotionPartitionSyncJobInput(job.input);
  const publicStatus = mapStoredJobStatus(job.status);
  if (
    !jobInput
    || jobInput.universeId !== input.requestedUniverseId
    || !publicStatus
  ) {
    return null;
  }
  return Object.freeze({ job, jobInput, publicStatus });
}

/** Enqueue one exact configured shard synchronization without persisting caller secrets. */
export async function enqueueBackstageNotionPartitionSyncOperation(
  input: EnqueueBackstageNotionPartitionSyncOperationInput
): Promise<BackstageNotionPartitionSyncOperationHttpResult> {
  const dependencies = resolveDependencies(input.dependencies);
  const actorKey = normalizeActorKey(input.actorKey);
  if (!actorKey) {
    return errorResponse(
      401,
      'BACKSTAGE_NOTION_PARTITION_SYNC_AUTHENTICATION_REQUIRED',
      'Authenticated operator context is required.'
    );
  }
  const requestBody = parseBackstageNotionPartitionSyncRequestBody(input.body);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!requestBody || !idempotencyKey) {
    return errorResponse(
      400,
      'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID',
      'The partition synchronization request is invalid.'
    );
  }

  const enabledConfiguration = resolveEnabledConfiguration(
    dependencies.readEnvironment
  );
  if (enabledConfiguration.status === 'disabled') {
    return errorResponse(
      409,
      'BACKSTAGE_NOTION_PARTITION_SYNC_DISABLED',
      'Partition synchronization is disabled.'
    );
  }
  if (enabledConfiguration.status !== 'enabled') {
    return configurationUnavailableResponse();
  }
  if (!isBackstageNotionUniverseId(input.universeId)) {
    return errorResponse(
      404,
      'BACKSTAGE_NOTION_PARTITION_SYNC_TARGET_NOT_FOUND',
      'The requested partition synchronization target was not found.'
    );
  }

  const configuredUniverse = resolveBackstageNotionPartitionUniverse(
    enabledConfiguration.configuration,
    input.universeId
  );
  const configuredShard = configuredUniverse?.shards.find(
    shard => shard.shardKey === requestBody.shardKey
  );
  if (!configuredUniverse || !configuredShard) {
    return errorResponse(
      404,
      'BACKSTAGE_NOTION_PARTITION_SYNC_TARGET_NOT_FOUND',
      'The requested partition synchronization target was not found.'
    );
  }

  let now: Date;
  try {
    now = dependencies.now();
  } catch {
    return errorResponse(
      500,
      'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
      'Failed to enqueue partition synchronization.'
    );
  }
  if (!isFiniteDate(now)) {
    return errorResponse(
      500,
      'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
      'Failed to enqueue partition synchronization.'
    );
  }
  const jobInput: BackstageNotionPartitionSyncJobInput = Object.freeze({
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    universeId: configuredUniverse.universeId,
    shardKey: configuredShard.shardKey,
    configurationGeneration: enabledConfiguration.configuration.generation,
    configurationDigest: enabledConfiguration.configuration.semanticDigest,
  });
  const actorScopeHash = buildActorScopeHash(actorKey);
  const idempotencyKeyHash = sha256(
    IDEMPOTENCY_KEY_HASH_DOMAIN,
    `${actorScopeHash}\0${idempotencyKey}`
  );
  const requestFingerprintHash = sha256(
    REQUEST_FINGERPRINT_HASH_DOMAIN,
    JSON.stringify(jobInput)
  );
  const idempotencyUntil = new Date(
    now.getTime() + BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_WINDOW_MS
  );

  try {
    const admitted = await dependencies.findOrCreateSyncJob({
      workerId: dependencies.workerId,
      input: jobInput,
      universeId: configuredUniverse.universeId,
      shardKey: configuredShard.shardKey,
      requestFingerprintHash,
      idempotencyScopeHash: actorScopeHash,
      idempotencyKeyHash,
      idempotencyUntil,
      correlationId: normalizeCorrelationId(input.correlationId),
    });
    const publicStatus = mapStoredJobStatus(admitted.job.status);
    const persistedInput = parseBackstageNotionPartitionSyncJobInput(
      admitted.job.input
    );
    if (
      !UUID_PATTERN.test(admitted.job.id)
      || admitted.job.job_type !== BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE
      || !hashesEqual(admitted.job.idempotency_scope_hash, actorScopeHash)
      || !publicStatus
      || !persistedInput
      || persistedInput.universeId !== configuredUniverse.universeId
      || persistedInput.shardKey !== configuredShard.shardKey
      || persistedInput.configurationGeneration
        !== enabledConfiguration.configuration.generation
      || persistedInput.configurationDigest
        !== enabledConfiguration.configuration.semanticDigest
    ) {
      return errorResponse(
        500,
        'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
        'Failed to enqueue partition synchronization.'
      );
    }
    return response(admitted.created ? 202 : 200, {
      ok: true,
      syncId: admitted.job.id,
      universeId: configuredUniverse.universeId,
      shardKey: configuredShard.shardKey,
      status: publicStatus,
      deduplicated: admitted.deduped,
      statusUrl: buildSyncStatusUrl(
        configuredUniverse.universeId,
        admitted.job.id
      ),
    });
  } catch (error: unknown) {
    if (error instanceof IdempotencyKeyConflictError) {
      return errorResponse(
        409,
        'BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_CONFLICT',
        'The idempotency key is already bound to a different synchronization request.'
      );
    }
    if (error instanceof BackstageNotionPartitionSyncInProgressError) {
      return errorResponse(
        409,
        'BACKSTAGE_NOTION_PARTITION_SYNC_IN_PROGRESS',
        'The requested partition shard is already synchronizing.',
        5
      );
    }
    if (error instanceof BackstageNotionPartitionSyncQueueSaturatedError) {
      return errorResponse(
        429,
        'BACKSTAGE_NOTION_PARTITION_SYNC_QUEUE_SATURATED',
        'The partition synchronization queue is at capacity.',
        30
      );
    }
    if (error instanceof JobRepositoryUnavailableError) {
      return errorResponse(
        503,
        'BACKSTAGE_NOTION_PARTITION_SYNC_JOBS_UNAVAILABLE',
        'Durable partition synchronization is unavailable.',
        30
      );
    }
    return errorResponse(
      500,
      'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
      'Failed to enqueue partition synchronization.'
    );
  }
}

/** Read one actor-owned synchronization through a bounded, redacted projection. */
export async function getBackstageNotionPartitionSyncOperationStatus(
  input: GetBackstageNotionPartitionSyncOperationStatusInput
): Promise<BackstageNotionPartitionSyncOperationHttpResult> {
  const actorKey = normalizeActorKey(input.actorKey);
  if (!actorKey || !UUID_PATTERN.test(input.syncId)) {
    return notFoundResponse();
  }
  const dependencies = resolveDependencies(input.dependencies);
  const actorScopeHash = buildActorScopeHash(actorKey);
  let job: JobData | null;
  try {
    job = await dependencies.getJob(input.syncId);
  } catch (error: unknown) {
    if (error instanceof JobRepositoryUnavailableError) {
      return errorResponse(
        503,
        'BACKSTAGE_NOTION_PARTITION_SYNC_JOBS_UNAVAILABLE',
        'Durable partition synchronization is unavailable.',
        30
      );
    }
    return errorResponse(
      500,
      'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
      'Failed to read partition synchronization status.'
    );
  }
  const owned = validateOwnedSyncJob({
    job,
    requestedSyncId: input.syncId,
    requestedUniverseId: input.universeId,
    actorScopeHash,
  });
  if (!owned) {
    return notFoundResponse();
  }
  if (!hasConsistentStatusTimestamps(owned.job, owned.publicStatus)) {
    return notFoundResponse();
  }

  let projectedResult: Record<string, unknown> | null = null;
  if (owned.publicStatus === 'completed') {
    const parsedResult = parseBackstageNotionPartitionSyncJobResult(
      owned.job.output
    );
    if (
      !parsedResult
      || parsedResult.universeId !== owned.jobInput.universeId
      || parsedResult.shardKey !== owned.jobInput.shardKey
    ) {
      return notFoundResponse();
    }
    projectedResult = projectResult(parsedResult);
  }

  const completedAt = owned.job.completed_at;
  return response(200, {
    ok: true,
    syncId: owned.job.id,
    universeId: owned.jobInput.universeId,
    shardKey: owned.jobInput.shardKey,
    status: owned.publicStatus,
    result: projectedResult,
    createdAt: owned.job.created_at.toISOString(),
    updatedAt: owned.job.updated_at.toISOString(),
    completedAt: isFiniteDate(completedAt) ? completedAt.toISOString() : null,
  });
}
