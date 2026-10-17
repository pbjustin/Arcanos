/** Closed, repeatable synthetic queue slots bound to the preview owner receipt. */
import { createHash } from 'node:crypto';
import {
  bindSelfHealPreviewArtifact, buildSelfHealPreviewDatabaseClientOptions,
  resolveSelfHealPreviewProfile, resolveSelfHealPreviewWorkerIds,
} from './railway-self-heal-preview-profile.mjs';
import { verifySelfHealPreviewArtifact } from './self-heal-preview-artifact.mjs';

export const SELF_HEAL_PREVIEW_FENCED_LITERAL = 'SEALED_PREVIEW_FENCED_OK';
export const SELF_HEAL_PREVIEW_JOB_SCENARIOS = Object.freeze([
  'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'B01', 'B02', 'B03', 'B04', 'B05',
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06',
]);
export const SELF_HEAL_INFERENCE_PREVIEW_JOB_SCENARIOS = Object.freeze(['I01', 'I02', 'I03']);
function fail() { throw new Error('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED'); }
const SELECT_JOB_FIELDS = `SELECT j.id, j.status, j.claim_generation::text AS claim_generation,
  j.last_worker_id, j.retry_count, (j.lease_expires_at > clock_timestamp()) IS TRUE AS lease_active, j.output,
  j.lease_expires_at::text AS lease_expires_at,
  (SELECT COUNT(*)::integer FROM public.job_events e WHERE e.job_id = j.id AND e.event_type = 'job.claimed') AS claim_events,
  (SELECT COUNT(*)::integer FROM public.job_events e WHERE e.job_id = j.id AND e.event_type = 'job.claimed'
    AND e.worker_id = j.last_worker_id AND e.metadata->>'claimGeneration' = j.claim_generation::text) AS matching_claim_events,
  (SELECT COUNT(*)::integer FROM public.job_events e WHERE e.job_id = j.id AND e.event_type = 'job.completed') AS completion_events,
  (SELECT COUNT(*)::integer FROM public.job_events e WHERE e.job_id = j.id AND e.event_type = 'job.completed'
    AND e.worker_id = j.last_worker_id AND e.metadata->>'claimGeneration' = j.claim_generation::text) AS matching_completion_events
  FROM public.job_data j`;
const SELECT_JOB = `${SELECT_JOB_FIELDS} WHERE j.worker_id = $1 AND j.correlation_id = $2`;

function projectJob(job, profile) {
  if (!job) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(job.id) || !/^\d{1,19}$/u.test(job.claim_generation)
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)
    || !Number.isInteger(job.retry_count) || job.retry_count < 0
    || typeof job.lease_active !== 'boolean'
    || (job.lease_expires_at !== null && (typeof job.lease_expires_at !== 'string'
      || !Number.isFinite(Date.parse(job.lease_expires_at))))
    || !Number.isInteger(job.completion_events) || job.completion_events < 0 || job.completion_events > 1
    || !Number.isInteger(job.claim_events) || job.claim_events < 0
    || !Number.isInteger(job.matching_claim_events) || job.matching_claim_events < 0 || job.matching_claim_events > job.claim_events
    || !Number.isInteger(job.matching_completion_events) || job.matching_completion_events < 0
    || job.matching_completion_events > job.completion_events
    || (job.completion_events === 1 && (job.matching_completion_events !== 1 || job.status !== 'completed'))
    || (job.last_worker_id !== null && !resolveSelfHealPreviewWorkerIds(profile).includes(job.last_worker_id))) fail();
  const output = job.output === null || job.output === undefined ? null : JSON.stringify(job.output);
  return {
    id: job.id, status: job.status, claimGeneration: job.claim_generation, lastWorkerId: job.last_worker_id,
    retryCount: job.retry_count, leaseActive: job.lease_active, leaseExpiresAt: job.lease_expires_at,
    claimEvents: job.claim_events, matchingClaimEvents: job.matching_claim_events,
    completionEvents: job.completion_events, atMostOneCompletion: true,
    matchingCompletionEvents: job.matching_completion_events,
    completionVerified: job.status === 'completed' && job.completion_events === 1
      && job.matching_claim_events === 1 && job.claim_generation !== '0' && job.lease_active !== true,
    outputSha256: output === null ? null : createHash('sha256').update(output).digest('hex'),
    literalObserved: job.output?.result === SELF_HEAL_PREVIEW_FENCED_LITERAL,
  };
}

export async function runSelfHealPreviewFencedJob(command, env, options = {}) {
  if (!['create', 'inspect'].includes(command) || env.ARCANOS_PROCESS_KIND !== 'worker') fail();
  if (![...SELF_HEAL_PREVIEW_JOB_SCENARIOS, ...SELF_HEAL_INFERENCE_PREVIEW_JOB_SCENARIOS].includes(options.scenario)
    || ![1, 2].includes(options.attempt)) fail();
  const unbound = resolveSelfHealPreviewProfile('worker', env, { now: options.now });
  const containment = SELF_HEAL_INFERENCE_PREVIEW_JOB_SCENARIOS.includes(options.scenario);
  if (containment && unbound.ownership.profile !== 'worker-inference-containment-v1') fail();
  const runningOnly = ['I01', 'I02'].includes(options.scenario);
  const artifact = await (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: unbound.proofTarget.sourceCommit });
  const profile = bindSelfHealPreviewArtifact(unbound, artifact);
  const assertLease = () => { if (profile.expiresAtMs <= (options.now?.() ?? Date.now())) fail(); };
  assertLease();
  let Client = options.Client;
  if (!Client) { const pg = await import('pg'); Client = pg.Client ?? pg.default?.Client; }
  const client = new Client({ ...buildSelfHealPreviewDatabaseClientOptions(profile),
    connectionTimeoutMillis: 3_000, query_timeout: 3_000,
    application_name: 'arcanos_self_heal_preview_fenced_job_v1',
    options: '-c statement_timeout=3000 -c lock_timeout=1000' });
  let transaction = false;
  try {
    await client.connect();
    await client.query(command === 'create' ? 'BEGIN' : 'BEGIN READ ONLY'); transaction = true;
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const owner = await client.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1 WHERE singleton = TRUE');
    if (owner.rows?.length !== 1 || owner.rows[0].identity !== JSON.stringify(profile.ownership)) fail();
    const workerId = `self-heal-preview-${profile.proofTarget.runId}`;
    const correlation = `self-heal-preview:${profile.proofTarget.runId}:fenced:${options.scenario}:${options.attempt}`;
    if (command === 'create') await client.query('SELECT pg_advisory_xact_lock(1544, 4)');
    let jobs = await client.query(SELECT_JOB, [workerId, correlation]);
    if (!Array.isArray(jobs.rows) || jobs.rows.length > 1) fail();
    if (command === 'create' && jobs.rows.length === 0) {
      assertLease();
      const input = { prompt: runningOnly
          ? 'Write a short fictional description of a blue paper kite above a quiet meadow.'
          : `Reply with exactly ${SELF_HEAL_PREVIEW_FENCED_LITERAL}`,
        answerMode: 'direct', requestedVerbosity: 'minimal', maxWords: 8,
        endpointName: runningOnly ? 'self-heal.preview.running-only' : 'self-heal.preview.fenced' };
      await client.query(`INSERT INTO public.job_data
        (worker_id, job_type, status, input, max_retries, correlation_id, expires_at, retention_until)
        SELECT $1, 'ask', 'pending', $2::jsonb, 0, $3, NOW() + INTERVAL '120 seconds', NOW() + INTERVAL '1 day'
        WHERE clock_timestamp() < $4::timestamptz`,
      [workerId, JSON.stringify(input), correlation, profile.expiresAt]);
      jobs = await client.query(SELECT_JOB, [workerId, correlation]);
      if (jobs.rows?.length !== 1) fail();
    }
    const job = projectJob(jobs.rows[0], profile);
    assertLease();
    await client.query('COMMIT'); transaction = false;
    return { sourceSha: profile.proofTarget.sourceCommit, runId: profile.proofTarget.runId,
      serviceId: profile.proofTarget.serviceId, scenario: options.scenario, attempt: options.attempt,
      correlationId: correlation, allowedWorkerIds: resolveSelfHealPreviewWorkerIds(profile), job,
      consumerPath: runningOnly ? 'ordinary-worker-ask-loopback-provider' : 'ordinary-worker-ask-exact-literal-dispatch',
      providerRecoveryProven: false };
  } catch { fail(); }
  finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/** Read only the ordinary web request's exact server-owned correlation and job. */
export async function inspectSelfHealPreviewWebJob(jobId, env, options = {}) {
  if (env.ARCANOS_PROCESS_KIND !== 'web' || ![1, 2].includes(options.attempt)
    || (jobId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(jobId))) fail();
  const unbound = resolveSelfHealPreviewProfile('web', env, { now: options.now });
  const artifact = await (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: unbound.proofTarget.sourceCommit });
  const profile = bindSelfHealPreviewArtifact(unbound, artifact);
  const assertLease = () => { if (profile.expiresAtMs <= (options.now?.() ?? Date.now())) fail(); };
  assertLease();
  let Client = options.Client;
  if (!Client) { const pg = await import('pg'); Client = pg.Client ?? pg.default?.Client; }
  const client = new Client({ ...buildSelfHealPreviewDatabaseClientOptions(profile),
    connectionTimeoutMillis: 3_000, query_timeout: 3_000,
    application_name: 'arcanos_self_heal_preview_web_job_v1',
    options: '-c statement_timeout=3000 -c lock_timeout=1000' });
  let transaction = false;
  try {
    await client.connect(); await client.query('BEGIN READ ONLY'); transaction = true;
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const owner = await client.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1 WHERE singleton = TRUE');
    if (owner.rows?.length !== 1 || owner.rows[0].identity !== JSON.stringify(profile.ownership)) fail();
    const correlation = `self-heal-preview:${profile.proofTarget.runId}:web:${options.attempt}`;
    const rows = jobId === null ? { rows: [] } : await client.query(`${SELECT_JOB_FIELDS} WHERE j.id = $1::uuid
      AND j.worker_id = 'api' AND j.job_type = 'gpt' AND j.correlation_id = $2`, [jobId, correlation]);
    if (!Array.isArray(rows.rows) || rows.rows.length > 1) fail();
    const job = projectJob(rows.rows[0], profile);
    assertLease(); await client.query('COMMIT'); transaction = false;
    return { sourceSha: profile.proofTarget.sourceCommit, runId: profile.proofTarget.runId,
      correlationId: correlation, allowedWorkerIds: resolveSelfHealPreviewWorkerIds(profile), job };
  } catch { fail(); }
  finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
