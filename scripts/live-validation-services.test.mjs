import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import OpenAI from 'openai';
import { getRequestRemainingMs, runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createValidationRuntimeApplication, resolveLiveValidationModels,
  LIVE_VALIDATION_ACCEPTANCE_WORK_TIMEOUT_MS } from './start-live-validation-runtime.mjs';
import { createLiveValidationProvider } from './live-validation-provider.mjs';
import { validationHash } from './live-validation-bootstrap.mjs';
import { sanitizeLiveValidationUsage } from './live-validation-controller.mjs';
import { LIVE_VALIDATION_PROJECT_ID } from './live-validation-target.mjs';

const profiles = JSON.parse(readFileSync(new URL('../examples/live-validation/profiles.json', import.meta.url), 'utf8'));
const id = suffix => '10000000-0000-4000-8000-' + String(suffix).padStart(12, '0');
const MODEL = 'ft:gpt-6-luna:arcanos:gaming:offline';
const PRIVATE_PROMPT = 'private-prompt-do-not-project';
const PRIVATE_PROVIDER = 'private-provider-body-do-not-project';
const PRIVATE_ANSWER = 'private-module-answer-do-not-project [1]';
const CREDENTIAL = 'sk-unit-test-fixture-' + 'x'.repeat(40);
const TOKEN = 'arcanos-live-validation-test-' + 'f'.repeat(64);
const POSITIVE = 'gaming-guide-positive'; const NEGATIVE = 'gaming-guide-negative';

async function request(application, method, url, body, headers = {}, rawHeaders) {
  let status; let text = '';
  const response = { writeHead(value) { status = value; }, end(value = '') { text += value; } };
  const native = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(native, { method, url, rawHeaders, headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
  await application.handler(native, response);
  return { status, body: JSON.parse(text), text };
}

function fixture(t, overrides = {}) {
  let clock = Date.now(); const now = () => clock; const testToken = overrides.testToken ?? TOKEN;
  const target = { version: 'arcanos-live-validation-target/v2', repository: 'pbjustin/Arcanos',
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId: id(1), environmentName: 'live-validation',
    runtimeServiceId: id(2), publicOrigin: 'https://arcanos-v2-validation.up.railway.app', limits: {
      maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 },
    models: [MODEL, 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 })), writes: false };
  const identity = { role: 'runtime', sourceCommit: 'a'.repeat(40), projectId: target.projectId,
    environmentId: target.environmentId, serviceId: target.runtimeServiceId, deploymentId: id(4), buildManifestSha256: '7'.repeat(64) };
  const buildManifest = { version: 1, repository: target.repository, sourceCommit: identity.sourceCommit, role: 'runtime',
    treeSha: 'c'.repeat(40), compiledSha256: 'd'.repeat(64) };
  identity.buildManifestSha256 = validationHash(buildManifest);
  const plan = { runId: 'a'.repeat(32), prNumber: 1528, commitSha: identity.sourceCommit,
    runtimeDeploymentId: identity.deploymentId, profileHash: validationHash(profiles), expiresAtMs: clock + 600_000,
    paidAuthorized: true };
  let providerCalls = 0; let providerCreates = 0; let adapterCreates = 0; let adapterExecutes = 0;
  const seen = []; let context; let lastObservation;
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
        lastObservation = { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: 'need_new_source', semanticGap: 'CONFLICT',
          reason: 'GAME_MISMATCH', coverage: { satisfied: false, assessmentStatus: 'assessed', missingCount: 1 },
          selectedCandidateCount: 0, selectedEvidenceCount: 0, qualification: { visible: false, patchCompatibility: 'unverified', claimsVerifiedCurrentness: false },
          audit: null, auditStartBudget: { runtimeRemainingMs: null, requestRemainingMs: null },
          candidates: [{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }], stages: {
            ...Object.fromEntries(['acquisition', 'selection', 'intake', 'reasoning', 'final', 'response'].map(stage => [stage,
              { status: stage === 'acquisition' ? 'passed' : 'not_run', elapsedMs: stage === 'acquisition' ? 1 : null }])),
            generation: { status: 'not_run', elapsedMs: null }, answer_audit: { status: 'not_run', elapsedMs: null } } };
        return { accepted: false, failureCode: 'INCOMPATIBLE_SOURCE' };
      }
      observer.onSourceValidation('passed');
      const client = new OpenAI({ apiKey: 'validation-provider-placeholder', maxRetries: 0,
        fetch: context.provider.fetch });
      await client.models.retrieve(MODEL);
      await client.responses.create({ model: MODEL, input: PRIVATE_PROMPT, max_output_tokens: 100 });
      observer.onAnswerAuditStart();
      await client.responses.create({ model: 'gpt-6-luna', input: PRIVATE_PROMPT, max_output_tokens: 100 });
      lastObservation = { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: 'accepted', semanticGap: 'NONCRITICAL_GAP', reason: null,
        coverage: { satisfied: true, assessmentStatus: 'assessed', missingCount: 0 }, selectedCandidateCount: 1,
        audit: { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: !overrides.unbound },
        auditStartBudget: { runtimeRemainingMs: 120_000, requestRemainingMs: 120_000 },
        selectedEvidenceCount: 1, qualification: { visible: true, patchCompatibility: 'unverified', claimsVerifiedCurrentness: false }, candidates: [], stages: {
          ...Object.fromEntries(['acquisition', 'selection', 'intake', 'reasoning', 'final', 'response'].map(stage => [stage, { status: 'passed', elapsedMs: 1 }])),
          generation: { status: 'passed', elapsedMs: 1 }, answer_audit: { status: 'passed', elapsedMs: 1 } } };
      return { accepted: true, audit: { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: !overrides.unbound },
        result: { ok: true, data: { response: PRIVATE_ANSWER,
          sources: [{ url: input.candidateUrls[0], snippet: 'private-source-passage' }],
          grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true, fetchedSuppliedSourceCount: 1,
            usableSourceCount: 1, citableSourceCount: 1, selectedChunkCount: 1, suppliedEvidenceSourceCount: 1 } } } };
    }, getLastObservation: () => lastObservation ? structuredClone(lastObservation) : undefined
  };
  const runtime = createValidationRuntimeApplication({ target, identity, profiles, buildManifest, now, testToken,
    apiKey: overrides.apiKey ?? CREDENTIAL, resolveResponseModelIdentity: async () => body => body.model,
    createProvider: value => {
      providerCreates++;
      return createLiveValidationProvider({ ...value, ...(overrides.providerTimeoutMs ? { getRemainingMs: () => overrides.providerTimeoutMs } : {}), fetchImplementation: async (url, init) => {
        providerCalls++; seen.push({ url, init });
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + CREDENTIAL);
        if (overrides.fetchImplementation) {
          const response = await overrides.fetchImplementation(url, init);
          if (response !== undefined) return response;
        }
        const body = init.method === 'POST' ? JSON.parse(init.body) : undefined;
        return new Response(JSON.stringify(init.method === 'GET' ? { id: MODEL, object: 'model' }
          : { id: 'offline-response', object: 'response', status: 'completed', model: body.model,
            output: [], output_text: PRIVATE_PROVIDER, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }),
        { headers: { 'content-type': 'application/json' } });
      } });
    },
    createAdapter: async value => { adapterCreates++; context = value;
      if (overrides.createAdapter) await overrides.createAdapter(); return adapter; },
    ...(overrides.runRequest ? { runRequest: overrides.runRequest } : {}), getRemainingMs: getRequestRemainingMs });
  t.after(() => runtime.close());
  const headers = () => ({ authorization: 'Bearer ' + testToken, 'x-arcanos-source-commit': identity.sourceCommit,
    'x-arcanos-deployment-id': identity.deploymentId });
  const profile = caseId => profiles.profiles.find(value => value.id === caseId);
  const ready = () => request(runtime, 'GET', '/ready', undefined, headers());
  async function admit() {
    assert.equal((await ready()).status, 200);
    const result = await request(runtime, 'POST', '/runs', plan, headers()); assert.equal(result.status, 200); return result;
  }
  const acceptance = (caseId, changes = {}) => request(runtime, 'POST', '/acceptance',
    { runId: plan.runId, caseId, input: profile(caseId).input, ...changes }, headers());
  return { runtime, target, plan, identity, buildManifest, now, headers, ready, admit, acceptance, profile, adapter,
    context: () => context, seen, advance: amount => { clock += amount; }, counts: () => ({ providerCalls, providerCreates, adapterCreates, adapterExecutes }) };
}

test('public health and authenticated exact-SHA readiness perform no provider calls or app imports', async t => {
  const f = fixture(t);
  assert.equal((await request(f.runtime, 'GET', '/healthz')).status, 200);
  assert.equal((await request(f.runtime, 'GET', '/ready')).status, 401);
  const ready = await f.ready(); assert.equal(ready.status, 200);
  assert.equal(ready.body.sourceCommit, f.identity.sourceCommit);
  assert.deepEqual(ready.body.buildManifest, f.buildManifest);
  assert.deepEqual(ready.body.readiness, { modelCredentialBound: true, providerCallsEnabled: false, durableWritesEnabled: false });
  assert.deepEqual(f.counts(), { providerCalls: 0, providerCreates: 0, adapterCreates: 0, adapterExecutes: 0 });
  assert.ok(!ready.text.includes(TOKEN) && !ready.text.includes(CREDENTIAL));
});

test('admission requires exact SHA/deployment, explicit paid authority, approved profiles and prior readiness', async t => {
  const f = fixture(t);
  assert.equal((await request(f.runtime, 'POST', '/runs', f.plan, f.headers())).status, 403);
  await f.ready();
  for (const changed of [{ paidAuthorized: false }, { profileHash: '0'.repeat(64) }, { commitSha: 'c'.repeat(40) },
    { runtimeDeploymentId: id(99) }, { expiresAtMs: 0 }, { expiresAtMs: Date.now() + 700_000 }]) {
    assert.equal((await request(f.runtime, 'POST', '/runs', { ...f.plan, ...changed }, f.headers())).status, 403);
  }
  assert.equal(f.counts().providerCreates, 0); assert.equal(f.counts().adapterCreates, 0);
  const wrong = { ...f.headers(), 'x-arcanos-source-commit': 'c'.repeat(40) };
  assert.equal((await request(f.runtime, 'POST', '/runs', f.plan, wrong)).status, 401);
});

test('missing key can expose exact readiness but never imports the Gaming graph or admits paid execution', async t => {
  const f = fixture(t, { apiKey: '' });
  assert.equal((await f.ready()).body.readiness.modelCredentialBound, false);
  const denied = await request(f.runtime, 'POST', '/runs', f.plan, f.headers());
  assert.equal(denied.body.error.code, 'LIVE_VALIDATION_OPENAI_KEY_REQUIRED');
  assert.deepEqual(f.counts(), { providerCalls: 0, providerCreates: 0, adapterCreates: 0, adapterExecutes: 0 });
});

test('duplicate authorization and changed SHA/deployment reject before reading or executing test bodies', async t => {
  const f = fixture(t);
  const duplicate = await request(f.runtime, 'GET', '/ready', undefined, f.headers(), ['Authorization', TOKEN, 'authorization', TOKEN]);
  assert.equal(duplicate.status, 401);
  await f.admit();
  for (const changed of [{ authorization: 'Bearer test-wrong' }, { 'x-arcanos-source-commit': 'b'.repeat(40) },
    { 'x-arcanos-deployment-id': id(9) }]) {
    assert.equal((await request(f.runtime, 'POST', '/acceptance', {}, { ...f.headers(), ...changed })).status, 401);
  }
  assert.equal(f.counts().adapterExecutes, 0); assert.equal(f.counts().providerCalls, 0);
});

test('positive and wrong-game negative profiles share one direct metered SDK lane without broker or durable writes', async t => {
  const f = fixture(t); await f.admit();
  const positive = await f.acceptance(POSITIVE); assert.equal(positive.status, 200);
  assert.equal(positive.body.profilePassed, true); assert.equal(positive.body.verification.status, 'PASS');
  assert.deepEqual(positive.body.providerDelta, { providerCalls: 2, generationCalls: 1, auditCalls: 1 });
  assert.equal(positive.body.observation.stages.response.status, 'passed');
  for (const secret of [PRIVATE_PROMPT, PRIVATE_PROVIDER, PRIVATE_ANSWER, CREDENTIAL, TOKEN, 'private-source-passage', '/private/path'])
    assert.ok(!positive.text.includes(secret));
  assert.equal(positive.body.durableWrites, 0); assert.equal(positive.body.playerPersistence, 0);
  assert.equal(positive.body.productionChanged, false);
  const negative = await f.acceptance(NEGATIVE); assert.equal(negative.status, 200);
  assert.equal(negative.body.profilePassed, true); assert.equal(negative.body.observation.semanticGap, 'CONFLICT');
  assert.deepEqual(negative.body.providerDelta, { providerCalls: 0, generationCalls: 0, auditCalls: 0 });
  assert.equal(f.counts().providerCalls, 3); // One real SDK model lookup, generation and mandatory audit.
  assert.ok(f.seen.every(value => value.url.startsWith('https://api.openai.com/v1/')));
  assert.equal((await f.acceptance(POSITIVE)).status, 403);
  assert.equal((await request(f.runtime, 'POST', '/runs', f.plan, f.headers())).status, 403);
});

test('changed input, unknown profiles and expired runs cannot consume a workflow', async t => {
  const f = fixture(t); await f.admit();
  assert.equal((await f.acceptance(POSITIVE, { input: { injected: true } })).status, 403);
  assert.equal((await f.acceptance(POSITIVE, { caseId: 'unreviewed' })).status, 403);
  f.advance(600_001); assert.equal((await f.acceptance(POSITIVE)).status, 403);
  assert.equal(f.counts().adapterExecutes, 0); assert.equal(f.counts().providerCalls, 0);
});

test('unbound mandatory audit cannot pass despite successful real SDK transports', async t => {
  const f = fixture(t, { unbound: true }); await f.admit();
  const result = await f.acceptance(POSITIVE); assert.equal(result.status, 200);
  assert.equal(result.body.profilePassed, false); assert.equal(result.body.verification.status, 'FAIL');
  assert.equal(result.body.evidence.stages.delivery, 'rejected');
});

test('overlap and replay are denied while an underlying execution is still active', async t => {
  let release; let entered; const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { execute: async () => { entered(); await wait; return { accepted: false }; } });
  await f.admit(); const first = f.acceptance(POSITIVE); await started;
  assert.equal((await f.acceptance(NEGATIVE)).status, 429);
  assert.equal(f.counts().adapterExecutes, 1); release(); await first;
  assert.equal((await f.acceptance(POSITIVE)).status, 403);
});

test('request timeout closes paid execution and remains serial until ignored cancellation drains', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { execute: async () => { await wait; return { accepted: false }; },
    runRequest: (options, work) => runWithRequestAbortTimeout({ ...options, timeoutMs: 20 }, work) });
  await f.admit(); const result = await f.acceptance(POSITIVE); assert.equal(result.status, 200);
  assert.equal(result.body.profilePassed, false);
  assert.equal((await f.acceptance(NEGATIVE)).status, 429);
  const usage = await request(f.runtime, 'GET', '/usage', undefined, f.headers()); assert.equal(usage.body.closed, true);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.acceptance(POSITIVE)).status, 403);
});

test('run expiry after adapter initialization consumes admission without permitting a new budget', async t => {
  let f; f = fixture(t, { createAdapter: () => f.advance(600_001) }); await f.ready();
  assert.equal((await request(f.runtime, 'POST', '/runs', f.plan, f.headers())).status, 403);
  assert.equal(f.counts().providerCreates, 1);
  assert.equal((await request(f.runtime, 'POST', '/runs', { ...f.plan, expiresAtMs: Date.now() + 600_000 }, f.headers())).status, 403);
  assert.equal(f.counts().providerCreates, 1);
});

test('operator stop and provider failure close the existing budget without resetting it', async t => {
  const f = fixture(t); await f.admit();
  assert.equal((await request(f.runtime, 'POST', '/stop', undefined, f.headers())).body.stopped, true);
  const usage = await request(f.runtime, 'GET', '/usage', undefined, f.headers()); assert.equal(usage.body.closed, true);
  assert.equal((await request(f.runtime, 'POST', '/runs', f.plan, f.headers())).status, 403);
  assert.equal(f.counts().providerCalls, 0);
});

test('model policy retains exact fine-tune authority and normal helper roles', () => {
  const constants = { MODEL_GPT_6_LUNA: 'gpt-6-luna', MODEL_GPT_6_1_SOL: 'gpt-6.1-sol' };
  const models = [MODEL, ...Object.values(constants)].map(id => ({ id }));
  assert.equal(resolveLiveValidationModels(models, constants), MODEL);
  assert.throws(() => resolveLiveValidationModels(models.slice(0, 2), constants), /LIVE_VALIDATION_MODELS_INVALID/u);
  assert.throws(() => resolveLiveValidationModels([...models, { id: MODEL + '-another' }], constants), /LIVE_VALIDATION_MODELS_INVALID/u);
  assert.equal(LIVE_VALIDATION_ACCEPTANCE_WORK_TIMEOUT_MS, 300_000);
});


for (const auditTimeout of [false, true]) test(`real direct guard distinguishes ${auditTimeout ? 'mandatory answer audit' : 'generation'} timeout without retry`, async t => {
  const f = fixture(t, { providerTimeoutMs: 20, fetchImplementation: async (_url, init) => {
    if (init.method === 'POST' && JSON.parse(init.body).model === (auditTimeout ? 'gpt-6-luna' : MODEL))
      return new Promise(() => {});
  } });
  await f.admit(); const result = await f.acceptance(POSITIVE);
  assert.equal(result.status, 200); assert.equal(result.body.profilePassed, false);
  assert.equal(result.body.evidence.failureCode, auditTimeout ? 'AUDIT_TIMEOUT' : 'MODEL_TIMEOUT');
  assert.equal(result.body.evidence.stages.generation, auditTimeout ? 'passed' : 'timed_out');
  assert.equal(result.body.evidence.stages.answer_audit, auditTimeout ? 'timed_out' : 'not_run');
  assert.equal(result.body.providerDelta.generationCalls, 1);
  assert.equal(result.body.providerDelta.auditCalls, auditTimeout ? 1 : 0);
  assert.equal(f.counts().providerCalls, auditTimeout ? 3 : 2);
  assert.equal((await request(f.runtime, 'GET', '/usage', undefined, f.headers())).body.closed, true);
});


test('the controller verifies actual runtime usage identity, metadata accounting, workflow counts and stopped state', async t => {
  const f = fixture(t); await f.admit();
  const read = async () => {
    const response = await request(f.runtime, 'GET', '/usage', undefined, f.headers());
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes(CREDENTIAL) && !response.text.includes(TOKEN));
    return { raw: response.body, sanitized: sanitizeLiveValidationUsage(response.body, { plan: f.plan, target: f.target }) };
  };
  const before = await read();
  assert.equal(before.sanitized.status, 'active'); assert.equal(before.sanitized.requests, 0);
  assert.equal(before.sanitized.metadataRequests, 0); assert.equal(before.sanitized.workflows, 0);
  assert.equal((await f.acceptance(POSITIVE)).body.profilePassed, true);
  const after = await read();
  assert.equal(after.sanitized.requests, 3); assert.equal(after.sanitized.metadataRequests, 1);
  assert.equal(after.sanitized.providerCalls, 2); assert.equal(after.sanitized.generationCalls, 1);
  assert.equal(after.sanitized.auditCalls, 1); assert.equal(after.sanitized.workflows, 1);
  assert.equal(after.sanitized.observedTotalTokens, 6); assert.equal(after.raw.counts.pendingRequests, 0);
  assert.equal((await f.acceptance(NEGATIVE)).body.profilePassed, true);
  assert.equal((await read()).sanitized.workflows, 2);
  await request(f.runtime, 'POST', '/stop', undefined, f.headers());
  const stopped = await read(); assert.equal(stopped.sanitized.status, 'stopped');
  assert.equal(stopped.sanitized.requests, 3); assert.equal(stopped.sanitized.reservedSpendMicroUsd, after.sanitized.reservedSpendMicroUsd);
  for (const changed of [{ commitSha: 'b'.repeat(40) }, { runtimeDeploymentId: id(9) }, { profileHash: '0'.repeat(64) }]) {
    assert.throws(() => sanitizeLiveValidationUsage({ ...stopped.raw, ...changed }, { plan: f.plan, target: f.target }),
      /LIVE_VALIDATION_USAGE_IDENTITY_MISMATCH/u);
  }
});
