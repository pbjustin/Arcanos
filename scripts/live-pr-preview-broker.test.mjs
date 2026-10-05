import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { signLivePreviewApproval, livePreviewAttestationSha256, validateLivePreviewAdmission,
  LIVE_PREVIEW_APPROVAL_VERSION } from './live-pr-preview-policy.mjs';
import { createLivePreviewBroker, LIVE_PREVIEW_PROVIDER_URL, LIVE_PREVIEW_MODEL_URL_PREFIX,
  estimateLivePreviewInputTokens } from './live-pr-preview-broker.mjs';

const nowMs = 1_000_000;
const keys = generateKeyPairSync('ed25519');
const credential = 'sk-proj-' + 'x'.repeat(32);
const body = { model: 'reviewed-model-2026-10-01', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Make a grounded guide.' }] }],
  instructions: 'Preserve grounding and require answer audit.', max_output_tokens: 100 };
function fixture({ limits = {}, clock = () => nowMs, provider, claim = async () => true, moduleIds = ['gaming'],
  modelIds = [body.model], responseModelIdentity } = {}) {
  const attestation = { repository: 'pbjustin/Arcanos', headRepository: 'pbjustin/Arcanos', prNumber: 17,
    commitSha: 'a'.repeat(40), projectId: '10000000-0000-4000-8000-000000000001',
    environmentId: '10000000-0000-4000-8000-000000000002', environmentName: 'live-pr-17',
    serviceId: '10000000-0000-4000-8000-000000000003', deploymentId: '10000000-0000-4000-8000-000000000004',
    production: false, isolated: true, dataIsolated: true, credentialIsolated: true, egressRestricted: true,
    controllerRevision: 'b'.repeat(40), backendOrigin: 'https://backend-preview.invalid', brokerOrigin: 'https://broker-preview.invalid' };
  const approval = { version: LIVE_PREVIEW_APPROVAL_VERSION, approvalId: 'approved-run-00000001', repository: 'pbjustin/Arcanos',
    prNumber: 17, commitSha: 'a'.repeat(40), issuedAtMs: nowMs - 1, expiresAtMs: nowMs + 60_000,
    attestationSha256: livePreviewAttestationSha256(attestation),
    deployment: Object.fromEntries(['projectId', 'environmentId', 'environmentName', 'serviceId', 'deploymentId'].map(key => [key, attestation[key]])),
    limits: { maxRequests: 4, maxInputTokensPerRequest: 10_000, maxOutputTokensPerRequest: 100,
      maxTotalTokens: 40_000, durationMs: 60_000, maxSpendMicroUsd: 100_000, ...limits },
    models: modelIds.map(id => ({ id, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 })), moduleIds };
  const admission = validateLivePreviewAdmission({ enabled: true, signedApproval: signLivePreviewApproval(approval, keys.privateKey),
    trustedApprovalPublicKey: keys.publicKey, attestation, trustedIsolation: { projectIds: [attestation.projectId],
      environmentIds: [attestation.environmentId] }, nowMs });
  const calls = { credentials: 0, providers: 0, claims: 0 };
  const options = { admission, now: clock, responseModelIdentity, claimRun: async id => { calls.claims += 1; return claim(id); },
    resolveCredential: async () => { calls.credentials += 1; return credential; },
    invokeProvider: async request => { calls.providers += 1; return provider ? provider(request)
      : { status: 200, body: { model: body.model, status: 'completed', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grounded guide.' }] }] } }; } };
  const rawBroker = createLivePreviewBroker(options);
  // Test convenience only: production broker always requires an explicit module.
  const broker = { ...rawBroker,
    invoke: (request, bearer, requestOptions) => rawBroker.invoke(request, bearer, { moduleId: 'gaming', ...requestOptions }),
    retrieveModel: (model, bearer, requestOptions) => rawBroker.retrieveModel(model, bearer, { moduleId: 'gaming', ...requestOptions }) };
  return { broker, rawBroker, admission, options, calls };
}
async function rejects(operation, code) { await assert.rejects(operation, error => error.code === code); }

test('no unapproved, forged or expired admission can obtain credentials or invoke a provider', async () => {
  const { options, admission, calls } = fixture();
  for (const fake of [undefined, {}, { ...admission }]) assert.throws(() => createLivePreviewBroker({ ...options, admission: fake }), /LIVE_PREVIEW_ADMISSION_UNTRUSTED/u);
  assert.throws(() => createLivePreviewBroker({ ...options, now: () => nowMs + 60_000 }), /LIVE_PREVIEW_APPROVAL_EXPIRED/u);
  assert.deepEqual(calls, { credentials: 0, providers: 0, claims: 0 });
});

test('credential lookup is lazy, after durable single-use claim, and requires explicit trusted adapters', async () => {
  const { broker, options, calls } = fixture();
  assert.equal(calls.credentials, 0);
  await rejects(() => createLivePreviewBroker({ admission: options.admission, now: () => nowMs }).authorizeRun(), 'LIVE_PREVIEW_TRUSTED_ADAPTERS_REQUIRED');
  const session = await broker.authorizeRun();
  assert.deepEqual(calls, { credentials: 1, providers: 0, claims: 1 });
  assert.notEqual(session.testBearer, session.brokerBearer);
  await rejects(() => broker.authorizeRun(), 'LIVE_PREVIEW_RUN_ALREADY_CLAIMED');
});

test('replayed approvals and failed replay stores cannot resolve live credentials', async () => {
  const replay = fixture({ claim: async () => false });
  await rejects(() => replay.broker.authorizeRun(), 'LIVE_PREVIEW_APPROVAL_REPLAYED');
  assert.equal(replay.calls.credentials, 0);
  const failed = fixture({ claim: async () => { throw new Error('private storage path'); } });
  await rejects(() => failed.broker.authorizeRun(), 'LIVE_PREVIEW_REPLAY_GUARD_FAILED');
  assert.equal(failed.calls.credentials, 0);
});

test('successful model and audit transports use fixed Responses URL, bounded reservation, and secret-free evidence', async () => {
  const { broker } = fixture({ provider: async request => {
    assert.equal(request.url, LIVE_PREVIEW_PROVIDER_URL);
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    assert.equal(request.body.store, false);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.service_tier, 'default');
    assert.equal(request.body.metadata, undefined);
    return { status: 200, body: { model: body.model, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } };
  } });
  const session = await broker.authorizeRun();
  await broker.invoke({ ...body, store: true, metadata: { user: 'isolated-test' } }, session.brokerBearer);
  await broker.invoke(body, session.brokerBearer, { stage: 'answer_audit' });
  const evidence = broker.evidence();
  assert.equal(evidence.usage.requests, 2);
  assert.equal(evidence.usage.observedInputTokens, 20);
  assert.equal(evidence.stages[1].stage, 'answer_audit');
  assert.equal(evidence.limits.maxConcurrency, 1);
  assert.equal(evidence.limits.maxRetries, 0);
  assert.deepEqual(evidence.moduleIds, ['gaming']);
  for (const secret of [credential, session.brokerBearer, session.testBearer, body.instructions]) assert.ok(!JSON.stringify(evidence).includes(secret));
});

test('unauthorized test identity, caller URL/tools, image content and unapproved model invoke no provider', async () => {
  const { broker, calls } = fixture(); const session = await broker.authorizeRun();
  for (const bearer of [undefined, 'wrong', session.testBearer, 'é'.repeat(64)]) await rejects(() => broker.invoke(body, bearer), 'LIVE_PREVIEW_IDENTITY_UNAUTHORIZED');
  for (const request of [{ ...body, url: 'https://other.invalid' }, { ...body, tools: [] },
    { ...body, service_tier: 'priority' }, { ...body, service_tier: 'flex' }, { ...body, background: true },
    { ...body, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://other.invalid/image' }] }] }]) {
    await rejects(() => broker.invoke(request, session.brokerBearer), 'LIVE_PREVIEW_REQUEST_INVALID');
  }
  await rejects(() => broker.invoke({ ...body, model: 'unapproved' }, session.brokerBearer), 'LIVE_PREVIEW_MODEL_UNAPPROVED');
  assert.equal(calls.providers, 0); assert.equal(broker.evidence().usage.requests, 0);
});

test('request, input/output token and spending exhaustion fail before provider invocation', async () => {
  for (const limits of [{ maxRequests: 1 }, { maxTotalTokens: estimateLivePreviewInputTokens(body) + 100 },
    { maxSpendMicroUsd: estimateLivePreviewInputTokens(body) + 200 }]) {
    const { broker, calls } = fixture({ limits }); const session = await broker.authorizeRun();
    await broker.invoke(body, session.brokerBearer);
    await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_BUDGET_EXHAUSTED');
    assert.equal(calls.providers, 1);
    assert.equal(broker.evidence().usage.rejectedBudgetRequests, 1);
    assert.deepEqual(broker.evidence().rejections, [{ moduleId: 'gaming', stage: 'model_generation', code: 'LIVE_PREVIEW_BUDGET_EXHAUSTED' }]);
    assert.ok(broker.evidence().budgetExhausted);
  }
  const { broker, calls } = fixture({ limits: { maxInputTokensPerRequest: 100 } }); const session = await broker.authorizeRun();
  await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_INPUT_LIMIT');
  await rejects(() => broker.invoke({ ...body, max_output_tokens: 101 }, session.brokerBearer), 'LIVE_PREVIEW_OUTPUT_LIMIT');
  assert.equal(calls.providers, 0);
});

test('expired approvals are rechecked after lazy credential resolution and at every request', async () => {
  let time = nowMs; const { broker, options, calls } = fixture({ clock: () => time });
  const session = await broker.authorizeRun(); time += 60_000;
  await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_APPROVAL_EXPIRED'); assert.equal(calls.providers, 0);
  time = nowMs;
  const stale = createLivePreviewBroker({ ...options, resolveCredential: async () => { time += 60_000; return credential; } });
  await rejects(() => stale.authorizeRun(), 'LIVE_PREVIEW_APPROVAL_EXPIRED');
});

test('concurrency is one and rejected overlap consumes no reservation', async () => {
  let release;
  const { broker, calls } = fixture({ provider: () => new Promise(resolve => { release = resolve; }) });
  const session = await broker.authorizeRun(); const first = broker.invoke(body, session.brokerBearer);
  await Promise.resolve();
  await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_CONCURRENCY_LIMIT');
  release({ status: 200, body: { model: body.model, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }); await first;
  assert.equal(calls.providers, 1); assert.equal(broker.evidence().usage.requests, 1);
});

test('model and audit timeouts abort, retain full uncertain reservations and close without retry', async () => {
  for (const stage of ['model_generation', 'answer_audit']) {
    let signal;
    const { broker, calls } = fixture({ provider: request => { signal = request.signal; return new Promise(() => {}); } });
    const session = await broker.authorizeRun();
    await rejects(() => broker.invoke(body, session.brokerBearer, { timeoutMs: 5, stage }), 'LIVE_PREVIEW_PROVIDER_TIMEOUT');
    assert.ok(signal.aborted); assert.equal(calls.providers, 1);
    const evidence = broker.evidence(); assert.ok(evidence.closed); assert.ok(evidence.usage.reservedTotalTokens > 100);
    assert.equal(evidence.stages[0].stage, stage);
    await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_RUN_CLOSED');
  }
});

test('HTTP 200 without precise valid bounded usage closes the run and never releases reservation', async () => {
  for (const usage of [undefined, { input_tokens: 1, output_tokens: 1, total_tokens: 99 },
    { input_tokens: 1, output_tokens: 101, total_tokens: 102 }, { input_tokens: 1_000_000, output_tokens: 1, total_tokens: 1_000_001 }]) {
    const { broker, calls } = fixture({ provider: async () => ({ status: 200, body: { model: body.model, usage } }) }); const session = await broker.authorizeRun();
    await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_USAGE_INVALID');
    assert.equal(calls.providers, 1); assert.ok(broker.evidence().usage.reservedSpendMicroUsd > 0); assert.ok(broker.evidence().closed);
  }
});

test('provider errors are sanitized and do not retry or leak credentials', async () => {
  const { broker, calls } = fixture({ provider: async () => { throw new Error(`secret ${credential}`); } }); const session = await broker.authorizeRun();
  await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_PROVIDER_FAILED');
  assert.equal(calls.providers, 1); assert.ok(!JSON.stringify(broker.evidence()).includes(credential));
});

test('real approved model metadata uses only fixed GET URL and shares total request cap', async () => {
  const { broker, calls } = fixture({ limits: { maxRequests: 1 }, provider: async request => {
    assert.equal(request.method, 'GET'); assert.equal(request.url, LIVE_PREVIEW_MODEL_URL_PREFIX + encodeURIComponent(body.model));
    assert.equal(request.body, undefined);
    return { status: 200, body: { id: body.model, object: 'model', owned_by: 'private-account-detail' } };
  } });
  const session = await broker.authorizeRun();
  assert.deepEqual(await broker.retrieveModel(body.model, session.brokerBearer), { id: body.model, object: 'model' });
  await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_BUDGET_EXHAUSTED');
  assert.equal(calls.providers, 1);
  const evidence = broker.evidence(); assert.equal(evidence.usage.requests, 1); assert.equal(evidence.usage.metadataRequests, 1);
  assert.equal(evidence.usage.providerCalls, 0); assert.equal(evidence.usage.reservedSpendMicroUsd, 0);
  assert.equal(evidence.stages[0].stage, 'provider_metadata');
  assert.ok(!JSON.stringify(evidence).includes('private-account-detail'));
});

test('unauthorized, unapproved and mismatched model metadata cannot become accepted validation', async () => {
  const { broker, calls } = fixture({ provider: async () => ({ status: 200, body: { id: 'wrong-model', object: 'model' } }) });
  const session = await broker.authorizeRun();
  await rejects(() => broker.retrieveModel(body.model, session.testBearer), 'LIVE_PREVIEW_IDENTITY_UNAUTHORIZED');
  await rejects(() => broker.retrieveModel('../other-model', session.brokerBearer), 'LIVE_PREVIEW_MODEL_UNAPPROVED');
  assert.equal(calls.providers, 0);
  await rejects(() => broker.retrieveModel(body.model, session.brokerBearer), 'LIVE_PREVIEW_MODEL_VALIDATION_FAILED');
  assert.ok(broker.evidence().closed);
});

test('model metadata timeout aborts and closes without retry', async () => {
  let signal;
  const { broker, calls } = fixture({ provider: request => { signal = request.signal; return new Promise(() => {}); } });
  const session = await broker.authorizeRun();
  await rejects(() => broker.retrieveModel(body.model, session.brokerBearer, { timeoutMs: 5 }), 'LIVE_PREVIEW_PROVIDER_TIMEOUT');
  assert.ok(signal.aborted); assert.equal(calls.providers, 1); assert.ok(broker.evidence().closed);
});

test('missing, malformed and placeholder provider credentials fail before any provider request', async () => {
  for (const value of [undefined, '', 'mock-api-key-' + 'x'.repeat(32), 'sk-test-' + 'x'.repeat(32),
    'sk-placeholder-' + 'x'.repeat(32), 'sk-proj-' + 'x'.repeat(32) + '\n']) {
    const { options, calls } = fixture();
    const broker = createLivePreviewBroker({ ...options, resolveCredential: async () => value });
    await rejects(() => broker.authorizeRun(), 'LIVE_PREVIEW_CREDENTIAL_INVALID');
    assert.equal(calls.providers, 0); assert.ok(broker.evidence().closed);
  }
});

test('a provider returning an unapproved model cannot count as a completed stage', async () => {
  const { broker } = fixture({ provider: async () => ({ status: 200, body: { model: 'unapproved-model',
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }) });
  const session = await broker.authorizeRun();
  await rejects(() => broker.invoke(body, session.brokerBearer), 'LIVE_PREVIEW_PROVIDER_MODEL_MISMATCH');
  assert.equal(broker.evidence().stages[0].outcome, 'failed');
});

test('every provider request and model validation requires explicit signed module scope', async () => {
  const { rawBroker: broker, calls } = fixture({ moduleIds: ['gaming', 'research'], provider: async request => request.method === 'GET'
    ? { status: 200, body: { id: body.model, object: 'model' } }
    : { status: 200, body: { model: body.model, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } } });
  const session = await broker.authorizeRun();
  for (const moduleId of [undefined, '', 'backstage', '../gaming', 'GAMING']) {
    await rejects(() => broker.invoke(body, session.brokerBearer, { moduleId }), 'LIVE_PREVIEW_MODULE_UNAPPROVED');
    await rejects(() => broker.retrieveModel(body.model, session.brokerBearer, { moduleId }), 'LIVE_PREVIEW_MODULE_UNAPPROVED');
  }
  assert.equal(calls.providers, 0); assert.equal(broker.evidence().usage.requests, 0);
  await broker.invoke(body, session.brokerBearer, { moduleId: 'research' });
  await broker.retrieveModel(body.model, session.brokerBearer, { moduleId: 'research' });
  assert.equal(calls.providers, 2);
  assert.deepEqual(broker.evidence().stages.map(outcome => outcome.moduleId), ['research', 'research']);
});

async function trustedModelIdentity() {
  const source = readFileSync(new URL('../src/shared/gpt/generativeModelPolicyCore.ts', import.meta.url), 'utf8');
  const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
  return (await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'))).assertGenerativeModelResponseIdentity;
}

test('helper snapshots require the injected existing trusted model identity policy and identify actual model', async () => {
  const model = 'gpt-6'; const actual = 'gpt-6-2026-10-01';
  const provider = async () => ({ status: 200, body: { model: actual, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } });
  const strict = fixture({ modelIds: [model], provider }); const strictSession = await strict.broker.authorizeRun();
  await rejects(() => strict.broker.invoke({ ...body, model }, strictSession.brokerBearer), 'LIVE_PREVIEW_PROVIDER_MODEL_MISMATCH');
  const trusted = fixture({ modelIds: [model], provider, responseModelIdentity: await trustedModelIdentity() });
  const session = await trusted.broker.authorizeRun(); await trusted.broker.invoke({ ...body, model }, session.brokerBearer);
  const outcome = trusted.broker.evidence().stages[0];
  assert.equal(outcome.model, model); assert.equal(outcome.actualModel, actual);
  assert.equal(outcome.outcome, 'completed');
  assert.equal(trusted.broker.evidence().usage.reservedSpendMicroUsd, estimateLivePreviewInputTokens({ ...body, model }) + 200);
});

test('trusted identity policy retains exact fine-tune identity and sanitizes mismatches', async () => {
  const model = 'ft:gpt-6:preview:authority';
  const validator = await trustedModelIdentity();
  for (const actual of [model, model + '-different', 'private-' + credential]) {
    const { broker } = fixture({ modelIds: [model], responseModelIdentity: validator,
      provider: async () => ({ status: 200, body: { model: actual, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } }) });
    const session = await broker.authorizeRun();
    if (actual === model) {
      await broker.invoke({ ...body, model }, session.brokerBearer); assert.equal(broker.evidence().stages[0].actualModel, model);
    } else {
      await rejects(() => broker.invoke({ ...body, model }, session.brokerBearer), 'LIVE_PREVIEW_PROVIDER_MODEL_MISMATCH');
      assert.ok(broker.evidence().closed); assert.equal(broker.evidence().stages[0].actualModel, undefined);
      assert.ok(!JSON.stringify(broker.evidence()).includes(credential));
    }
  }
});
