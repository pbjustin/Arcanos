import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runSelfHealPreviewControl } from '../scripts/self-heal-preview-control.mjs';
import { bindSelfHealPreviewArtifact, buildSelfHealPreviewFixtureEnvironment, resolveSelfHealPreviewProfile } from '../scripts/railway-self-heal-preview-profile.mjs';
import { startSelfHealPreviewOpenAIFixture } from '../scripts/railway-backstage-heavy-openai-fixture.mjs';

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const databaseCertificate = readFileSync(new URL('./fixtures/self-heal-preview-database-ca.pem', import.meta.url), 'utf8');
const webJob = jest.fn(async (_env, options) => ({ attempt: options.attempt, consumerPath: 'ordinary-protected-gpt-web-queue-worker-sdk' }));
jest.unstable_mockModule('../scripts/self-heal-preview-web-job.mjs', () => ({ runSelfHealPreviewWebJob: webJob }));
const shutdown = jest.fn(async (_operation, scenario) => ({ evidence: 'synthetic_injected_dependencies', receipt: { scenario } }));
jest.unstable_mockModule('../scripts/self-heal-preview-shutdown.mjs', () => ({ runSelfHealPreviewShutdown: shutdown }));
const startupReceipt = jest.fn(async () => ({ evidence: 'synthetic_injected_dependencies', completed: true }));
jest.unstable_mockModule('../scripts/self-heal-preview-startup.mjs', () => ({ runSelfHealPreviewStartupReceipt: startupReceipt }));
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
    ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM: databaseCertificate,
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
    ...(role === 'worker' ? { ARCANOS_PREVIEW_OPENAI_FIXTURE: 'backstage-heavy-compact-retry-v1' } : {}),
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    ...(role === 'web' ? { ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
      ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: 'synthetic-web-access-token-purpose-only',
      ARCANOS_JOB_READ_CAPABILITY_SECRET: 'synthetic-job-result-read-purpose-only' } : {}),
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
    environmentId: env.RAILWAY_ENVIRONMENT_ID, processInstanceId: id('8'),
    deploymentId: env.RAILWAY_DEPLOYMENT_ID, processKind: env.ARCANOS_PROCESS_KIND };
}
const response = value => new Response(JSON.stringify(value), { status: 200 });
function overlapFixture(env, config = {}) {
  let clock = Date.now(); const commands = [];
  const worker = { ...inspection(env), ready: true, tickPending: false,
    consumerRun: null, observation: { holding: false },
    trinity: { snapshot: { final: { activeAction: 'bypass_final_stage', mitigationId: 1, verificationSuccesses: 0 } } } };
  const provider = { runId: env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID, sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA,
    issuedAt: Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT), expiresAt: Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT),
    expired: false, inFlight: null, nextFault: null };
  const fetchImpl = jest.fn(async (url, request) => {
    const command = request.body ? JSON.parse(request.body).command : 'inspect';
    commands.push({ provider: url.includes(':8766/'), command });
    if (url.includes(':8766/')) {
      if (command === 'hold_next') provider.nextFault = { kind: 'hold' };
      if (command === 'inspect' && worker.consumerRun?.status === 'running' && provider.nextFault && !config.noProviderRequest) {
        provider.inFlight = 'self-heal-fixture-1'; provider.nextFault = null;
      }
      if (command === 'release') {
        provider.inFlight = null;
        if (worker.consumerRun) worker.consumerRun.status = 'completed';
      }
      if (command === 'set_healthy') provider.nextFault = null;
      return response(provider);
    }
    if (command === 'tick') { worker.tickPending = true; worker.observation.holding = true; }
    if (command === 'release_observation') { worker.tickPending = false; worker.observation.holding = false; }
    if (command === 'trinity_run') worker.consumerRun = { requestId: 'preview-consumer-observed', status: 'running',
      mitigationBefore: { mitigationId: 1, activeAction: 'bypass_final_stage' } };
    if (command === 'trinity_replace') worker.trinity.snapshot.final = { activeAction: 'enable_degraded_mode', mitigationId: 2, verificationSuccesses: 0 };
    if (command === 'inspect' && worker.consumerRun && config.drift) worker.processInstanceId = id('9');
    return response(worker);
  });
  return { worker, provider, commands, fetchImpl, now: () => clock, sleep: async ms => { clock += ms; } };
}

describe('fixed self-heal preview SSH control client', () => {
  it('admits only the Worker PR1557 no-AI command without caller-supplied authorization', async () => {
    const env = { ...environment(), ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-inference-containment-v1',
      RAILWAY_PROJECT_NAME: 'arc-pr1557-heavy-client', RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1557-e2e',
      RAILWAY_SERVICE_NAME: 'arcanos-worker-pr1557-heavy' };
    const fetchImpl = jest.fn(async () => response(inspection(env)));
    await runSelfHealPreviewControl(['command', 'containment_diagnose_no_ai'], env, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ command: 'containment_diagnose_no_ai' });
    fetchImpl.mockClear();
    for (const [target, args] of [[environment(), ['command', 'containment_diagnose_no_ai']],
      [{ ...environment('web'), ARCANOS_SELF_HEAL_PREVIEW_PROFILE: env.ARCANOS_SELF_HEAL_PREVIEW_PROFILE,
        RAILWAY_PROJECT_NAME: env.RAILWAY_PROJECT_NAME, RAILWAY_ENVIRONMENT_NAME: env.RAILWAY_ENVIRONMENT_NAME,
        RAILWAY_SERVICE_NAME: 'arcanos-web-pr1557-heavy' }, ['command', 'containment_diagnose_no_ai']],
      [env, ['command', 'containment_diagnose_no_ai', 'manual']]]) {
      await expect(runSelfHealPreviewControl(args, target, { fetchImpl })).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['worker', 'web'].flatMap(role => ['inference_auth_failure_next', 'inference_late_completion_next'].map(command => [role, command])))('admits command-only containment provider fault %s/%s and excludes the legacy profile', async (role, command) => {
    const legacy = environment(role); const fetchImpl = jest.fn();
    await expect(runSelfHealPreviewControl(['provider', command], legacy, { fetchImpl })).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
    expect(fetchImpl).not.toHaveBeenCalled();
    const env = { ...legacy, ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-inference-containment-v1',
      RAILWAY_PROJECT_NAME: 'arc-pr1557-heavy-client', RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1557-e2e',
      RAILWAY_SERVICE_NAME: `arcanos-${role}-pr1557-heavy` };
    if (role === 'web' && command === 'inference_late_completion_next') {
      await expect(runSelfHealPreviewControl(['provider', command], env, { fetchImpl })).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
      expect(fetchImpl).not.toHaveBeenCalled(); return;
    }
    fetchImpl.mockImplementation(async () => response({ runId: env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID,
      sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA }));
    await runSelfHealPreviewControl(['provider', command], env, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ command });
    await expect(runSelfHealPreviewControl(['provider', command, 'key'], env, { fetchImpl })).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
  });
  it('allows fixed startup failure readback only through the surviving Web role', async () => {
    const result = await runSelfHealPreviewControl(['startup-failure-receipt'], environment('web'));
    expect(result.startup.completed).toBe(true);
    await expect(runSelfHealPreviewControl(['startup-failure-receipt'], environment())).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
    await expect(runSelfHealPreviewControl(['startup-failure-receipt', 'arbitrary'], environment('web'))).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
  });
  it('accepts only the two fixed shutdown scenarios and allows independent readback from Web', async () => {
    for (const scenario of ['A06', 'E06']) {
      const result = await runSelfHealPreviewControl(['shutdown-held', scenario], environment());
      expect(result.shutdown.receipt.scenario).toBe(scenario);
      expect(shutdown).toHaveBeenLastCalledWith('held', scenario, expect.any(Object), expect.objectContaining({ local: expect.any(Function) }));
    }
    await runSelfHealPreviewControl(['shutdown-receipt', 'A06'], environment('web'));
    expect(shutdown).toHaveBeenLastCalledWith('receipt', 'A06', expect.any(Object), expect.any(Object));
    for (const args of [['shutdown-held', 'A01'], ['shutdown-held', 'A06', '1544'], ['shutdown-receipt', 'E06', 'arbitrary']]) {
      await expect(runSelfHealPreviewControl(args, environment())).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
    }
    await expect(runSelfHealPreviewControl(['shutdown-held', 'A06'], environment('web'))).rejects.toThrow('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED');
  });
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
  it.each(['prompt_worker_rejection', 'predictive_evaluate', 'predictive_evaluate_live'])('sends only the closed %s command body and joins returned process identity', async command => {
    const env = environment();
    const fetchImpl = jest.fn(async () => response({ result: { rejected: true }, inspection: inspection(env) }));
    await runSelfHealPreviewControl(['command', command], env, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ command });
  });
  it('uses the fixed provider endpoint and fixed bounded fault parameters', async () => {
    const env = environment();
    const fetchImpl = jest.fn(async () => response({ runId: env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID,
      sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA, receipts: [] }));
    await runSelfHealPreviewControl(['provider', 'timeout_next'], env, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8766/__arcanos/self-heal-openai-fixture/control');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ command: 'timeout_next', count: 1, delayMs: 5000 });
  });
  it.each(['replacement-race', 'dependency-overlap'])('joins the closed %s commands with correlated barrier receipts', async operation => {
    const env = environment(); const fixture = overlapFixture(env);
    const result = await runSelfHealPreviewControl([operation], env, fixture);
    expect(result.overlap).toMatchObject({ operation, status: 'completed', requestId: 'preview-consumer-observed',
      held: { consumer: { consumerRun: { status: 'running', mitigationBefore: { mitigationId: 1 } } },
        provider: { inFlight: 'self-heal-fixture-1' } },
      finalState: { consumerRun: { status: 'completed' } }, cleanup: { provider: 'released' } });
    expect(fixture.commands.some(value => value.command.startsWith('policy_') || value.command === 'trinity_activate')).toBe(false);
    if (operation === 'replacement-race') expect(result.overlap.replacement.trinity.snapshot.final)
      .toMatchObject({ mitigationId: 2, verificationSuccesses: 0 });
    else expect(result.overlap).toMatchObject({ held: { consumer: { observation: { holding: true } } },
      cleanup: { observation: 'released' } });
  });
  it('accepts the actual provider numeric lease envelope for both bounded overlap controls', async () => {
    const env = environment();
    const provider = await startSelfHealPreviewOpenAIFixture({
      env: buildSelfHealPreviewFixtureEnvironment(resolveSelfHealPreviewProfile('worker', env)), port: 0,
    });
    try {
      const actualEnvelope = provider.inspect();
      expect(actualEnvelope).toMatchObject({
        issuedAt: Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT),
        expiresAt: Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT), expired: false,
      });
      for (const operation of ['replacement-race', 'dependency-overlap']) {
        const fixture = overlapFixture(env); Object.assign(fixture.provider, actualEnvelope);
        const result = await runSelfHealPreviewControl([operation], env, fixture);
        expect(result.overlap).toMatchObject({ status: 'completed', cleanup: { provider: 'released' } });
        expect(result.overlap.providerBaseline.issuedAt).toBe(actualEnvelope.issuedAt);
        expect(result.overlap.providerBaseline.expiresAt).toBe(actualEnvelope.expiresAt);
      }
    } finally { await provider.close(); }
  }, 5_000);
  it.each(['issuedAt', 'expiresAt', 'issuedAtString', 'expiresAtString', 'expired'])(
    'rejects provider lease drift before arming or releasing effects: %s', async defect => {
      const env = environment(); const fixture = overlapFixture(env);
      if (defect === 'expired') fixture.provider.expired = true;
      else if (defect.endsWith('String')) {
        const field = defect.replace('String', ''); fixture.provider[field] = new Date(fixture.provider[field]).toISOString();
      } else fixture.provider[defect] += 1;
      const result = await runSelfHealPreviewControl(['dependency-overlap'], env, fixture);
      expect(result.overlap).toMatchObject({ status: 'incomplete', providerBaseline: null, held: null,
        reasonCode: 'SELF_HEAL_PREVIEW_OVERLAP_NOT_ESTABLISHED', cleanup: { provider: 'not_armed', observation: 'not_armed' } });
      expect(fixture.commands.map(value => value.command)).toEqual(['inspect', 'inspect']);
      expect(fixture.provider.inFlight).toBeNull(); expect(fixture.provider.nextFault).toBeNull();
      expect(fixture.worker.consumerRun).toBeNull(); expect(fixture.worker.observation.holding).toBe(false);
    });
  it('rejects changed process authority before replacement while still releasing its owned provider hold', async () => {
    const env = environment(); const fixture = overlapFixture(env, { drift: true });
    const result = await runSelfHealPreviewControl(['replacement-race'], env, fixture);
    expect(result.overlap).toMatchObject({ status: 'incomplete', reasonCode: 'SELF_HEAL_PREVIEW_OVERLAP_NOT_ESTABLISHED' });
    expect(fixture.commands.some(value => value.command === 'trinity_replace')).toBe(false);
    expect(fixture.commands.some(value => value.provider && value.command === 'release')).toBe(true);
  });
  it('does not release or replace a provider fault it did not arm', async () => {
    const env = environment(); const fixture = overlapFixture(env); fixture.provider.nextFault = { kind: 'other-owned-fault' };
    const result = await runSelfHealPreviewControl(['replacement-race'], env, fixture);
    expect(result.overlap).toMatchObject({ status: 'incomplete', cleanup: { provider: 'not_armed' } });
    expect(fixture.commands.map(value => value.command)).toEqual(['inspect', 'inspect']);
  });
  it('does not release an existing observation barrier owned by another operation', async () => {
    const env = environment(); const fixture = overlapFixture(env); fixture.worker.observation.holding = true;
    const result = await runSelfHealPreviewControl(['dependency-overlap'], env, fixture);
    expect(result.overlap).toMatchObject({ status: 'incomplete', cleanup: { provider: 'not_armed', observation: 'not_armed' } });
    expect(fixture.commands.map(value => value.command)).toEqual(['inspect']);
    expect(fixture.worker.observation.holding).toBe(true);
  });
  it('bounds an unestablished provider overlap and restores only its own fault', async () => {
    const env = environment(); const fixture = overlapFixture(env, { noProviderRequest: true });
    const result = await runSelfHealPreviewControl(['replacement-race'], env, fixture);
    expect(result.overlap).toMatchObject({ status: 'incomplete', cleanup: { provider: 'released' } });
    expect(fixture.commands.filter(value => value.provider && value.command === 'inspect').length).toBeLessThanOrEqual(17);
    expect(fixture.provider.nextFault).toBeNull(); expect(fixture.provider.inFlight).toBeNull();
  });
  it.each([[], ['http://example.invalid'], ['command', 'eval'], ['command', 'tick', 'extra'],
    ['provider', 'http://example.invalid'], ['inspect', '--token=synthetic'], ['fenced-job', 'create'],
    ['fenced-job', 'create', 'E02', '3'], ['fenced-job', 'create', 'E02', '01'],
    ['fenced-job', 'create', 'E99', '1'], ['fenced-job', 'inspect', 'e02', '1'],
    ['web-job', 'run', '3'], ['web-job', 'run', '01'], ['web-job', 'run', '1', 'extra']])('rejects arbitrary arguments before networking: %s', async (...argv) => {
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
  it.each(['runId', 'sourceCommit', 'serviceId', 'projectId', 'environmentId', 'deploymentId', 'processKind'])(
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
  it.each(['1', '2'])('forwards only the closed web admission slot %s to the existing owned helper', async attempt => {
    const env = environment('web'); const fetchImpl = jest.fn();
    const result = await runSelfHealPreviewControl(['web-job', 'run', attempt], env, { fetchImpl, attempt: 99 });
    expect(webJob).toHaveBeenLastCalledWith(env, expect.objectContaining({ attempt: Number(attempt), fetchImpl }));
    expect(result.webJob).toMatchObject({ attempt: Number(attempt), consumerPath: 'ordinary-protected-gpt-web-queue-worker-sdk' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects role-swapped web and fenced job operations before any effect', async () => {
    const fetchImpl = jest.fn(); const connect = jest.fn();
    class Client { connect = connect; }
    await expect(runSelfHealPreviewControl(['web-job', 'run', '1'], environment(), { fetchImpl, Client })).rejects.toThrow();
    await expect(runSelfHealPreviewControl(['fenced-job', 'create', 'E02', '1'], environment('web'), { fetchImpl, Client })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
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
          expect(args[2]).toBe('self-heal-preview:synthetic-client-run:fenced:E02:1');
          job = { id: id('9'), status: 'pending', claim_generation: '0', last_worker_id: null,
            retry_count: 0, lease_active: false, lease_expires_at: null, output: null,
            claim_events: 0, matching_claim_events: 0, completion_events: 0, matching_completion_events: 0 };
        }
        return { rows: [] };
      }
    }
    const options = { Client, verifyArtifact: () => artifact, fetchImpl: jest.fn() };
    const created = await runSelfHealPreviewControl(['fenced-job', 'create', 'E02', '1'], env, options);
    expect(created.fencedJob.job.status).toBe('pending');
    expect(insertCount).toBe(1);
    job = { ...job, status: 'completed', claim_generation: '1', last_worker_id: 'self-heal-preview-synthetic-client-run-slot-1',
      output: { result: 'SEALED_PREVIEW_FENCED_OK' }, claim_events: 1, matching_claim_events: 1, completion_events: 1, matching_completion_events: 1 };
    const completed = await runSelfHealPreviewControl(['fenced-job', 'create', 'E02', '1'], env, options);
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
    await expect(runSelfHealPreviewControl(['fenced-job', 'create', 'E02', '1'], env, { Client,
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
    await expect(runSelfHealPreviewControl(['fenced-job', 'create', 'E02', '1'], env, { Client, now: () => clock,
      verifyArtifact: () => { if (stage === 'artifact') expire(); return artifact; } })).rejects.toThrow();
    expect(queries.some(sql => sql.startsWith('INSERT'))).toBe(false);
    if (stage === 'artifact') expect(connect).not.toHaveBeenCalled();
    else { expect(queries).toContain('ROLLBACK'); expect(end).toHaveBeenCalledTimes(1); }
  });
});
