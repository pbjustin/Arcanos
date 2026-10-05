import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveValidationBroker } from './live-validation-broker.mjs';
import { createLiveValidationBudget } from './live-validation-budget.mjs';
import { liveValidationTargetSha256, signLiveValidationPlan, validateLiveValidationPlan } from './live-validation-policy.mjs';
import { LIVE_VALIDATION_PROJECT_ID } from './live-validation-target.mjs';

const keys = generateKeyPairSync('ed25519');
const id = suffix => '10000000-0000-4000-8000-' + suffix.toString().padStart(12, '0');
const MODEL = 'ft:gpt-6-luna:arcanos:gaming:offline';
const options = { moduleId: 'gaming', stage: 'generation', sourceCommit: 'a'.repeat(40), deploymentId: id(4) };
const payload = { model: MODEL, input: 'synthetic private prompt', max_output_tokens: 100 };
const positive = 'gaming-guide-positive'; const negative = 'gaming-guide-negative';

function fixture(t, overrides = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'arcanos-persistent-broker-offline-'));
  const repositoryRoot = path.join(temporary, 'checkout'); const directory = path.join(temporary, 'ledger');
  mkdirSync(repositoryRoot, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  let current = 1_000_000; const now = () => current;
  const target = { version: 'arcanos-live-validation-target/v1', repository: 'pbjustin/Arcanos',
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId: id(1), environmentName: 'live-validation',
    runtimeServiceId: id(2), supervisorServiceId: id(3), privateOrigins: {
      runtime: 'https://runtime.railway.internal:8443', supervisor: 'https://supervisor.railway.internal:8443' },
    mtlsPeers: { runtime: { dns: 'runtime.railway.internal', sha256: '1'.repeat(64) },
      supervisor: { dns: 'supervisor.railway.internal', sha256: '2'.repeat(64) },
      verifier: { dns: 'verifier.railway.internal', sha256: '3'.repeat(64) } },
    trustedSupervisorSha: 'b'.repeat(40), limits: { maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2,
      durationMs: 600_000, ...overrides.limits },
    models: [MODEL, 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: overrides.rate ?? 1, outputMicroUsdPerToken: 2 })), writes: false };
  const plan = { version: 'arcanos-live-validation-run/v1', runId: 'a'.repeat(32), repository: target.repository, prNumber: 1527,
    commitSha: options.sourceCommit, profile: 'gaming-guide', profileHash: '4'.repeat(64), artifactAttestationSha256: '5'.repeat(64),
    issuedAtMs: current, expiresAtMs: current + target.limits.durationMs, projectId: target.projectId, environmentId: target.environmentId,
    runtimeServiceId: target.runtimeServiceId, runtimeDeploymentId: options.deploymentId, supervisorServiceId: target.supervisorServiceId,
    supervisorDeploymentId: id(5), trustedSupervisorSha: target.trustedSupervisorSha, targetHash: liveValidationTargetSha256(target),
    paidAuthorized: true, offlineGateHash: '6'.repeat(64), runtimeBuildManifestSha256: '7'.repeat(64), supervisorBuildManifestSha256: '8'.repeat(64) };
  const observed = role => ({ sourceCommit: role === 'runtime' ? plan.commitSha : plan.trustedSupervisorSha,
    projectId: plan.projectId, environmentId: plan.environmentId, serviceId: plan[role + 'ServiceId'],
    deploymentId: plan[role + 'DeploymentId'], buildManifestSha256: plan[role + 'BuildManifestSha256'] });
  const admission = validateLiveValidationPlan({ signedPlan: signLiveValidationPlan(plan, keys.privateKey), target,
    trustedPublicKey: keys.publicKey, trustedProfileHash: plan.profileHash, runtimeIdentity: observed('runtime'),
    supervisorIdentity: observed('supervisor'), nowMs: current });
  const budgetOptions = { directory, repositoryRoot, now };
  const budget = createLiveValidationBudget(budgetOptions);
  let providerCalls = 0; let credentialReads = 0; const seen = [];
  const dependencies = { admission, budget, now,
    resolveCredential: async () => { credentialReads++; return overrides.credential ?? ('sk-' + 'a'.repeat(40)); },
    invokeProvider: async request => {
      providerCalls++; seen.push(request);
      if (overrides.invokeProvider) return overrides.invokeProvider(request);
      return request.method === 'GET' ? { status: 200, body: { id: decodeURIComponent(request.url.split('/').at(-1)), object: 'model' } }
        : { status: 200, body: { model: request.body.model, output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } };
    }, ...(overrides.responseModelIdentity ? { responseModelIdentity: overrides.responseModelIdentity } : {}) };
  const broker = createLiveValidationBroker(dependencies);
  t.after(() => { try { broker.close(); } catch {} rmSync(temporary, { recursive: true, force: true }); });
  return { broker, budget, admission, directory, budgetOptions, dependencies, seen, now,
    counts: () => ({ providerCalls, credentialReads }), advance: amount => { current += amount; },
    persisted: () => JSON.parse(readFileSync(path.join(directory, plan.runId + '.json'), 'utf8')),
    invoke: (session, stage = 'generation', body = payload, extra = {}) => broker.invoke(body, session.brokerBearer, { ...options, stage, ...extra }),
    metadata: (session, model = MODEL, extra = {}) => broker.retrieveModel(model, session.brokerBearer, { ...options, ...extra }) };
}

test('durable replay registration precedes credential access and never writes session bearers or prompts', async t => {
  const f = fixture(t);
  const broker = createLiveValidationBroker({ ...f.dependencies, resolveCredential: async () => {
    assert.equal(existsSync(path.join(f.directory, f.admission.plan.runId + '.claim')), true);
    assert.equal(f.persisted().status, 'active'); return ('sk-' + 'a'.repeat(40));
  } });
  const session = await broker.authorizeRun();
  assert.equal(session.runId, f.admission.plan.runId);
  assert.notEqual(session.brokerBearer, session.testBearer);
  assert.equal(f.persisted().usage.requests, 0);
  const disk = readFileSync(path.join(f.directory, session.runId + '.json'), 'utf8');
  for (const secret of [session.brokerBearer, session.testBearer, ('sk-' + 'a'.repeat(40)), payload.input]) assert.equal(disk.includes(secret), false);
  await assert.rejects(broker.authorizeRun(), { code: 'LIVE_VALIDATION_RUN_REPLAY' });
  const restarted = createLiveValidationBroker({ ...f.dependencies, budget: createLiveValidationBudget(f.budgetOptions) });
  await assert.rejects(restarted.authorizeRun(), { code: 'LIVE_VALIDATION_BUDGET_REPLAY' });
  assert.equal(f.counts().credentialReads, 0);
  broker.close();
});

test('invalid credential fails after durable claim and cannot be retried with the same authorization', async t => {
  const f = fixture(t, { credential: 'sk-placeholder-invalid' });
  await assert.rejects(f.broker.authorizeRun(), { code: 'LIVE_VALIDATION_CREDENTIAL_INVALID' });
  assert.equal(f.persisted().status, 'stopped'); assert.equal(f.counts().providerCalls, 0);
  await assert.rejects(f.broker.authorizeRun(), { code: 'LIVE_VALIDATION_RUN_REPLAY' });
});

test('positive real-budget lifecycle records generation and mandatory audit before the zero-provider negative case', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun();
  f.broker.beginWorkflow(positive); await f.invoke(session); await f.invoke(session, 'answer_audit');
  assert.deepEqual(f.broker.endWorkflow(), { caseId: positive, generationCalls: 1, auditCalls: 1 });
  f.broker.beginWorkflow(negative);
  assert.deepEqual(f.broker.endWorkflow(), { caseId: negative, generationCalls: 0, auditCalls: 0 });
  const evidence = f.broker.evidence();
  assert.equal(evidence.usage.providerCalls, 2); assert.equal(evidence.usage.generationCalls, 1); assert.equal(evidence.usage.auditCalls, 1);
  assert.equal(evidence.counts.workflows, 2); assert.equal(evidence.counts.pendingRequests, 0);
  assert.equal(evidence.limits.maxRetries, 0); assert.equal(evidence.limits.maxConcurrency, 1);
  assert.equal(evidence.stages.length, 2);
  const text = JSON.stringify(evidence);
  for (const secret of [session.brokerBearer, session.testBearer, ('sk-' + 'a'.repeat(40)), payload.input]) assert.equal(text.includes(secret), false);
  assert.equal(Object.hasOwn(evidence, 'accepted'), false);
});

test('bearer, module, source SHA and deployment checks reject before provider reservations', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  await assert.rejects(f.broker.invoke(payload, 'wrong-token', options), { code: 'LIVE_VALIDATION_IDENTITY_UNAUTHORIZED' });
  for (const extra of [{ moduleId: 'research' }, { sourceCommit: 'b'.repeat(40) }, { deploymentId: id(99) }]) {
    await assert.rejects(f.invoke(session, 'generation', payload, extra), { code: 'LIVE_VALIDATION_DEPLOYMENT_MISMATCH' });
    await assert.rejects(f.metadata(session, MODEL, extra), { code: 'LIVE_VALIDATION_DEPLOYMENT_MISMATCH' });
  }
  assert.equal(f.persisted().usage.requests, 0); assert.equal(f.counts().providerCalls, 0);
});

test('provider generation is impossible without a positive workflow or with an invalid stage', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun();
  await assert.rejects(f.invoke(session), { code: 'LIVE_VALIDATION_WORKFLOW_REQUIRED' });
  f.broker.beginWorkflow(positive);
  await assert.rejects(f.invoke(session, 'model_generation'), { code: 'LIVE_VALIDATION_STAGE_INVALID' });
  await assert.rejects(f.invoke(session, 'answer_audit'), { code: 'LIVE_VALIDATION_AUDIT_ORDER_INVALID' });
  assert.equal(f.persisted().usage.requests, 0); assert.equal(f.counts().providerCalls, 0);
});

test('negative workflow cannot send generation, audit or metadata and closes before any charge', async t => {
  for (const type of ['generation', 'answer_audit', 'metadata']) {
    await t.test(type, async child => {
      const f = fixture(child); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(negative);
      await assert.rejects(type === 'metadata' ? f.metadata(session) : f.invoke(session, type),
        { code: 'LIVE_VALIDATION_NEGATIVE_PROVIDER_FORBIDDEN' });
      assert.equal(f.persisted().usage.requests, 0); assert.equal(f.counts().providerCalls, 0);
      assert.equal(f.persisted().status, 'stopped');
    });
  }
});

test('ending a positive workflow without a completed audit terminates admission', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive); await f.invoke(session);
  assert.throws(() => f.broker.endWorkflow(), { code: 'LIVE_VALIDATION_AUDIT_REQUIRED' });
  await assert.rejects(f.invoke(session, 'answer_audit'), { code: 'LIVE_VALIDATION_RUN_CLOSED' });
  assert.equal(f.persisted().usage.requests, 1); assert.equal(f.persisted().status, 'stopped');
});

test('an audit permanently forbids automatic generation repair or retry before another provider charge', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  await f.invoke(session); await f.invoke(session, 'answer_audit');
  await assert.rejects(f.invoke(session), { code: 'LIVE_VALIDATION_REGENERATION_FORBIDDEN' });
  assert.equal(f.persisted().status, 'stopped'); assert.equal(f.persisted().usage.requests, 2);
  assert.equal(f.counts().providerCalls, 2);
});

test('workflows are exact, exclusive, permanently claimed and respect tighter target workflow cap', async t => {
  const f = fixture(t, { limits: { maxWorkflows: 1 } }); const session = await f.broker.authorizeRun();
  assert.throws(() => f.broker.beginWorkflow('other'), { code: 'LIVE_VALIDATION_CASE_FORBIDDEN' });
  f.broker.beginWorkflow(positive);
  assert.throws(() => f.broker.beginWorkflow(negative), { code: 'LIVE_VALIDATION_CONCURRENCY_LIMIT' });
  await f.invoke(session); await f.invoke(session, 'answer_audit'); f.broker.endWorkflow();
  assert.throws(() => f.broker.beginWorkflow(negative), { code: 'LIVE_VALIDATION_WORKFLOW_LIMIT' });
  assert.equal(f.persisted().workflows.length, 1);
});

test('fixed payload and token policy excludes alternate endpoints, tools, remote media, streaming and unapproved models', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  for (const body of [{ ...payload, endpoint: 'https://other.invalid' }, { ...payload, tools: [] }, { ...payload, stream: true },
    { ...payload, store: true }, { ...payload, model: 'other-model' }, { ...payload, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://other.invalid' }] }] }]) {
    await assert.rejects(f.invoke(session, 'generation', body), { code: 'LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN' });
  }
  await assert.rejects(f.invoke(session, 'generation', { ...payload, max_output_tokens: 4_097 }), { code: 'LIVE_VALIDATION_REQUEST_INVALID' });
  await assert.rejects(f.invoke(session, 'generation', { ...payload, input: 'x'.repeat(128_000) }), { code: 'LIVE_VALIDATION_INPUT_LIMIT' });
  assert.equal(f.persisted().usage.requests, 0); assert.equal(f.counts().providerCalls, 0);
});

test('full token and spend reservation is on disk before a provider request and never refunded', async t => {
  let f;
  f = fixture(t, { invokeProvider: async request => {
    const state = f.persisted(); assert.equal(state.reservations.length, 1); assert.equal(state.reservations[0].status, 'pending');
    assert.ok(state.usage.reservedSpendMicroUsd > 0); assert.equal(state.usage.requests, 1);
    assert.equal(request.body.store, false); assert.equal(request.body.stream, false); assert.equal(request.body.service_tier, 'default');
    assert.equal(Object.hasOwn(request.body, 'metadata'), false);
    return { status: 200, body: { model: request.body.model, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } };
  } });
  const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  await f.invoke(session, 'generation', { ...payload, metadata: { harmless: 'discarded' } });
  const usage = f.persisted().usage;
  assert.ok(usage.reservedSpendMicroUsd > usage.observedSpendMicroUsd); assert.ok(usage.reservedTotalTokens > usage.observedTotalTokens);
});

test('metadata uses approved encoded model IDs, counts the aggregate request cap and returns only metadata identity', async t => {
  const f = fixture(t, { limits: { maxRequests: 1 } }); const session = await f.broker.authorizeRun();
  assert.deepEqual(await f.metadata(session), { id: MODEL, object: 'model' });
  assert.equal(f.seen[0].url, 'https://api.openai.com/v1/models/' + encodeURIComponent(MODEL));
  assert.equal(f.persisted().usage.metadataRequests, 1); assert.equal(f.persisted().usage.reservedSpendMicroUsd, 0);
  await assert.rejects(f.metadata(session), { code: 'LIVE_VALIDATION_BUDGET_EXHAUSTED' });
  assert.equal(f.counts().providerCalls, 1); assert.equal(f.persisted().status, 'stopped');
});

test('conservative spend cap blocks a call before any provider request', async t => {
  const f = fixture(t, { rate: 100_000 }); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  await assert.rejects(f.invoke(session), { code: 'LIVE_VALIDATION_BUDGET_EXHAUSTED' });
  assert.equal(f.counts().providerCalls, 0); assert.equal(f.persisted().usage.requests, 0);
  assert.equal(f.persisted().stopReason, 'budget_exhausted');
});

test('provider failures and malformed usage close the run without refunds or retries', async t => {
  for (const body of [null, { model: 'wrong', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } },
    { model: MODEL, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 20 } },
    { model: MODEL, usage: { input_tokens: 10, output_tokens: 101, total_tokens: 111 } }]) {
    await t.test(body ? 'malformed-response' : 'failed-response', async child => {
      const f = fixture(child, { invokeProvider: async () => ({ status: body ? 200 : 500, body }) });
      const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
      await assert.rejects(f.invoke(session));
      assert.equal(f.counts().providerCalls, 1); assert.equal(f.persisted().usage.requests, 1);
      assert.ok(f.persisted().usage.reservedSpendMicroUsd > 0); assert.equal(f.persisted().status, 'stopped');
      assert.equal(f.persisted().reservations[0].status, 'failed');
      await assert.rejects(f.invoke(session), { code: 'LIVE_VALIDATION_RUN_CLOSED' });
      assert.equal(f.counts().providerCalls, 1);
    });
  }
});

test('trusted response identity permits helper snapshots but fine-tune identity remains exact by default', async t => {
  const f = fixture(t, { invokeProvider: async () => ({ status: 200, body: { model: 'gpt-6-luna-2026-10-01',
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }), responseModelIdentity: (response, expected) => {
    assert.equal(expected, 'gpt-6-luna'); return response.model;
  } });
  const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  const response = await f.invoke(session, 'generation', { ...payload, model: 'gpt-6-luna' });
  assert.equal(response.model, 'gpt-6-luna-2026-10-01');
  assert.equal(f.broker.evidence().stages[0].actualModel, response.model);
});

test('concurrent requests cannot obtain another reservation or finish the workflow', async t => {
  let finish;
  const f = fixture(t, { invokeProvider: request => new Promise(resolve => { finish = () => resolve({ status: 200,
    body: { model: request.body.model, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }); }) });
  const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  const pending = f.invoke(session); await Promise.resolve();
  await assert.rejects(f.metadata(session), { code: 'LIVE_VALIDATION_CONCURRENCY_LIMIT' });
  assert.throws(() => f.broker.endWorkflow(), { code: 'LIVE_VALIDATION_WORKFLOW_INVALID' });
  assert.equal(f.persisted().usage.requests, 1); finish(); await pending;
});

test('timeouts and explicit close cancel an uncooperative provider with one durable unrefunded charge', async t => {
  for (const action of ['timeout', 'close']) {
    await t.test(action, async child => {
      const f = fixture(child, { invokeProvider: () => new Promise(() => {}) });
      const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
      const pending = f.invoke(session, 'generation', payload, { timeoutMs: 20 });
      if (action === 'close') f.broker.close();
      await assert.rejects(pending, { code: action === 'timeout' ? 'LIVE_VALIDATION_PROVIDER_TIMEOUT' : 'LIVE_VALIDATION_CANCELLED' });
      assert.equal(f.persisted().usage.requests, 1); assert.ok(f.persisted().usage.reservedSpendMicroUsd > 0);
      assert.equal(f.persisted().status, 'stopped'); assert.equal(f.persisted().reservations[0].status === 'pending', false);
      assert.ok(f.counts().providerCalls <= 1);
    });
  }
});

test('default request timeout clamps to remaining approval and invalid headers do not charge', async t => {
  const f = fixture(t, { limits: { durationMs: 20 }, invokeProvider: () => new Promise(() => {}) });
  const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  for (const timeoutMs of [0, -1, 0.5, 120_001]) {
    await assert.rejects(f.invoke(session, 'generation', payload, { timeoutMs }), { code: 'LIVE_VALIDATION_DURATION_LIMIT' });
  }
  assert.equal(f.persisted().usage.requests, 0);
  await assert.rejects(f.invoke(session), error => ['LIVE_VALIDATION_PROVIDER_TIMEOUT', 'LIVE_VALIDATION_PLAN_EXPIRED'].includes(error.code));
  assert.equal(f.persisted().usage.requests, 1);
});

test('expired approval and restart with a pending call cannot mint a fresh budget or retry', async t => {
  const f = fixture(t); const session = await f.broker.authorizeRun(); f.broker.beginWorkflow(positive);
  f.advance(600_000);
  await assert.rejects(f.invoke(session), { code: 'LIVE_VALIDATION_PLAN_EXPIRED' });
  assert.equal(f.persisted().status, 'stopped'); assert.equal(f.counts().providerCalls, 0);
  assert.equal(f.persisted().usage.requests, 0);
});

test('ledger reservation failure stops before provider execution', async t => {
  const f = fixture(t); const brokenBudget = { ...f.budget, reserve() { throw new Error('synthetic write failure'); } };
  const broker = createLiveValidationBroker({ ...f.dependencies, budget: brokenBudget }); const session = await broker.authorizeRun();
  broker.beginWorkflow(positive);
  await assert.rejects(broker.invoke(payload, session.brokerBearer, options), { code: 'LIVE_VALIDATION_PROVIDER_FAILED' });
  assert.equal(f.counts().providerCalls, 0); assert.equal(f.persisted().status, 'stopped');
});
