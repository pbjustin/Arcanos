import { describe, expect, it, jest } from '@jest/globals';
import { runSelfHealPreviewControl } from '../scripts/self-heal-preview-control.mjs';
import { bindSelfHealPreviewArtifact, resolveSelfHealPreviewProfile } from '../scripts/railway-self-heal-preview-profile.mjs';

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
function environment(role = 'worker') {
  const now = Date.now();
  return {
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1',
    ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'synthetic-client-run',
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(now - 1_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(now + 60_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: 'f'.repeat(64),
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8791',
    ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal',
    ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID: id('3'),
    ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: id('4'),
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET: 'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'synthetic-client-run',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'a'.repeat(40),
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: id('6'),
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST: 'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: id('7'),
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST: 'redis.railway.internal',
    ARCANOS_PROCESS_KIND: role, ARCANOS_PREVIEW_ISOLATION: 'true', NODE_ENV: 'production',
    FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
    OPENAI_BASE_URL: role === 'worker' ? 'http://127.0.0.1:8766/v1' : 'http://127.0.0.1:9/v1',
    ARCANOS_PREVIEW_OPENAI_FIXTURE: 'backstage-heavy-compact-retry-v1',
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    DATABASE_URL: 'postgresql://synthetic-user:synthetic-password@postgres.railway.internal:5432/railway',
    REDIS_URL: 'redis://default:synthetic-redis-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: id('1'), RAILWAY_PROJECT_NAME: 'arc-pr1544-heavy-client',
    RAILWAY_ENVIRONMENT_ID: id('2'), RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1544-e2e',
    RAILWAY_SERVICE_ID: id(role === 'worker' ? '4' : '3'),
    RAILWAY_SERVICE_NAME: `arcanos-${role}-pr1544-heavy`,
    RAILWAY_DEPLOYMENT_ID: id('5'),
  };
}
function inspection(env) {
  return { runId: env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID,
    sourceCommit: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA,
    serviceId: env.RAILWAY_SERVICE_ID, projectId: env.RAILWAY_PROJECT_ID,
    environmentId: env.RAILWAY_ENVIRONMENT_ID, processInstanceId: id('8') };
}
const response = value => new Response(JSON.stringify(value), { status: 200 });

describe('fixed self-heal preview SSH control client', () => {
  it('uses only the authenticated fixed loopback inspection endpoint', async () => {
    const env = environment();
    const fetchImpl = jest.fn(async () => response(inspection(env)));
    const result = await runSelfHealPreviewControl(['inspect'], env, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8791/inspect');
    expect(request).toMatchObject({ method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${env.ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN}` } });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.body).toBeUndefined();
    expect(result.observation).toEqual(inspection(env));
    expect(JSON.stringify(result)).not.toContain(env.ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN);
  });
  it('sends only the closed command body and joins returned process identity', async () => {
    const env = environment();
    const fetchImpl = jest.fn(async () => response({ result: { rejected: true }, inspection: inspection(env) }));
    await runSelfHealPreviewControl(['command', 'prompt_worker_rejection'], env, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ command: 'prompt_worker_rejection' });
  });
  it('uses the fixed provider endpoint and fixed bounded fault parameters', async () => {
    const env = environment();
    const fetchImpl = jest.fn(async () => response({ runId: env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID,
      sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA, receipts: [] }));
    await runSelfHealPreviewControl(['provider', 'timeout_next'], env, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8766/__arcanos/self-heal-openai-fixture/control');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ command: 'timeout_next', count: 1, delayMs: 2000 });
  });
  it.each([[], ['http://example.invalid'], ['command', 'eval'], ['command', 'tick', 'extra'],
    ['provider', 'http://example.invalid'], ['inspect', '--token=synthetic']])('rejects arbitrary arguments before networking: %s', async (...argv) => {
    // Jest expands an array row into individual arguments.
    const args = argv.filter(value => typeof value === 'string');
    const fetchImpl = jest.fn();
    await expect(runSelfHealPreviewControl(args, environment(), { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects absent or production profile before reading a remote response', async () => {
    const fetchImpl = jest.fn();
    await expect(runSelfHealPreviewControl(['inspect'], {}, { fetchImpl })).rejects.toThrow();
    const env = environment(); env.RAILWAY_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
    await expect(runSelfHealPreviewControl(['inspect'], env, { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['runId', 'sourceCommit', 'serviceId', 'projectId', 'environmentId'])(
    'rejects response identity drift: %s', async field => {
      const env = environment();
      await expect(runSelfHealPreviewControl(['inspect'], env,
        { fetchImpl: async () => response({ ...inspection(env), [field]: 'foreign' }) })).rejects.toThrow();
    },
  );
  it('fails closed on reflected purpose credentials, non-JSON, excess bytes and HTTP rejection', async () => {
    const env = environment();
    for (const remote of [response({ ...inspection(env), secret: env.ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN }),
      response({ ...inspection(env), output: env.DATABASE_URL }), new Response('not JSON'),
      new Response('x'.repeat(65_537)), new Response('{}', { status: 401 })]) {
      await expect(runSelfHealPreviewControl(['inspect'], env, { fetchImpl: async () => remote })).rejects.toThrow();
    }
  });
  it('returns an independently verified artifact receipt without any network operation', async () => {
    const env = environment(); const fetchImpl = jest.fn();
    const verifyArtifact = jest.fn(() => ({ sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA,
      compiledSha256: 'b'.repeat(64), fileCount: 10 }));
    const result = await runSelfHealPreviewControl(['artifact'], env, { fetchImpl, verifyArtifact });
    expect(result.artifact.compiledSha256).toBe('b'.repeat(64));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(verifyArtifact).toHaveBeenCalledWith({ sourceSha: 'a'.repeat(40) });
  });
  it('creates only one fixed job after actual owner/artifact checks and reuses its identity', async () => {
    const env = environment();
    const artifact = { sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64), fileCount: 10 };
    const identity = JSON.stringify(bindSelfHealPreviewArtifact(resolveSelfHealPreviewProfile('worker', env), artifact).ownership);
    let job = null; const queries = []; let insertCount = 0;
    class Client {
      async connect() {}
      async end() {}
      async query(sql, args = []) {
        queries.push({ sql, args });
        if (sql.startsWith('SELECT identity')) return { rows: [{ identity }] };
        if (sql.startsWith('SELECT j.id')) return { rows: job ? [job] : [] };
        if (sql.startsWith('INSERT INTO public.job_data')) {
          insertCount += 1;
          expect(args[0]).toBe('self-heal-preview-synthetic-client-run');
          expect(JSON.parse(args[1])).toMatchObject({ prompt: 'Reply with exactly SEALED_PREVIEW_FENCED_OK', answerMode: 'direct' });
          expect(args[2]).toBe('self-heal-preview:synthetic-client-run:fenced-continuity');
          job = { id: id('9'), status: 'pending', claim_generation: '0', last_worker_id: null,
            retry_count: 0, lease_active: false, output: null, completion_events: 0 };
        }
        return { rows: [] };
      }
    }
    const options = { Client, verifyArtifact: () => artifact, fetchImpl: jest.fn() };
    const created = await runSelfHealPreviewControl(['fenced-job', 'create'], env, options);
    expect(created.fencedJob.job.status).toBe('pending');
    expect(insertCount).toBe(1);
    job = { ...job, status: 'completed', claim_generation: '1', last_worker_id: 'self-heal-preview-synthetic-client-run',
      output: { result: 'SEALED_PREVIEW_FENCED_OK' }, completion_events: 1 };
    const completed = await runSelfHealPreviewControl(['fenced-job', 'create'], env, options);
    expect(completed.fencedJob.job).toMatchObject({ status: 'completed', completionEvents: 1, literalObserved: true, claimGeneration: '1', leaseActive: false });
    expect(insertCount).toBe(1);
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(queries.some(query => query.sql.includes('CREATE TABLE'))).toBe(false);
  });
  it('refuses a foreign owner before any job insert and rolls back/ends its connection', async () => {
    const env = environment(); const queries = []; const end = jest.fn();
    class Client {
      async connect() {}
      end = end;
      async query(sql) {
        queries.push(sql);
        return { rows: sql.startsWith('SELECT identity') ? [{ identity: 'foreign-owner' }] : [] };
      }
    }
    await expect(runSelfHealPreviewControl(['fenced-job', 'create'], env, { Client,
      verifyArtifact: () => ({ sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64) }) })).rejects.toThrow();
    expect(queries.some(sql => sql.startsWith('INSERT'))).toBe(false);
    expect(queries).toContain('ROLLBACK'); expect(end).toHaveBeenCalledTimes(1);
  });
  it.each(['artifact', 'owner', 'lock'])('does not enqueue after the lease expires during %s verification', async stage => {
    const env = environment(); let clock = Date.now();
    const artifact = { sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64), fileCount: 10 };
    const identity = JSON.stringify(bindSelfHealPreviewArtifact(resolveSelfHealPreviewProfile('worker', env), artifact).ownership);
    const queries = []; const end = jest.fn(); const connect = jest.fn();
    const expire = () => { clock = Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT); };
    class Client {
      connect = connect; end = end;
      async query(sql) {
        queries.push(sql);
        if (sql.startsWith('SELECT identity')) { if (stage === 'owner') expire(); return { rows: [{ identity }] }; }
        if (sql === 'SELECT pg_advisory_xact_lock(1544, 4)' && stage === 'lock') expire();
        return { rows: [] };
      }
    }
    await expect(runSelfHealPreviewControl(['fenced-job', 'create'], env, { Client, now: () => clock,
      verifyArtifact: () => { if (stage === 'artifact') expire(); return artifact; } })).rejects.toThrow();
    expect(queries.some(sql => sql.startsWith('INSERT'))).toBe(false);
    if (stage === 'artifact') expect(connect).not.toHaveBeenCalled();
    else { expect(queries).toContain('ROLLBACK'); expect(end).toHaveBeenCalledTimes(1); }
  });
});
