/** One fixed synthetic queue fixture, bound to the existing preview's owner receipt. */
import { createHash } from 'node:crypto';
import {
  bindSelfHealPreviewArtifact, resolveSelfHealPreviewProfile,
} from './railway-self-heal-preview-profile.mjs';
import { verifySelfHealPreviewArtifact } from './self-heal-preview-artifact.mjs';

export const SELF_HEAL_PREVIEW_FENCED_LITERAL = 'SEALED_PREVIEW_FENCED_OK';
function fail() { throw new Error('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED'); }
const SELECT_JOB = `SELECT j.id, j.status, j.claim_generation::text AS claim_generation,
  j.last_worker_id, j.retry_count, (j.lease_expires_at > clock_timestamp()) IS TRUE AS lease_active, j.output,
  (SELECT COUNT(*)::integer FROM public.job_events e WHERE e.job_id = j.id AND e.event_type = 'job.completed') AS completion_events
  FROM public.job_data j WHERE j.worker_id = $1 AND j.correlation_id = $2`;

export async function runSelfHealPreviewFencedJob(command, env, options = {}) {
  if (!['create', 'inspect'].includes(command) || env.ARCANOS_PROCESS_KIND !== 'worker') fail();
  const unbound = resolveSelfHealPreviewProfile('worker', env, { now: options.now });
  const artifact = await (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: unbound.proofTarget.sourceCommit });
  const profile = bindSelfHealPreviewArtifact(unbound, artifact);
  const assertLease = () => { if (profile.expiresAtMs <= (options.now?.() ?? Date.now())) fail(); };
  assertLease();
  let Client = options.Client;
  if (!Client) { const pg = await import('pg'); Client = pg.Client ?? pg.default?.Client; }
  const client = new Client({ connectionString: profile.proofTarget.databaseUrl,
    // The disposable private service has a self-signed certificate; this is
    // encrypted preview transport, not server-certificate authentication proof.
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 3_000, query_timeout: 3_000,
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
    const correlation = `self-heal-preview:${profile.proofTarget.runId}:fenced-continuity`;
    if (command === 'create') await client.query('SELECT pg_advisory_xact_lock(1544, 4)');
    let jobs = await client.query(SELECT_JOB, [workerId, correlation]);
    if (!Array.isArray(jobs.rows) || jobs.rows.length > 1) fail();
    if (command === 'create' && jobs.rows.length === 0) {
      assertLease();
      const input = { prompt: `Reply with exactly ${SELF_HEAL_PREVIEW_FENCED_LITERAL}`,
        answerMode: 'direct', requestedVerbosity: 'minimal', maxWords: 8,
        endpointName: 'self-heal.preview.fenced' };
      await client.query(`INSERT INTO public.job_data
        (worker_id, job_type, status, input, max_retries, correlation_id, expires_at, retention_until)
        SELECT $1, 'ask', 'pending', $2::jsonb, 0, $3, NOW() + INTERVAL '120 seconds', NOW() + INTERVAL '1 day'
        WHERE clock_timestamp() < $4::timestamptz`,
      [workerId, JSON.stringify(input), correlation, profile.expiresAt]);
      jobs = await client.query(SELECT_JOB, [workerId, correlation]);
      if (jobs.rows?.length !== 1) fail();
    }
    const job = jobs.rows[0];
    if (job && (!/^[0-9a-f-]{36}$/u.test(job.id) || !/^\d+$/u.test(job.claim_generation)
      || !Number.isInteger(job.completion_events) || job.completion_events < 0
      || (job.last_worker_id !== null && job.last_worker_id !== workerId))) fail();
    await client.query('COMMIT'); transaction = false;
    const output = job?.output === null || job?.output === undefined ? null : JSON.stringify(job.output);
    return { sourceSha: profile.proofTarget.sourceCommit, runId: profile.proofTarget.runId,
      serviceId: profile.proofTarget.serviceId, job: !job ? null : {
        id: job.id, status: job.status, claimGeneration: job.claim_generation, lastWorkerId: job.last_worker_id,
        retryCount: job.retry_count, leaseActive: job.lease_active === true,
        completionEvents: job.completion_events,
        outputSha256: output === null ? null : createHash('sha256').update(output).digest('hex'),
        literalObserved: output?.includes(SELF_HEAL_PREVIEW_FENCED_LITERAL) ?? false,
      }, consumerPath: 'ordinary-worker-ask-exact-literal-dispatch',
      providerRecoveryProven: false };
  } catch { fail(); }
  finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}
