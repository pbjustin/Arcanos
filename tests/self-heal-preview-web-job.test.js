import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runSelfHealPreviewWebJob } from '../scripts/self-heal-preview-web-job.mjs';
import { bindSelfHealPreviewArtifact, resolveSelfHealPreviewProfile } from '../scripts/railway-self-heal-preview-profile.mjs';
import { BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT } from '../scripts/railway-backstage-heavy-openai-fixture.mjs';

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

function webFixture() {
  const env = environment('web'); const { state, options } = databaseFixture(env);
  const correlation = 'self-heal-preview:synthetic-job-run:web:1';
  const jobId = id('8'); const capability = `v1.${'x'.repeat(43)}`;
  let submission = 0; const requests = []; let clock = NOW;
  const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
  const fetchImpl = jest.fn(async (url, request) => {
    requests.push({ url, request });
    if (request.method === 'POST') {
      state.rows.set(correlation, completedJob(2));
      return response({ jobId, jobReadToken: capability, jobReadTokenHeader: 'x-arcanos-job-read-token',
        poll: `/jobs/${jobId}/result`, idempotencySource: 'derived', idempotencyKey: `derived:${'i'.repeat(32)}`,
        // Match buildQueuedGptPendingResponse: a created response omits the
        // field; only a reused response carries deduped: true.
        ...(submission++ > 0 ? { deduped: true } : {}) }, 202, { 'x-gpt-queue-bypassed': 'false', 'x-gpt-route-decision-reason': 'backstage_prompt_size',
        'x-request-id': request.headers['x-request-id'], 'x-trace-id': request.headers['x-trace-id'], 'cache-control': 'no-store' });
    }
    if (!request.headers) return response({ status: 'not_found', result: null });
    return response({ status: 'completed', jobStatus: 'completed', lifecycleStatus: 'completed', error: null,
      result: { ok: true, result: BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
        _route: { gptId: 'backstage-booker', action: 'generateBooking', requestId: `${correlation}:a`, traceId: correlation } } });
  });
  return { env, state, options: { ...options, now: () => clock, fetchImpl,
    sleep: async ms => { clock += ms; } }, requests, response, capability };
}
describe('ordinary web-to-Worker proof with injected transport only in fixtures', () => {
  it('joins normal authenticated admission, concealed public read and capability result to independent PostgreSQL evidence', async () => {
    const fixture = webFixture();
    const result = await runSelfHealPreviewWebJob(fixture.env, fixture.options);
    expect(result).toMatchObject({ duplicatePrevented: true, unauthorizedResultConcealed: true,
      consumerPath: 'ordinary-protected-gpt-web-queue-worker-sdk', externalProviderRecoveryProven: false,
      database: { job: { completionVerified: true, lastWorkerId: 'self-heal-preview-synthetic-job-run-slot-2' } } });
    expect(fixture.requests).toHaveLength(4);
    for (const { url, request } of fixture.requests) {
      expect(url.startsWith('http://127.0.0.1:8080/')).toBe(true);
      expect(request.redirect).toBe('error'); expect(request.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fixture.requests[0].request.body).toBe(fixture.requests[1].request.body);
    expect(fixture.requests[0].request.headers.authorization).toBe(`Bearer ${fixture.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN}`);
    expect(fixture.state.queries.some(item => item.sql.startsWith('INSERT'))).toBe(false);
    for (const secret of [fixture.capability, fixture.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN,
      fixture.env.DATABASE_URL, fixture.env.ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN]) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('fails ownership admission before any HTTP write or read', async () => {
    const fixture = webFixture(); fixture.state.identity = 'foreign';
    await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow('SELF_HEAL_PREVIEW_WEB_JOB_FAILED');
    expect(fixture.options.fetchImpl).not.toHaveBeenCalled();
  });
  it('accepts an idempotent closed-slot rerun when both submissions reuse the same job and capability', async () => {
    const fixture = webFixture(); const fetch = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (url, request) => {
      const response = await fetch(url, request);
      if (request.method !== 'POST') return response;
      return fixture.response({ ...await response.json(), deduped: true }, response.status, Object.fromEntries(response.headers));
    };
    const result = await runSelfHealPreviewWebJob(fixture.env, fixture.options);
    expect(result).toMatchObject({ jobId: id('8'), duplicatePrevented: true,
      database: { job: { completionVerified: true, completionEvents: 1 } } });
  });
  it.each(['two-created', 'false', 'null', 'string', 'different-job', 'different-capability'])(
    'rejects %s submission evidence before any result read', async fault => {
      const fixture = webFixture(); const fetch = fixture.options.fetchImpl; let submissions = 0;
      fixture.options.fetchImpl = async (url, request) => {
        const response = await fetch(url, request);
        if (request.method !== 'POST') return response;
        const body = await response.json(); submissions += 1;
        if (fault === 'two-created') delete body.deduped;
        if (fault === 'false') body.deduped = false;
        if (fault === 'null') body.deduped = null;
        if (fault === 'string') body.deduped = 'true';
        if (submissions === 2 && fault === 'different-job') body.jobId = id('9');
        if (submissions === 2 && fault === 'different-capability') body.jobReadToken = `v1.${'y'.repeat(43)}`;
        return fixture.response(body, response.status, Object.fromEntries(response.headers));
      };
      await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow('SELF_HEAL_PREVIEW_WEB_JOB_FAILED');
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests.every(item => item.request.method === 'POST')).toBe(true);
    },
  );
  it('never treats a successful HTTP result as completion when independent PostgreSQL evidence is absent', async () => {
    const fixture = webFixture(); const fetch = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (...args) => { const response = await fetch(...args); fixture.state.rows.clear(); return response; };
    await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow('SELF_HEAL_PREVIEW_WEB_JOB_FAILED');
    expect(fixture.requests.length).toBeLessThanOrEqual(243);
  });
  it('bounds pending requests by the real proof deadline without accepting a timeout as recovery', async () => {
    const fixture = webFixture(); const fetch = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (url, request) => request.headers?.['x-arcanos-job-read-token']
      ? fixture.response({ status: 'pending', result: null }) : fetch(url, request);
    let elapsed = 0;
    fixture.options.now = () => NOW + elapsed;
    fixture.options.sleep = async ms => { elapsed += ms; };
    await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow('SELF_HEAL_PREVIEW_WEB_JOB_FAILED');
    expect(elapsed).toBe(120_000);
    expect(fixture.state.queries.filter(item => item.sql.startsWith('SELECT j.id'))).toHaveLength(0);
  });
  it('projects only fixed result facts even when successful responses contain purpose credentials in unrelated fields', async () => {
    const fixture = webFixture(); const fetch = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (...args) => {
      const response = await fetch(...args); const body = await response.json();
      return fixture.response({ ...body, unexpected: { raw: fixture.env.DATABASE_URL,
        bearer: fixture.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN } }, response.status, Object.fromEntries(response.headers));
    };
    const result = JSON.stringify(await runSelfHealPreviewWebJob(fixture.env, fixture.options));
    expect(result).not.toContain(fixture.env.DATABASE_URL);
    expect(result).not.toContain(fixture.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN);
    expect(result).not.toContain('unexpected');
  });
  it('rejects a caller-controlled poll target before issuing any result read', async () => {
    const fixture = webFixture(); const fetch = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (...args) => {
      const response = await fetch(...args); const body = await response.json();
      return fixture.response({ ...body, poll: 'https://foreign.invalid/jobs' }, response.status, Object.fromEntries(response.headers));
    };
    await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow('SELF_HEAL_PREVIEW_WEB_JOB_FAILED');
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.every(item => item.request.method === 'POST')).toBe(true);
  });
  it.each(['duplicate-completion', 'foreign-slot', 'wrong-generation'])('rejects %s even after a successful ordinary HTTP result', async fault => {
    const fixture = webFixture(); const fetch = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (...args) => {
      const response = await fetch(...args);
      const job = fixture.state.rows.get('self-heal-preview:synthetic-job-run:web:1');
      if (job) Object.assign(job, fault === 'duplicate-completion' ? { completion_events: 2, matching_completion_events: 2 }
        : fault === 'foreign-slot' ? { last_worker_id: 'foreign' } : { matching_completion_events: 0 });
      return response;
    };
    await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow('SELF_HEAL_PREVIEW_WEB_JOB_FAILED');
  });
  it.each(['worker', 'bad-attempt', 'expired', 'oversize', 'redirect', 'sensitive-error'])('fails closed and redacts %s', async fault => {
    const fixture = webFixture();
    if (fault === 'worker') fixture.env.ARCANOS_PROCESS_KIND = 'worker';
    if (fault === 'bad-attempt') fixture.options.attempt = 3;
    if (fault === 'expired') fixture.options.now = () => NOW + 600_001;
    if (fault === 'oversize') fixture.options.fetchImpl = async () => fixture.response({ huge: 'sensitive'.repeat(10_000) });
    if (fault === 'redirect') fixture.options.fetchImpl = async () => fixture.response({}, 307, { location: 'https://foreign.invalid' });
    if (fault === 'sensitive-error') fixture.options.fetchImpl = async () => { throw new Error(fixture.env.DATABASE_URL); };
    await expect(runSelfHealPreviewWebJob(fixture.env, fixture.options)).rejects.toThrow(/^SELF_HEAL_PREVIEW_WEB_JOB_FAILED$/u);
  });
});
