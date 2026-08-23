#!/usr/bin/env node
/**
 * Read-only durable-state attestor for the isolated Backstage heavy-flow proof.
 *
 * This script is designed to run through `railway ssh` inside the exact worker
 * service after the HTTP probe completes. It neither initializes schema nor
 * decrypts payloads. Database access and loopback inspection are dual-gated,
 * bounded, and reduced to booleans/counts before anything is printed.
 */

import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
} from './railway-backstage-heavy-openai-fixture.mjs';
import {
  resolveBackstageHeavyProofTargetOrThrow,
} from './railway-backstage-heavy-proof-supervisor.mjs';

export const BACKSTAGE_HEAVY_AT_REST_TARGET =
  'dedicated-backstage-heavy-preview';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ENVIRONMENT_PATTERN =
  /^backstage-heavy-pr-[1-9]\d*-e2e(?:-[a-z0-9]{1,16})?$/u;
const CANONICAL_IDS = new Set([
  '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  'fb583147-6c39-4343-9267-500f357d25ab',
  '1765befb-b805-4051-9af9-28634e986886',
  'c4ade025-3f13-4fca-9309-5d0dd81396fe',
  '6647b5b1-d796-4783-b5f0-b8e356019ca6',
  '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
]);
const EXPECTED_WORKER_ID = 'backstage-heavy-proof-worker-v1';
const DATABASE_POLL_TIMEOUT_MS = 15_000;
const DATABASE_POLL_INTERVAL_MS = 250;
const LOOPBACK_TIMEOUT_MS = 5_000;
const MAX_LOOPBACK_RESPONSE_BYTES = 64 * 1024;

const AT_REST_QUERY = `
WITH target AS (
  SELECT
    job_type,
    status,
    claim_generation,
    input,
    output,
    error_message,
    retry_count,
    started_at,
    last_heartbeat_at,
    lease_expires_at,
    last_worker_id,
    stats_worker_id,
    correlation_id,
    request_fingerprint_hash,
    idempotency_key_hash,
    idempotency_scope_hash,
    idempotency_origin,
    cancel_requested_at,
    cancel_reason,
    created_at,
    completed_at
  FROM public.job_data
  WHERE id = $1::uuid
),
events AS (
  SELECT
    COUNT(*)::integer AS total_count,
    COUNT(*) FILTER (WHERE event_type = 'job.created')::integer AS created_count,
    COUNT(*) FILTER (WHERE event_type = 'job.queued')::integer AS queued_count,
    COUNT(*) FILTER (WHERE event_type = 'job.claimed')::integer AS claimed_count,
    COUNT(*) FILTER (WHERE event_type = 'job.started')::integer AS started_count,
    COUNT(*) FILTER (WHERE event_type = 'ai.request.started')::integer AS ai_started_count,
    COUNT(*) FILTER (WHERE event_type = 'ai.request.completed')::integer AS ai_completed_count,
    COUNT(*) FILTER (WHERE event_type = 'worker.heartbeat')::integer AS heartbeat_count,
    COUNT(*) FILTER (WHERE event_type = 'job.completed')::integer AS completed_count,
    COUNT(*) FILTER (
      WHERE event_type IN (
        'ai.request.failed',
        'job.retry.scheduled',
        'job.failed',
        'job.cancelled',
        'job.expired',
        'worker.stale_detected',
        'worker.recovered'
      )
    )::integer AS failure_count,
    COUNT(*) FILTER (
      WHERE event_type NOT IN (
        'job.created',
        'job.queued',
        'job.claimed',
        'job.started',
        'ai.request.started',
        'ai.request.completed',
        'worker.heartbeat',
        'job.completed'
      )
    )::integer AS unexpected_count,
    COUNT(*) FILTER (WHERE trace_id IS DISTINCT FROM $3::text)::integer
      AS trace_mismatch_count,
    COUNT(*) FILTER (
      WHERE event_type IN (
        'job.claimed',
        'job.started',
        'worker.heartbeat',
        'job.completed'
      )
      AND worker_id IS DISTINCT FROM $7::text
    )::integer AS worker_mismatch_count,
    COUNT(*) FILTER (
      WHERE event_type IN ('ai.request.started', 'ai.request.completed')
      AND metadata->>'model' IS DISTINCT FROM 'gpt-5.1'
    )::integer AS ai_model_mismatch_count,
    COUNT(*) FILTER (
      WHERE event_type IN ('ai.request.started', 'ai.request.completed')
      AND (
        metadata->>'provider' IS DISTINCT FROM 'openai'
        OR metadata->>'operation' IS DISTINCT FROM 'responses_create'
        OR metadata->>'sourceType' IS DISTINCT FROM 'job'
        OR metadata->>'sourceName' IS DISTINCT FROM 'gpt'
      )
    )::integer AS ai_context_mismatch_count,
    COALESCE(MAX(duration_ms) FILTER (
      WHERE event_type = 'ai.request.completed'
    ), 0)::integer AS maximum_ai_duration_ms,
    COALESCE(EXTRACT(EPOCH FROM (
      MAX(occurred_at) FILTER (WHERE event_type = 'worker.heartbeat')
      - MIN(occurred_at) FILTER (WHERE event_type = 'worker.heartbeat')
    )) * 1000, 0)::bigint AS heartbeat_span_ms,
    MIN(occurred_at) FILTER (WHERE event_type = 'job.created')
      <= MAX(occurred_at) FILTER (WHERE event_type = 'job.completed')
      AS lifecycle_time_ordered
  FROM public.job_events
  WHERE job_id = $1::uuid
)
SELECT
  (SELECT COUNT(*)::integer FROM public.job_data) AS total_job_rows,
  (SELECT COUNT(*)::integer FROM public.job_events) AS total_event_rows,
  EXISTS (SELECT 1 FROM target) AS target_exists,
  COALESCE((SELECT
    job_type = 'gpt'
    AND status = 'completed'
    AND claim_generation = 1
    AND retry_count = 0
    AND error_message IS NULL
    AND output IS NOT NULL
    AND started_at IS NOT NULL
    AND completed_at IS NOT NULL
    AND created_at <= started_at
    AND started_at <= completed_at
    AND last_worker_id = $7::text
    AND stats_worker_id = $7::text
    AND last_heartbeat_at IS NULL
    AND lease_expires_at IS NULL
    AND cancel_requested_at IS NULL
    AND cancel_reason IS NULL
    AND correlation_id = $3::text
  FROM target), false) AS terminal_valid,
  COALESCE((SELECT
    idempotency_origin = 'derived'
    AND idempotency_key_hash IS NULL
    AND request_fingerprint_hash ~ '^[0-9a-f]{64}$'
    AND idempotency_scope_hash ~ '^[0-9a-f]{64}$'
    AND (
      SELECT COUNT(*)
      FROM public.job_data lineage
      WHERE lineage.idempotency_origin = 'derived'
        AND lineage.idempotency_key_hash IS NULL
        AND lineage.idempotency_scope_hash = target.idempotency_scope_hash
        AND lineage.request_fingerprint_hash = target.request_fingerprint_hash
    ) = 1
  FROM target), false) AS derived_idempotency_valid,
  COALESCE((SELECT
    jsonb_typeof(input) = 'object'
    AND input ?& ARRAY[
      'gptId',
      'protectedBackstage',
      'requestId',
      'traceId',
      'correlationId',
      'routeHint',
      'requestPath',
      'executionModeReason'
    ]
    AND (SELECT COUNT(*) FROM jsonb_object_keys(input)) = 8
    AND input->>'gptId' = 'backstage-booker'
    AND input->>'requestId' = $2::text
    AND input->>'traceId' = $3::text
    AND input->>'correlationId' = $3::text
    AND input->>'routeHint' = 'generateBooking'
    AND input->>'requestPath' = '/gpt/backstage-booker'
    AND input->>'executionModeReason' = 'backstage_prompt_size'
    AND NOT input ?| ARRAY['body', 'prompt', 'payload']
    AND jsonb_typeof(input->'protectedBackstage') = 'object'
    AND (input->'protectedBackstage') ?& ARRAY[
      'version', 'source', 'envelopeId', 'action', 'universeId', 'sealedPayload'
    ]
    AND (
      SELECT COUNT(*)
      FROM jsonb_object_keys(input->'protectedBackstage')
    ) = 6
    AND input->'protectedBackstage'->>'version' = '1'
    AND input->'protectedBackstage'->>'source' = 'backstage-booker-http'
    AND input->'protectedBackstage'->>'action' = 'generateBooking'
    AND input->'protectedBackstage'->>'universeId' = $8::text
    AND input->'protectedBackstage'->>'envelopeId'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(input->'protectedBackstage'->'sealedPayload') = 'object'
    AND (input->'protectedBackstage'->'sealedPayload') ?& ARRAY[
      'version', 'algorithm', 'purpose', 'keyId', 'iv', 'ciphertext', 'authTag'
    ]
    AND (
      SELECT COUNT(*)
      FROM jsonb_object_keys(input->'protectedBackstage'->'sealedPayload')
    ) = 7
    AND input->'protectedBackstage'->'sealedPayload'->>'version' = '1'
    AND input->'protectedBackstage'->'sealedPayload'->>'algorithm' = 'A256GCM'
    AND input->'protectedBackstage'->'sealedPayload'->>'purpose'
      = 'backstage-booker-job-input'
    AND input->'protectedBackstage'->'sealedPayload'->>'keyId'
      ~ '^[A-Za-z0-9_-]{43}$'
    AND LENGTH(input->'protectedBackstage'->'sealedPayload'->>'iv') = 16
    AND LENGTH(input->'protectedBackstage'->'sealedPayload'->>'ciphertext') > 0
    AND LENGTH(input->'protectedBackstage'->'sealedPayload'->>'authTag') = 24
  FROM target), false) AS protected_input_valid,
  COALESCE((SELECT
    jsonb_typeof(output) = 'object'
    AND output ?& ARRAY[
      'version', 'source', 'gptId', 'action', 'universeId', 'sealedPayload'
    ]
    AND (SELECT COUNT(*) FROM jsonb_object_keys(output)) = 6
    AND output->>'version' = '1'
    AND output->>'source' = 'backstage-booker-worker'
    AND output->>'gptId' = 'backstage-booker'
    AND output->>'action' = 'generateBooking'
    AND output->>'universeId' = $8::text
    AND jsonb_typeof(output->'sealedPayload') = 'object'
    AND (output->'sealedPayload') ?& ARRAY[
      'version', 'algorithm', 'purpose', 'keyId', 'iv', 'ciphertext', 'authTag'
    ]
    AND (SELECT COUNT(*) FROM jsonb_object_keys(output->'sealedPayload')) = 7
    AND output->'sealedPayload'->>'version' = '1'
    AND output->'sealedPayload'->>'algorithm' = 'A256GCM'
    AND output->'sealedPayload'->>'purpose' = 'backstage-booker-job-output'
    AND output->'sealedPayload'->>'keyId' ~ '^[A-Za-z0-9_-]{43}$'
    AND LENGTH(output->'sealedPayload'->>'iv') = 16
    AND LENGTH(output->'sealedPayload'->>'ciphertext') > 0
    AND LENGTH(output->'sealedPayload'->>'authTag') = 24
  FROM target), false) AS protected_output_valid,
  COALESCE((SELECT
    POSITION($4::text IN input::text) = 0
    AND POSITION($5::text IN input::text) = 0
    AND POSITION($6::text IN input::text) = 0
    AND POSITION($4::text IN output::text) = 0
    AND POSITION($5::text IN output::text) = 0
    AND POSITION($6::text IN output::text) = 0
  FROM target), false) AS plaintext_absent,
  events.*
FROM events`;

function fail(code) {
  throw new Error(code);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArguments(args) {
  const values = new Map();
  let execute = false;
  let allowDatabaseRead = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--execute') {
      execute = true;
      continue;
    }
    if (argument === '--allow-database-read') {
      allowDatabaseRead = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= args.length) {
      fail('BACKSTAGE_HEAVY_AT_REST_ARGUMENT_INVALID');
    }
    const name = argument.slice(2);
    if (values.has(name)) {
      fail('BACKSTAGE_HEAVY_AT_REST_ARGUMENT_DUPLICATE');
    }
    values.set(name, args[index + 1]);
    index += 1;
  }
  return { allowDatabaseRead, execute, values };
}

function readRequired(values, name) {
  const value = values.get(name)?.trim();
  if (!value) {
    fail('BACKSTAGE_HEAVY_AT_REST_ARGUMENT_REQUIRED');
  }
  return value;
}

function validateUuid(value) {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized) || CANONICAL_IDS.has(normalized)) {
    fail('BACKSTAGE_HEAVY_AT_REST_TARGET_ID_INVALID');
  }
  return normalized;
}

export function resolveBackstageHeavyAtRestConfig(args) {
  const parsed = parseArguments(args);
  const supportedNames = new Set([
    'target',
    'project-id',
    'environment-id',
    'environment-name',
    'worker-service-id',
    'worker-deployment-id',
    'postgres-service-id',
    'postgres-service-name',
    'postgres-internal-host',
    'redis-service-id',
    'redis-service-name',
    'redis-internal-host',
    'source-sha',
    'run-id',
    'job-id',
    'request-id',
    'trace-id',
  ]);
  if ([...parsed.values.keys()].some(name => !supportedNames.has(name))) {
    fail('BACKSTAGE_HEAVY_AT_REST_ARGUMENT_UNKNOWN');
  }
  if (parsed.execute !== parsed.allowDatabaseRead) {
    fail('BACKSTAGE_HEAVY_AT_REST_DATABASE_GATES_REQUIRED');
  }
  if (readRequired(parsed.values, 'target') !== BACKSTAGE_HEAVY_AT_REST_TARGET) {
    fail('BACKSTAGE_HEAVY_AT_REST_TARGET_INVALID');
  }

  const environmentName = readRequired(parsed.values, 'environment-name')
    .toLowerCase();
  const sourceSha = readRequired(parsed.values, 'source-sha').toLowerCase();
  const runId = readRequired(parsed.values, 'run-id').toLowerCase();
  const requestId = readRequired(parsed.values, 'request-id');
  const traceId = readRequired(parsed.values, 'trace-id');
  const jobId = readRequired(parsed.values, 'job-id').toLowerCase();
  if (
    !ENVIRONMENT_PATTERN.test(environmentName)
    || !SHA_PATTERN.test(sourceSha)
    || !RUN_ID_PATTERN.test(runId)
    || !CORRELATION_ID_PATTERN.test(requestId)
    || !CORRELATION_ID_PATTERN.test(traceId)
    || !UUID_PATTERN.test(jobId)
  ) {
    fail('BACKSTAGE_HEAVY_AT_REST_IDENTITY_INVALID');
  }
  const postgresServiceName = readRequired(
    parsed.values,
    'postgres-service-name'
  );
  const redisServiceName = readRequired(parsed.values, 'redis-service-name');
  const postgresInternalHost = readRequired(
    parsed.values,
    'postgres-internal-host'
  ).toLowerCase();
  const redisInternalHost = readRequired(
    parsed.values,
    'redis-internal-host'
  ).toLowerCase();
  if (
    postgresServiceName !== 'Postgres'
    || redisServiceName !== 'Redis'
    || postgresInternalHost !== 'postgres.railway.internal'
    || redisInternalHost !== 'redis.railway.internal'
  ) {
    fail('BACKSTAGE_HEAVY_AT_REST_DATA_IDENTITY_INVALID');
  }
  const config = {
    allowDatabaseRead: parsed.allowDatabaseRead,
    environmentId: validateUuid(readRequired(parsed.values, 'environment-id')),
    environmentName,
    execute: parsed.execute,
    jobId,
    postgresInternalHost,
    postgresServiceId: validateUuid(
      readRequired(parsed.values, 'postgres-service-id')
    ),
    postgresServiceName,
    projectId: validateUuid(readRequired(parsed.values, 'project-id')),
    redisInternalHost,
    redisServiceId: validateUuid(
      readRequired(parsed.values, 'redis-service-id')
    ),
    redisServiceName,
    requestId,
    runId,
    sourceSha,
    target: BACKSTAGE_HEAVY_AT_REST_TARGET,
    traceId,
    workerDeploymentId: validateUuid(
      readRequired(parsed.values, 'worker-deployment-id')
    ),
    workerServiceId: validateUuid(
      readRequired(parsed.values, 'worker-service-id')
    ),
  };
  if (new Set([
    config.workerServiceId,
    config.postgresServiceId,
    config.redisServiceId,
  ]).size !== 3) {
    fail('BACKSTAGE_HEAVY_AT_REST_TARGET_ID_INVALID');
  }
  return config;
}

function attestRuntimeIdentity(config, env) {
  const proofTarget = resolveBackstageHeavyProofTargetOrThrow('worker', env);
  if (
    !proofTarget.enabled
    || proofTarget.projectId !== config.projectId
    || proofTarget.environmentId !== config.environmentId
    || proofTarget.environmentName !== config.environmentName
    || proofTarget.serviceId !== config.workerServiceId
    || proofTarget.deploymentId !== config.workerDeploymentId
    || proofTarget.sourceCommit !== config.sourceSha
    || proofTarget.runId !== config.runId
    || proofTarget.postgresServiceId !== config.postgresServiceId
    || proofTarget.postgresInternalHost !== config.postgresInternalHost
    || proofTarget.redisServiceId !== config.redisServiceId
    || proofTarget.redisInternalHost !== config.redisInternalHost
  ) {
    fail('BACKSTAGE_HEAVY_AT_REST_RUNTIME_IDENTITY_MISMATCH');
  }
  return proofTarget;
}

function isDatabaseEvidenceComplete(row) {
  if (!isRecord(row)) {
    return false;
  }
  const exactCounts = [
    'created_count',
    'queued_count',
    'claimed_count',
    'started_count',
    'completed_count',
  ].every(name => Number(row[name]) === 1);
  return (
    Number(row.total_job_rows) === 1
    && row.target_exists === true
    && row.terminal_valid === true
    && row.derived_idempotency_valid === true
    && row.protected_input_valid === true
    && row.protected_output_valid === true
    && row.plaintext_absent === true
    && exactCounts
    && Number(row.ai_started_count) === 2
    && Number(row.ai_completed_count) === 2
    && Number(row.heartbeat_count) >= 2
    && Number(row.failure_count) === 0
    && Number(row.unexpected_count) === 0
    && Number(row.trace_mismatch_count) === 0
    && Number(row.worker_mismatch_count) === 0
    && Number(row.ai_model_mismatch_count) === 0
    && Number(row.ai_context_mismatch_count) === 0
    && Number(row.total_event_rows) === Number(row.total_count)
    && Number(row.total_count) === (
      9 + Number(row.heartbeat_count)
    )
    && Number(row.heartbeat_span_ms) >= 4_500
    && Number(row.maximum_ai_duration_ms) >= 11_500
    && row.lifecycle_time_ordered === true
  );
}

async function readDatabaseEvidence(
  proofTarget,
  config,
  options = {}
) {
  let Client = options.Client;
  if (!Client) {
    const pgModule = await import('pg');
    Client = pgModule.Client ?? pgModule.default?.Client;
  }
  if (typeof Client !== 'function') {
    fail('BACKSTAGE_HEAVY_AT_REST_DATABASE_CLIENT_UNAVAILABLE');
  }
  const client = new Client({
    application_name: 'arcanos_backstage_heavy_attestor_v1',
    connectionString: proofTarget.databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
  });
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep
    ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let transactionStarted = false;
  try {
    await client.connect();
    const startedAt = now();
    let row = null;
    do {
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      );
      transactionStarted = true;
      await client.query('SET LOCAL search_path = pg_catalog, public');
      const readOnly = await client.query('SHOW transaction_read_only');
      if (readOnly.rows?.[0]?.transaction_read_only !== 'on') {
        fail('BACKSTAGE_HEAVY_AT_REST_DATABASE_NOT_READ_ONLY');
      }
      const result = await client.query(AT_REST_QUERY, [
        config.jobId,
        config.requestId,
        config.traceId,
        BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
        BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
        BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
        EXPECTED_WORKER_ID,
        `fixture-${config.runId}`,
      ]);
      row = result.rows?.[0] ?? null;
      await client.query('ROLLBACK');
      transactionStarted = false;
      if (isDatabaseEvidenceComplete(row)) {
        return row;
      }
      if (now() - startedAt >= DATABASE_POLL_TIMEOUT_MS) {
        break;
      }
      await sleep(DATABASE_POLL_INTERVAL_MS);
    } while (true);
    fail('BACKSTAGE_HEAVY_AT_REST_DATABASE_EVIDENCE_INCOMPLETE');
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('BACKSTAGE_HEAVY_AT_REST_')
    ) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_AT_REST_DATABASE_READ_FAILED');
  } finally {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

async function readBoundedJsonResponse(response) {
  if (!response.body) {
    fail('BACKSTAGE_HEAVY_AT_REST_FIXTURE_RESPONSE_INVALID');
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_LOOPBACK_RESPONSE_BYTES) {
      await response.body.cancel?.().catch?.(() => undefined);
      fail('BACKSTAGE_HEAVY_AT_REST_FIXTURE_RESPONSE_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
    if (!isRecord(parsed)) {
      fail('BACKSTAGE_HEAVY_AT_REST_FIXTURE_RESPONSE_INVALID');
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('BACKSTAGE_HEAVY_AT_REST_')
    ) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_AT_REST_FIXTURE_RESPONSE_INVALID');
  }
}

async function readFixtureEvidence(fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOPBACK_TIMEOUT_MS);
  try {
    const fixtureOrigin = new URL(BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL)
      .origin;
    const response = await fetchImpl(
      `${fixtureOrigin}${BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
        },
        redirect: 'error',
        signal: controller.signal,
      }
    );
    const body = await readBoundedJsonResponse(response);
    if (
      response.status !== 200
      || body.schemaVersion !== 1
      || body.fixture !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER
      || body.ready !== true
      || body.responsePhase !== 'second_complete'
      || body.modelsListCalls !== 1
      || body.responsesCalls !== 2
      || body.firstResponseIncomplete !== true
      || body.secondResponseCompleted !== true
      || body.firstRecoveryMarkerAbsent !== true
      || body.secondRecoveryMarkerObserved !== true
      || body.secondRequestExcludedPartialOutput !== true
      || body.promptSentinelObserved !== true
      || body.bookingDirectiveObserved !== true
      || body.runMarkerObserved !== true
      || body.thirdResponseRejected !== 0
      || body.unknownRequests !== 0
      || body.authorizationFailures !== 0
      || body.invalidRequests !== 0
    ) {
      fail('BACKSTAGE_HEAVY_AT_REST_FIXTURE_EVIDENCE_INCOMPLETE');
    }
    return body;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('BACKSTAGE_HEAVY_AT_REST_')
    ) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_AT_REST_FIXTURE_READ_FAILED');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function runBackstageHeavyAtRestAttestor(
  config,
  options = {}
) {
  if (!config.execute || !config.allowDatabaseRead) {
    return {
      mode: 'dry-run',
      databaseReads: 0,
      loopbackRequests: 0,
      target: config.target,
      sourceSha: config.sourceSha,
      jobIdSha256: digest(config.jobId),
    };
  }
  const proofTarget = attestRuntimeIdentity(
    config,
    options.env ?? process.env
  );
  const databaseEvidence = await readDatabaseEvidence(
    proofTarget,
    config,
    options
  );
  const fixtureEvidence = await readFixtureEvidence(
    options.fetchImpl ?? fetch
  );
  return {
    mode: 'attested',
    target: config.target,
    projectId: config.projectId,
    environmentId: config.environmentId,
    workerServiceId: config.workerServiceId,
    workerDeploymentId: config.workerDeploymentId,
    postgresServiceId: config.postgresServiceId,
    redisServiceId: config.redisServiceId,
    sourceSha: config.sourceSha,
    jobIdSha256: digest(config.jobId),
    requestIdSha256: digest(config.requestId),
    traceIdSha256: digest(config.traceId),
    singleJobRow: true,
    derivedIdempotencyAttested: true,
    protectedAtRest: true,
    terminalLeaseCleared: true,
    heartbeatRenewals: Number(databaseEvidence.heartbeat_count),
    heartbeatSpanMs: Number(databaseEvidence.heartbeat_span_ms),
    eventTraceCorrelated: true,
    fixtureResponsesCalls: fixtureEvidence.responsesCalls,
    compactRetryAttested: true,
  };
}

async function main() {
  const config = resolveBackstageHeavyAtRestConfig(process.argv.slice(2));
  const result = await runBackstageHeavyAtRestAttestor(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof Error
      ? error.message
      : 'BACKSTAGE_HEAVY_AT_REST_FAILED';
    process.stderr.write(`${code.startsWith('BACKSTAGE_HEAVY_AT_REST_')
      ? code
      : 'BACKSTAGE_HEAVY_AT_REST_FAILED'}\n`);
    process.exitCode = 1;
  });
}
