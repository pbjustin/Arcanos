import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import OpenAI from 'openai';
import { getRequestAbortSignal, runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createValidationRuntimeApplication, LIVE_VALIDATION_ACCEPTANCE_WORK_TIMEOUT_MS,
  LIVE_VALIDATION_ACCEPTANCE_RESPONSE_GRACE_MS } from './start-live-validation-runtime.mjs';
import { createValidationSupervisorApplication } from './start-live-validation-supervisor.mjs';
import { createLivePreviewProviderFetch } from './start-live-pr-preview.mjs';
import { assertValidationRoleCredentials, validationHash } from './live-validation-bootstrap.mjs';
import { createLiveValidationBudget } from './live-validation-budget.mjs';
import { liveValidationTargetSha256, signLiveValidationPlan } from './live-validation-policy.mjs';
import { LIVE_VALIDATION_PROJECT_ID } from './live-validation-target.mjs';

const profiles = JSON.parse(readFileSync(new URL('../examples/live-validation/profiles.json', import.meta.url), 'utf8'));
const keys = generateKeyPairSync('ed25519');
const id = suffix => '10000000-0000-4000-8000-' + String(suffix).padStart(12, '0');
const MODEL = 'ft:gpt-6-luna:arcanos:gaming:offline';
const PRIVATE_PROMPT = 'private-prompt-do-not-project';
const PRIVATE_PROVIDER = 'private-provider-body-do-not-project';
const PRIVATE_ANSWER = 'private-module-answer-do-not-project [1]';
const CREDENTIAL = 'sk-offlineSyntheticSupervisorCredential';
const POSITIVE = 'gaming-guide-positive';
const NEGATIVE = 'gaming-guide-negative';

async function request(application, role, method, url, body, headers = {}) {
  let status; let text = '';
  const response = { writeHead(value) { status = value; }, end(value = '') { text += value; } };
  const native = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(native, { method, url, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
  if (!await application.authorizeRequest({ role, method, path: url, headers: native.headers })) {
    response.writeHead(403); response.end(JSON.stringify({ error: { code: 'LIVE_VALIDATION_TLS_ROLE_FORBIDDEN' } }));
  } else await application.handler(native, response, { role });
  return { status, body: JSON.parse(text), text };
}

function fixture(t, overrides = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-services-offline-'));
  const repositoryRoot = path.join(temporary, 'checkout'); const directory = path.join(temporary, 'ledger');
  mkdirSync(repositoryRoot, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  let clock = Date.now(); const now = () => clock;
  const target = { version: 'arcanos-live-validation-target/v1', repository: 'pbjustin/Arcanos',
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId: id(1), environmentName: 'live-validation',
    runtimeServiceId: id(2), supervisorServiceId: id(3), privateOrigins: {
      runtime: 'https://runtime.railway.internal:8443', supervisor: 'https://supervisor.railway.internal:8443' },
    mtlsPeers: { runtime: { dns: 'runtime.railway.internal', sha256: '1'.repeat(64) },
      supervisor: { dns: 'supervisor.railway.internal', sha256: '2'.repeat(64) },
      verifier: { dns: 'verifier.railway.internal', sha256: '3'.repeat(64) } },
    trustedSupervisorSha: 'b'.repeat(40), limits: {
      maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 },
    models: [MODEL, 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 })), writes: false };
  const plan = { version: 'arcanos-live-validation-run/v1', runId: 'a'.repeat(32), repository: target.repository,
    prNumber: 1527, commitSha: 'a'.repeat(40), profile: 'gaming-guide', profileHash: validationHash(profiles),
    artifactAttestationSha256: '5'.repeat(64), issuedAtMs: clock, expiresAtMs: clock + target.limits.durationMs,
    projectId: target.projectId, environmentId: target.environmentId,
    runtimeServiceId: target.runtimeServiceId, runtimeDeploymentId: id(4),
    supervisorServiceId: target.supervisorServiceId, supervisorDeploymentId: id(5),
    trustedSupervisorSha: target.trustedSupervisorSha, targetHash: liveValidationTargetSha256(target),
    paidAuthorized: true, offlineGateHash: '6'.repeat(64), runtimeBuildManifestSha256: '7'.repeat(64), supervisorBuildManifestSha256: '8'.repeat(64) };
  const identity = role => ({ role, sourceCommit: role === 'runtime' ? plan.commitSha : plan.trustedSupervisorSha,
    projectId: target.projectId, environmentId: target.environmentId, serviceId: plan[role + 'ServiceId'],
    deploymentId: plan[role + 'DeploymentId'], buildManifestSha256: plan[role + 'BuildManifestSha256'] });
  let credentialReads = 0; let providerCalls = 0; let adapterCreates = 0; let adapterExecutes = 0;
  const seen = []; let context; let lastObservation;
  const budget = createLiveValidationBudget({ directory, repositoryRoot, now });
  const supervisor = createValidationSupervisorApplication({ target, identity: identity('supervisor'), profiles,
    budget, now, trustedPublicKey: keys.publicKey,
    resolveCredential: ({ probe } = {}) => { if (probe) return true; credentialReads++; return CREDENTIAL; },
    invokeProvider: async value => {
      providerCalls++; seen.push(value);
      assert.equal(value.headers.authorization, 'Bearer ' + CREDENTIAL);
      if (overrides.invokeProvider) return overrides.invokeProvider(value);
      return value.method === 'GET' ? { status: 200, body: { id: MODEL, object: 'model' } }
        : { status: 200, body: { id: 'offline-response', object: 'response', status: 'completed', model: value.body.model,
          output: [], output_text: PRIVATE_PROVIDER, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
    } });
  const supervisorClient = {
    requestJSON: (url, options = {}) => request(supervisor, 'runtime', options.method ?? 'GET', url, options.body, options.headers),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const value = await request(supervisor, 'runtime', init.method, url.pathname,
        init.body === undefined ? undefined : JSON.parse(init.body), Object.fromEntries(new Headers(init.headers)));
      return new Response(JSON.stringify(value.body), { status: value.status, headers: { 'content-type': 'application/json' } });
    }
  };
  const adapter = {
    moduleId: 'gaming', validateInput: input => ({ ok: true, input }),
    async execute(input, observer) {
      adapterExecutes++;
      if (overrides.execute) {
        const result = await overrides.execute({ input, observer, context, adapter });
        if (result !== undefined) return result;
      }
      observer.onSourceAcquisition('passed');
      const positive = input.query.idempotencyKey === profiles.profiles.find(value => value.id === POSITIVE).input.query.idempotencyKey;
      if (!positive) {
        observer.onSourceValidation('rejected');
        lastObservation = { outcome: 'need_new_source', semanticGap: 'CONFLICT',
          candidates: [{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }], stages: { answer_audit: { status: 'not_run', elapsedMs: null } } };
        return { accepted: false, failureCode: 'INCOMPATIBLE_SOURCE' };
      }
      observer.onSourceValidation('passed');
      const providerFetch = createLivePreviewProviderFetch({ brokerOrigin: target.privateOrigins.supervisor,
        session: { ...context.session, models: target.models, sourceCommit: plan.commitSha,
          deploymentId: plan.runtimeDeploymentId, moduleIds: ['gaming'] }, observation: context.observation,
        now, fetchImplementation: (input, init) => supervisorClient.fetch(input, { ...init,
          headers: { ...init.headers, 'x-arcanos-live-run-id': context.session.runId } }) });
      // Exercise the real OpenAI SDK transport against the real signed, metered broker; the provider is an offline boundary.
      const client = new OpenAI({ apiKey: context.session.brokerBearer,
        baseURL: target.privateOrigins.supervisor + '/v1', maxRetries: 0, fetch: providerFetch });
      await client.models.retrieve(MODEL);
      await client.responses.create({ model: MODEL, input: PRIVATE_PROMPT, max_output_tokens: 100 });
      observer.onAnswerAuditStart();
      await client.responses.create({ model: 'gpt-6-luna', input: PRIVATE_PROMPT, max_output_tokens: 100 });
      lastObservation = { outcome: 'accepted', semanticGap: 'NONCRITICAL_GAP', coverage: { satisfied: true },
        selectedEvidenceCount: 1, qualification: { visible: true, claimsVerifiedCurrentness: false },
        candidates: [], stages: { answer_audit: { status: 'passed', elapsedMs: 0 } } };
      return { accepted: true, audit: { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: !overrides.unbound },
        result: { ok: true, data: { response: PRIVATE_ANSWER,
          sources: [{ url: 'https://guides.example.org/private/path?private-query=sentinel', snippet: 'private-source-passage' }],
          grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true, fetchedSuppliedSourceCount: 1,
            usableSourceCount: 1, citableSourceCount: 1, selectedChunkCount: 1, suppliedEvidenceSourceCount: 1 } } } };
    }, getLastObservation: () => structuredClone(lastObservation)
  };
  const runtime = createValidationRuntimeApplication({ target, identity: identity('runtime'), profiles, now,
    supervisorClient, createAdapter: async value => { adapterCreates++; context = value; return adapter; },
    ...(overrides.runRequest ? { runRequest: overrides.runRequest } : {}) });
  t.after(() => { supervisor.close(); rmSync(temporary, { recursive: true, force: true }); });
  let session;
  const headers = () => ({ authorization: 'Bearer ' + session.testBearer, 'x-arcanos-live-run-id': session.runId,
    'x-arcanos-source-commit': plan.commitSha, 'x-arcanos-deployment-id': plan.runtimeDeploymentId });
  const signedPlan = () => signLiveValidationPlan(plan, keys.privateKey);
  async function admit() {
    const registered = await request(supervisor, 'verifier', 'POST', '/runs', signedPlan());
    assert.equal(registered.status, 200); session = registered.body;
    const accepted = await request(runtime, 'verifier', 'POST', '/admit', { signedPlan: signedPlan(), session });
    assert.equal(accepted.status, 200); return session;
  }
  const profile = caseId => profiles.profiles.find(value => value.id === caseId);
  const acceptance = (caseId, changes = {}) => request(runtime, 'verifier', 'POST', '/acceptance',
    { runId: session.runId, caseId, input: profile(caseId).input, ...changes }, headers());
  const workflow = (caseId, action) => request(supervisor, 'verifier', 'POST', `/runs/${session.runId}/workflows/${caseId}/${action}`);
  return { runtime, supervisor, supervisorClient, target, plan, identity, headers, signedPlan, admit, acceptance, workflow,
    profile, adapter, context: () => context, session: () => session, seen,
    advance: amount => { clock += amount; }, counts: () => ({ credentialReads, providerCalls, adapterCreates, adapterExecutes }) };
}

test('readiness and private handshake expose identities without provider access or candidate imports', async t => {
  const f = fixture(t);
  const ready = await request(f.runtime, 'verifier', 'GET', '/ready'); assert.equal(ready.status, 200);
  assert.equal(ready.body.readiness.providerCallsEnabled, false);
  const supervisorReady = await request(f.supervisor, 'verifier', 'GET', '/ready'); assert.equal(supervisorReady.status, 200);
  assert.equal(supervisorReady.body.readiness.modelCredentialBound, true);
  const handshake = await request(f.runtime, 'verifier', 'POST', '/handshake', { challenge: '9'.repeat(32) });
  assert.equal(handshake.status, 200); assert.equal(handshake.body.verified, true);
  assert.deepEqual(f.counts(), { credentialReads: 0, providerCalls: 0, adapterCreates: 0, adapterExecutes: 0 });
  const denied = await request(f.runtime, 'runtime', 'GET', '/ready'); assert.equal(denied.status, 403);
});

test('unsigned, expired and wrong-deployment plans cannot create a session or import an adapter', async t => {
  const f = fixture(t);
  const unsigned = f.signedPlan(); delete unsigned.signature;
  assert.equal((await request(f.supervisor, 'verifier', 'POST', '/runs', unsigned)).status, 403);
  f.plan.expiresAtMs = f.plan.issuedAtMs;
  assert.equal((await request(f.supervisor, 'verifier', 'POST', '/runs', f.signedPlan())).status, 403);
  assert.equal(f.counts().credentialReads, 0); assert.equal(f.counts().adapterCreates, 0);
  f.plan.expiresAtMs += 600_000;
  const result = await request(f.runtime, 'verifier', 'POST', '/admit', { signedPlan: f.signedPlan(),
    session: { runId: f.plan.runId, brokerBearer: '4'.repeat(64), testBearer: 'arcanos-live-validation-' + '5'.repeat(64), expiresAtMs: f.plan.expiresAtMs } });
  assert.equal(result.status, 403); assert.equal(f.counts().adapterCreates, 0);
  for (const [field, value] of [['runtimeDeploymentId', id(99)], ['commitSha', 'c'.repeat(40)]]) {
    const changed = fixture(t); changed.plan[field] = value;
    const signedPlan = changed.signedPlan();
    const registered = await request(changed.supervisor, 'verifier', 'POST', '/runs', signedPlan);
    assert.equal(registered.status, 200);
    const admission = await request(changed.runtime, 'verifier', 'POST', '/admit', { signedPlan, session: registered.body });
    assert.equal(admission.status, 403); assert.equal(changed.counts().adapterCreates, 0);
  }
});

test('session expiry during supervisor admission lookup is checked before any adapter import', async t => {
  const f = fixture(t); const signedPlan = f.signedPlan();
  const registered = await request(f.supervisor, 'verifier', 'POST', '/runs', signedPlan);
  assert.equal(registered.status, 200);
  const original = f.supervisorClient.requestJSON;
  f.supervisorClient.requestJSON = async (...args) => {
    const result = await original(...args);
    if (args[0].endsWith('/session')) f.advance(600_000);
    return result;
  };
  const admitted = await request(f.runtime, 'verifier', 'POST', '/admit', { signedPlan, session: registered.body });
  assert.equal(admitted.status, 403); assert.equal(f.counts().adapterCreates, 0); assert.equal(f.counts().providerCalls, 0);
});

test('runtime admission is backed by the signed supervisor session and carries no provider credential', async t => {
  const f = fixture(t); await f.admit();
  assert.deepEqual(f.counts(), { credentialReads: 1, providerCalls: 0, adapterCreates: 1, adapterExecutes: 0 });
  assert.equal(f.context().observation().moduleId, 'gaming');
  const native = JSON.stringify(f.context()); assert.equal(native.includes(CREDENTIAL), false);
  assert.equal(Object.hasOwn(f.context(), 'resolveCredential'), false);
  assert.throws(() => assertValidationRoleCredentials('runtime', { ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY: CREDENTIAL }),
    { code: 'LIVE_VALIDATION_UNRELATED_CREDENTIAL_FORBIDDEN' });
  const second = await request(f.runtime, 'verifier', 'POST', '/admit', { signedPlan: f.signedPlan(), session: f.session() });
  assert.equal(second.status, 403); assert.equal(f.counts().adapterCreates, 1);
});

test('acceptance rejects wrong bearer, source, deployment, run, input, case and expired authorization before execution', async t => {
  const f = fixture(t); await f.admit();
  const body = { runId: f.session().runId, caseId: POSITIVE, input: f.profile(POSITIVE).input };
  for (const changed of [{ authorization: 'Bearer wrong' }, { 'x-arcanos-source-commit': 'c'.repeat(40) },
    { 'x-arcanos-deployment-id': id(99) }, { 'x-arcanos-live-run-id': 'c'.repeat(32) }]) {
    assert.equal((await request(f.runtime, 'verifier', 'POST', '/acceptance', body, { ...f.headers(), ...changed })).status, 403);
  }
  for (const changed of [{ runId: 'c'.repeat(32) }, { caseId: 'arbitrary-case' }, { input: { invalid: true } }]) {
    assert.equal((await f.acceptance(POSITIVE, changed)).status, 403);
  }
  assert.equal(f.counts().adapterExecutes, 0); assert.equal(f.counts().providerCalls, 0);
  f.advance(600_000); assert.equal((await f.acceptance(POSITIVE)).status, 403);
  assert.equal(f.counts().adapterExecutes, 0);
});

test('actual SDK calls use broker identity and both generation/audit counters before sanitized application evidence', async t => {
  const f = fixture(t); await f.admit(); assert.equal((await f.workflow(POSITIVE, 'begin')).status, 200);
  const positive = await f.acceptance(POSITIVE); assert.equal(positive.status, 200);
  assert.equal(positive.body.profilePassed, true); assert.equal(positive.body.verification.status, 'PASS');
  assert.deepEqual(positive.body.providerDelta, { providerCalls: 2, generationCalls: 1, auditCalls: 1 });
  assert.equal(positive.body.observation.stages.response.status, 'passed');
  assert.equal(f.seen.length, 3); assert.equal(f.seen[0].method, 'GET');
  for (const forbidden of [CREDENTIAL, f.session().brokerBearer, f.session().testBearer, PRIVATE_PROMPT,
    PRIVATE_PROVIDER, PRIVATE_ANSWER, 'private-source-passage', 'private-query=sentinel', '/private/path']) {
    assert.equal(positive.text.includes(forbidden), false, forbidden);
  }
  assert.equal((await f.workflow(POSITIVE, 'end')).status, 200);
  assert.equal((await f.workflow(NEGATIVE, 'begin')).status, 200);
  const negative = await f.acceptance(NEGATIVE); assert.equal(negative.status, 200); assert.equal(negative.body.profilePassed, true);
  assert.deepEqual(negative.body.providerDelta, { providerCalls: 0, generationCalls: 0, auditCalls: 0 });
  assert.equal(f.counts().providerCalls, 3); assert.equal((await f.workflow(NEGATIVE, 'end')).status, 200);
  assert.equal((await f.acceptance(POSITIVE)).status, 403);
});

test('metered provider observations cannot qualify a positive result whose final answer binding is missing', async t => {
  const f = fixture(t, { unbound: true }); await f.admit(); await f.workflow(POSITIVE, 'begin');
  const result = await f.acceptance(POSITIVE); assert.equal(result.status, 200);
  assert.equal(result.body.profilePassed, false); assert.equal(result.body.verification.status, 'FAIL');
  assert.equal(result.body.evidence.audit.boundToFinalAnswer, false); assert.equal(f.counts().providerCalls, 3);
});

test('initial usage and adapter work share an absolute acceptance budget, leaving time for final usage and audit evidence', async t => {
  let f; let workTimeout;
  f = fixture(t, { runRequest: async (options, work) => {
    workTimeout = options.timeoutMs; f.advance(295_000); return work();
  } });
  await f.admit(); await f.workflow(POSITIVE, 'begin');
  const initialNow = f.plan.issuedAtMs; const requestJSON = f.supervisorClient.requestJSON; const readTimeouts = [];
  f.supervisorClient.requestJSON = async (route, options) => {
    const result = await requestJSON(route, options);
    if (route.endsWith('/usage')) { readTimeouts.push(options.timeoutMs); f.advance(4_900); }
    return result;
  };
  const result = await f.acceptance(POSITIVE);
  assert.equal(result.status, 200); assert.equal(result.body.profilePassed, true);
  assert.equal(result.body.evidence.audit.assessmentStatus, 'completed'); assert.equal(result.body.evidence.audit.boundToFinalAnswer, true);
  assert.equal(workTimeout, 295_100); assert.deepEqual(readTimeouts, [5_000, 5_000]);
  assert.equal(f.counts().providerCalls, 3);
  assert.ok(initialNow + 304_800 < f.session().expiresAtMs);
  assert.equal(LIVE_VALIDATION_ACCEPTANCE_WORK_TIMEOUT_MS, 300_000);
  assert.equal(LIVE_VALIDATION_ACCEPTANCE_RESPONSE_GRACE_MS, 10_000);
});

test('near run expiry the runtime reserves response grace and caps work and usage reads at the signed deadline', async t => {
  let f; let workTimeout;
  f = fixture(t, { runRequest: async (options, work) => { workTimeout = options.timeoutMs; return work(); } });
  await f.admit(); await f.workflow(NEGATIVE, 'begin'); f.advance(570_000);
  const requestJSON = f.supervisorClient.requestJSON; const readTimeouts = [];
  f.supervisorClient.requestJSON = async (route, options) => {
    if (route.endsWith('/usage')) readTimeouts.push(options.timeoutMs);
    return requestJSON(route, options);
  };
  const result = await f.acceptance(NEGATIVE);
  assert.equal(result.status, 200); assert.equal(result.body.profilePassed, true);
  assert.equal(workTimeout, 20_000); assert.deepEqual(readTimeouts, [5_000, 5_000]);
  assert.equal(f.counts().providerCalls, 0);
});

test('insufficient signed-run response grace denies acceptance before adapter or provider work', async t => {
  const f = fixture(t); await f.admit(); await f.workflow(POSITIVE, 'begin'); f.advance(590_001);
  const result = await f.acceptance(POSITIVE);
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'LIVE_VALIDATION_ACCEPTANCE_DEADLINE_EXCEEDED');
  assert.equal(f.counts().adapterExecutes, 0); assert.equal(f.counts().providerCalls, 0);
});

test('a real broker provider failure remains terminal and its private diagnostics never enter the runtime response', async t => {
  const f = fixture(t, { invokeProvider: async value => {
    if (value.method === 'GET') return { status: 200, body: { id: MODEL, object: 'model' } };
    throw new Error(PRIVATE_PROVIDER + CREDENTIAL);
  } });
  await f.admit(); await f.workflow(POSITIVE, 'begin');
  const result = await f.acceptance(POSITIVE);
  assert.equal(result.status, 403); assert.notEqual(result.body.profilePassed, true);
  assert.match(result.body.error.code, /^LIVE_VALIDATION_[A-Z_]+$/u);
  for (const forbidden of [PRIVATE_PROVIDER, PRIVATE_PROMPT, CREDENTIAL, f.session().brokerBearer]) {
    assert.equal(result.text.includes(forbidden), false);
  }
  assert.equal(f.counts().providerCalls, 2);
});

test('a rejected concurrent request cannot release another acceptance execution lock', async t => {
  let release; let started;
  const begun = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { execute: async () => { started(); await blocked; return { accepted: false }; } });
  await f.admit(); const first = f.acceptance(POSITIVE); await begun;
  let second;
  try {
    assert.equal((await f.acceptance(NEGATIVE, { input: { invalid: true } })).status, 403);
    second = f.acceptance(NEGATIVE);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counts().adapterExecutes, 1);
    assert.equal((await second).status, 403);
  } finally { release(); await Promise.allSettled([first, second]); }
});

for (const outcome of ['resolve', 'reject']) {
  test(`request timeout keeps the lock through late adapter ${outcome} and preserves the next case state`, async t => {
    let releaseFirst; let beginFirst; let releaseSecond; let beginSecond;
    const firstExecution = new Promise(resolve => { releaseFirst = resolve; });
    const firstBegun = new Promise(resolve => { beginFirst = resolve; });
    const secondExecution = new Promise(resolve => { releaseSecond = resolve; });
    const secondBegun = new Promise(resolve => { beginSecond = resolve; });
    let firstSignal; let secondSignal; let requests = 0;
    const events = [];
    const f = fixture(t, {
      runRequest: (options, work) => runWithRequestAbortTimeout({ ...options,
        timeoutMs: ++requests === 1 ? 25 : options.timeoutMs }, work),
      execute: async ({ input, observer, context }) => {
        if (input.query.idempotencyKey === profiles.profiles.find(value => value.id === POSITIVE).input.query.idempotencyKey) {
          firstSignal = getRequestAbortSignal(); events.push('first_started'); beginFirst();
          await firstExecution;
          observer.onSourceAcquisition('passed'); observer.onSourceValidation('passed'); observer.onAnswerAuditStart();
          events.push('first_' + outcome);
          if (outcome === 'reject') throw new Error('private-late-rejection-do-not-project');
          return { accepted: true, audit: { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true },
            result: { ok: true, data: { response: PRIVATE_ANSWER } } };
        }
        secondSignal = getRequestAbortSignal(); events.push('second_started');
        assert.equal(context.observation().stage, 'generation');
        beginSecond(); await secondExecution;
        // Fall through to the ordinary zero-provider negative fixture after this request-owned pause.
        return undefined;
      }
    });
    await f.admit(); const first = f.acceptance(POSITIVE); await firstBegun;
    let blocked; let second;
    try {
      const timedOut = await first;
      assert.equal(timedOut.status, 403); assert.equal(firstSignal.aborted, true);
      const originalResponse = timedOut.text;
      assert.equal(f.counts().adapterExecutes, 1); assert.deepEqual(events, ['first_started']);
      blocked = f.acceptance(NEGATIVE);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.counts().adapterExecutes, 1);
      assert.equal((await blocked).status, 403);
      assert.deepEqual(events, ['first_started']);

      releaseFirst(); await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, ['first_started', 'first_' + outcome]);
      second = f.acceptance(NEGATIVE);
      const started = await Promise.race([secondBegun.then(() => true), second.then(() => false)]);
      assert.equal(started, true); assert.equal(secondSignal.aborted, false);
      assert.deepEqual(events, ['first_started', 'first_' + outcome, 'second_started']);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.context().observation().stage, 'generation');
      assert.equal(f.counts().adapterExecutes, 2); assert.equal(f.counts().providerCalls, 0);
      assert.equal(timedOut.text, originalResponse);

      releaseSecond(); const next = await second;
      assert.equal(next.status, 200); assert.equal(next.body.caseId, NEGATIVE);
      assert.equal(next.body.profilePassed, true); assert.equal(next.body.observation.outcome, 'need_new_source');
      assert.equal(next.body.evidence.stages.generation, 'not_run'); assert.equal(next.body.evidence.stages.answer_audit, 'not_run');
      assert.deepEqual(next.body.providerDelta, { providerCalls: 0, generationCalls: 0, auditCalls: 0 });
      assert.equal(next.text.includes(PRIVATE_ANSWER), false); assert.equal(next.text.includes('private-late-rejection'), false);
      assert.equal((await f.acceptance(POSITIVE)).status, 403);
    } finally {
      releaseFirst(); releaseSecond(); await Promise.allSettled([first, blocked, second]);
    }
  });
}
