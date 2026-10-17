import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runSelfHealPreviewFencedJob, SELF_HEAL_PREVIEW_JOB_SCENARIOS } from '../scripts/self-heal-preview-job.mjs';
import { bindSelfHealPreviewArtifact, resolveSelfHealPreviewProfile } from '../scripts/railway-self-heal-preview-profile.mjs';

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const NOW = Date.parse('2026-10-14T16:00:00.000Z');
const artifact = { sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64), fileCount: 10 };
const certificate = readFileSync(new URL('./fixtures/self-heal-preview-database-ca.pem', import.meta.url), 'utf8');
function environment(role = 'worker') {
  return {
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1', ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'synthetic-job-run',
    ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM: certificate,
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(NOW - 1_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(NOW + 600_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: 'f'.repeat(64), ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8791',
    ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal', ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID: id('3'),
    ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: id('4'),
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET: 'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'synthetic-job-run', ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: artifact.sourceSha,
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: id('6'), ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST: 'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: id('7'), ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST: 'redis.railway.internal',
    ARCANOS_PROCESS_KIND: role, ARCANOS_PREVIEW_ISOLATION: 'true', NODE_ENV: 'production', PORT: '8080',
    FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
    OPENAI_BASE_URL: role === 'worker' ? 'http://127.0.0.1:8766/v1' : 'http://127.0.0.1:9/v1',
    ...(role === 'worker' ? { ARCANOS_PREVIEW_OPENAI_FIXTURE: 'backstage-heavy-compact-retry-v1' } : {
      ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: 'fictional-preview-web-bearer-00000001',
      ARCANOS_JOB_READ_CAPABILITY_SECRET: 'fictional-preview-web-job-secret-00000001',
      ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
    }),
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    DATABASE_URL: 'postgresql://synthetic:synthetic-password@postgres.railway.internal:5432/railway',
    REDIS_URL: 'redis://default:synthetic-redis-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: id('1'), RAILWAY_PROJECT_NAME: 'arc-pr1544-heavy-job',
    RAILWAY_ENVIRONMENT_ID: id('2'), RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1544-e2e',
    RAILWAY_SERVICE_ID: id(role === 'worker' ? '4' : '3'), RAILWAY_SERVICE_NAME: `arcanos-${role}-pr1544-heavy`,
    RAILWAY_DEPLOYMENT_ID: id('5'), RAILWAY_GIT_COMMIT_SHA: artifact.sourceSha,
  };
}
function pendingJob(number = 8) {
  return { id: id(String(number)), status: 'pending', claim_generation: '0', last_worker_id: null,
    retry_count: 0, lease_active: false, lease_expires_at: null, output: null,
    claim_events: 0, matching_claim_events: 0, completion_events: 0, matching_completion_events: 0 };
}
function completedJob(slot = 1) {
  return { ...pendingJob(), status: 'completed', claim_generation: '1',
    last_worker_id: `self-heal-preview-synthetic-job-run-slot-${slot}`,
    output: { result: 'SEALED_PREVIEW_FENCED_OK' }, claim_events: 1, matching_claim_events: 1, completion_events: 1, matching_completion_events: 1 };
}
function databaseFixture(env) {
  const identity = JSON.stringify(bindSelfHealPreviewArtifact(resolveSelfHealPreviewProfile(env.ARCANOS_PROCESS_KIND, env, { now: () => NOW }), artifact).ownership);
  const state = { identity, rows: new Map(), queries: [], connections: [], ended: 0 };
  class Client {
    constructor(config) { state.connections.push(config); }
    async connect() {}
    async end() { state.ended += 1; }
    async query(sql, args = []) {
      state.queries.push({ sql, args });
      if (sql.startsWith('SELECT identity')) return { rows: [{ identity: state.identity }] };
      if (sql.startsWith('SELECT j.id')) return { rows: state.rows.has(args[1]) ? [state.rows.get(args[1])] : [] };
      if (sql.startsWith('INSERT INTO public.job_data')) state.rows.set(args[2], pendingJob(state.rows.size + 1));
      return { rows: [] };
    }
  }
  return { state, options: { Client, now: () => NOW, verifyArtifact: () => artifact, scenario: 'E02', attempt: 1 } };
}

describe('closed self-heal fenced-job scenarios', () => {
  it.each(['I01', 'I02'])('admits the fixed real running-job scenario %s only in the eight-slot containment profile', async scenario => {
    const legacy = environment(); const prior = databaseFixture(legacy);
    await expect(runSelfHealPreviewFencedJob('create', legacy, { ...prior.options, scenario })).rejects.toThrow('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED');
    expect(prior.state.connections).toHaveLength(0);
    const env = { ...environment(), ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-inference-containment-v1',
      RAILWAY_PROJECT_NAME: 'arc-pr1557-heavy-job', RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1557-e2e',
      RAILWAY_SERVICE_NAME: 'arcanos-worker-pr1557-heavy' };
    const { state, options } = databaseFixture(env);
    const created = await runSelfHealPreviewFencedJob('create', env, { ...options, scenario });
    expect(created.allowedWorkerIds).toHaveLength(8);
    expect(created.consumerPath).toBe('ordinary-worker-ask-loopback-provider');
    expect(created.job.status).toBe('pending');
    const insert = state.queries.find(item => item.sql.startsWith('INSERT'));
    expect(JSON.parse(insert.args[1])).toEqual({ prompt: 'Write a short fictional description of a blue paper kite above a quiet meadow.',
      answerMode: 'direct', requestedVerbosity: 'minimal', maxWords: 8, endpointName: 'self-heal.preview.running-only' });
    expect(insert.sql).toContain("'pending'"); expect(insert.sql).toContain("INTERVAL '120 seconds'");
    expect(state.queries.some(item => /UPDATE|DELETE/u.test(item.sql))).toBe(false);
  });
  it('admits the fixed pending-work I03 case only in the containment profile and retains the literal dispatch path', async () => {
    const legacy = environment(); const prior = databaseFixture(legacy);
    await expect(runSelfHealPreviewFencedJob('create', legacy, { ...prior.options, scenario: 'I03' })).rejects.toThrow('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED');
    expect(prior.state.connections).toHaveLength(0);
    const env = { ...environment(), ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-inference-containment-v1',
      RAILWAY_PROJECT_NAME: 'arc-pr1557-heavy-job', RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1557-e2e',
      RAILWAY_SERVICE_NAME: 'arcanos-worker-pr1557-heavy' };
    const { state, options } = databaseFixture(env);
    const slot = { ...options, scenario: 'I03' };
    const created = await runSelfHealPreviewFencedJob('create', env, slot);
    expect(created.allowedWorkerIds).toHaveLength(8);
    expect(created.consumerPath).toBe('ordinary-worker-ask-exact-literal-dispatch');
    expect(created.job.status).toBe('pending');
    expect((await runSelfHealPreviewFencedJob('create', env, slot)).job.id).toBe(created.job.id);
    const inserts = state.queries.filter(item => item.sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(1);
    expect(JSON.parse(inserts[0].args[1])).toEqual({ prompt: 'Reply with exactly SEALED_PREVIEW_FENCED_OK',
      answerMode: 'direct', requestedVerbosity: 'minimal', maxWords: 8, endpointName: 'self-heal.preview.fenced' });
    expect(inserts[0].sql).toContain("'pending'"); expect(inserts[0].sql).toContain("INTERVAL '120 seconds'");
    expect(state.queries.some(item => /UPDATE|DELETE/u.test(item.sql))).toBe(false);
    state.rows.set('self-heal-preview:synthetic-job-run:fenced:I03:1', completedJob(8));
    expect((await runSelfHealPreviewFencedJob('inspect', env, slot)).job).toMatchObject({
      completionVerified: true, literalObserved: true, matchingCompletionEvents: 1,
      lastWorkerId: 'self-heal-preview-synthetic-job-run-slot-8',
    });
  });
  it('keeps every scenario/attempt independent and each slot idempotent, with no arbitrary SQL or prompt', async () => {
    const env = environment(); const { state, options } = databaseFixture(env);
    const ids = new Set();
    for (const scenario of ['B02', 'E02', 'E03']) for (const attempt of [1, 2]) {
      const slot = { ...options, scenario, attempt };
      const first = await runSelfHealPreviewFencedJob('create', env, slot);
      expect((await runSelfHealPreviewFencedJob('create', env, slot)).job.id).toBe(first.job.id);
      ids.add(first.job.id);
    }
    expect(ids.size).toBe(6); expect(SELF_HEAL_PREVIEW_JOB_SCENARIOS).toHaveLength(32);
    const inserts = state.queries.filter(item => item.sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(6);
    for (const item of inserts) expect(JSON.parse(item.args[1])).toEqual({ prompt: 'Reply with exactly SEALED_PREVIEW_FENCED_OK',
      answerMode: 'direct', requestedVerbosity: 'minimal', maxWords: 8, endpointName: 'self-heal.preview.fenced' });
    expect(state.connections.every(config => config.ssl.rejectUnauthorized === true)).toBe(true);
  });
  it.each([{ scenario: undefined }, { scenario: 'E07' }, { scenario: 'E02;SELECT' }, { attempt: 0 },
    { attempt: 3 }, { attempt: '1' }, { attempt: 1.5 }, { attempt: undefined }])('rejects an open or malformed slot before construction: %j', async patch => {
    const env = environment(); const { state, options } = databaseFixture(env);
    await expect(runSelfHealPreviewFencedJob('create', env, { ...options, ...patch })).rejects.toThrow('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED');
    expect(state.connections).toHaveLength(0);
  });
  it.each([1, 2])('independently projects generation/lease/completion for exact Worker slot %i without raw output', async slot => {
    const env = environment(); const { state, options } = databaseFixture(env);
    state.rows.set('self-heal-preview:synthetic-job-run:fenced:E02:1', { ...completedJob(slot), output: { result: 'SEALED_PREVIEW_FENCED_OK', sensitive: 'must-not-escape' } });
    const result = await runSelfHealPreviewFencedJob('inspect', env, options);
    expect(result.job).toMatchObject({ completionVerified: true, atMostOneCompletion: true, completionEvents: 1,
      lastWorkerId: `self-heal-preview-synthetic-job-run-slot-${slot}`, claimGeneration: '1', leaseActive: false, literalObserved: true });
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
    expect(state.queries.some(item => item.sql.startsWith('INSERT'))).toBe(false);
  });
  it.each([
    { last_worker_id: 'self-heal-preview-synthetic-job-run' },
    { last_worker_id: 'self-heal-preview-synthetic-job-run-slot-3' },
    { last_worker_id: 'self-heal-preview-synthetic-job-run-foreign-slot-1' },
    { completion_events: 2, matching_completion_events: 2 }, { matching_completion_events: 0 },
    { status: 'pending' }, { claim_events: -1 }, { retry_count: -1 }, { lease_expires_at: 'sensitive-unexpected' },
  ])('rejects unsafe or mismatched claim/completion evidence without changing it: %j', async patch => {
    const env = environment(); const { state, options } = databaseFixture(env);
    state.rows.set('self-heal-preview:synthetic-job-run:fenced:E02:1', { ...completedJob(), ...patch });
    await expect(runSelfHealPreviewFencedJob('inspect', env, options)).rejects.toThrow('SELF_HEAL_PREVIEW_FENCED_JOB_FAILED');
    expect(state.queries.some(item => /^(?:INSERT|UPDATE|DELETE)/u.test(item.sql))).toBe(false);
    expect(state.queries.some(item => item.sql === 'ROLLBACK')).toBe(true); expect(state.ended).toBe(1);
  });
  it('does not call a completion proven before its deferred event arrives or while the lease is active', async () => {
    const env = environment(); const { state, options } = databaseFixture(env);
    const key = 'self-heal-preview:synthetic-job-run:fenced:E02:1';
    state.rows.set(key, { ...completedJob(), completion_events: 0, matching_completion_events: 0 });
    expect((await runSelfHealPreviewFencedJob('inspect', env, options)).job.completionVerified).toBe(false);
    state.rows.set(key, { ...completedJob(), lease_active: true });
    expect((await runSelfHealPreviewFencedJob('inspect', env, options)).job.completionVerified).toBe(false);
    state.rows.set(key, { ...completedJob(), matching_claim_events: 0 });
    expect((await runSelfHealPreviewFencedJob('inspect', env, options)).job.completionVerified).toBe(false);
  });
});
