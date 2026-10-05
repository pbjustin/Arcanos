import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import OpenAI from 'openai';
import { KNOWN_PRODUCTION_ENVIRONMENT_ID, KNOWN_PRODUCTION_PROJECT_ID, livePreviewAttestationSha256, signLivePreviewApproval,
  validateLivePreviewAdmission } from './live-pr-preview-policy.mjs';
import { createLivePreviewBroker } from './live-pr-preview-broker.mjs';
import { createLivePreviewModuleAdapters, createLivePreviewProviderFetch, resolveLivePreviewChildConfig,
  resolveLivePreviewModels, startLivePreview } from './start-live-pr-preview.mjs';

const SHA = 'a'.repeat(40);
const brokerOrigin = 'https://broker.private.example';
const authority = 'ft:gpt-6.1-sol:preview:authority:123';
const constants = { MODEL_GPT_6_LUNA: 'gpt-6-luna', MODEL_GPT_6_1_SOL: 'gpt-6.1-sol' };
const models = [authority, constants.MODEL_GPT_6_LUNA, constants.MODEL_GPT_6_1_SOL].map(id => ({ id }));
function fixture() {
  const session = { mode: 'live-backend-v1', sourceCommit: SHA, approvedSourceCommit: SHA, prNumber: 42,
    projectId: '11111111-1111-4111-8111-111111111111', environmentId: '22222222-2222-4222-8222-222222222222',
    environmentName: 'live-pr-42', serviceId: '33333333-3333-4333-8333-333333333333',
    deploymentId: '44444444-4444-4444-8444-444444444444', expiresAtMs: Date.now() + 60_000,
    testBearer: 'arcanos-preview-' + 'b'.repeat(64), brokerBearer: 'c'.repeat(64), models,
    moduleIds: ['gaming'], brokerOrigin, backendOrigin: 'https://live-pr-42.private.example',
    limits: { maxRequests: 8, durationMs: 60_000 } };
  const env = { NODE_ENV: 'production', TZ: 'UTC', PORT: '8080', RAILWAY_GIT_COMMIT_SHA: SHA,
    RAILWAY_PROJECT_ID: session.projectId, RAILWAY_ENVIRONMENT_ID: session.environmentId,
    RAILWAY_ENVIRONMENT_NAME: session.environmentName, RAILWAY_SERVICE_ID: session.serviceId,
    RAILWAY_DEPLOYMENT_ID: session.deploymentId };
  return { session, env, args: ['--session-file', '/private/session.json', '--broker-origin', brokerOrigin] };
}

test('child admission requires exact SHA, isolated platform identity, empty credential-free environment and signed broker origin', () => {
  const { args, env, session } = fixture();
  assert.deepEqual(resolveLivePreviewChildConfig(args, env, session), { port: 8080, brokerOrigin });
  for (const changes of [{ RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40) }, { RAILWAY_DEPLOYMENT_ID: 'wrong' },
    { RAILWAY_ENVIRONMENT_NAME: 'production' }, { RAILWAY_SERVICE_ID: 'wrong' }, { OPENAI_API_KEY: 'accidental-production-test-key' },
    { ARCANOS_LIVE_PR_PREVIEW_ENABLED: 'true' }, { DATABASE_URL: 'accidental-production-database' }, { TZ: 'other' }]) {
    assert.throws(() => resolveLivePreviewChildConfig(args, { ...env, ...changes }, session), /CHILD_ADMISSION_DENIED/u);
  }
  for (const changes of [{ approvedSourceCommit: 'd'.repeat(40) }, { expiresAtMs: Date.now() - 1 },
    { moduleIds: [] }, { moduleIds: ['gaming', 'gaming'] }, { moduleIds: ['../gaming'] }, { testBearer: 'opaque-production-token' }]) {
    assert.throws(() => resolveLivePreviewChildConfig(args, env, { ...session, ...changes }), /CHILD_ADMISSION_DENIED/u);
  }
  for (const origin of ['http://broker.private.example', 'https://different.private.example',
    'https://api.openai.com', brokerOrigin + '/path', 'https://name:secret@broker.private.example']) {
    assert.throws(() => resolveLivePreviewChildConfig([...args.slice(0, 3), origin], env, session), /BROKER_ORIGIN_INVALID/u);
  }
});

test('known production environment is rejected even when renamed to preview and accidental flags are on', () => {
  const { args, env, session } = fixture();
  const target = { ...session, environmentId: KNOWN_PRODUCTION_ENVIRONMENT_ID };
  assert.throws(() => resolveLivePreviewChildConfig(args, { ...env, RAILWAY_ENVIRONMENT_ID: target.environmentId }, target), /CHILD_ADMISSION_DENIED/u);
  assert.throws(() => resolveLivePreviewChildConfig(args, { ...env, RAILWAY_ENVIRONMENT_ID: target.environmentId,
    ARCANOS_LIVE_PR_PREVIEW_ENABLED: 'true' }, target), /CHILD_ADMISSION_DENIED/u);
  const productionProject = { ...session, projectId: KNOWN_PRODUCTION_PROJECT_ID };
  assert.throws(() => resolveLivePreviewChildConfig(args, { ...env, RAILWAY_PROJECT_ID: productionProject.projectId }, productionProject), /CHILD_ADMISSION_DENIED/u);
});

test('only Gaming factory applies its existing fine-tuned authority and helper model policy', async () => {
  assert.equal(resolveLivePreviewModels(models, constants), authority);
  for (const wrong of [[], [{ id: authority }], [...models, { id: 'ft:gpt-6-luna:other:123' }], models.slice(1)]) {
    assert.throws(() => resolveLivePreviewModels(wrong, constants), /MODELS_INVALID/u);
  }
  let calls = 0;
  const adapter = { moduleId: 'research', validateInput: value => ({ ok: true, input: value }), execute: async () => ({ accepted: false }) };
  const registered = { research: async context => { calls++; assert.deepEqual(context.models, [{ id: 'research-only' }]); return adapter; } };
  assert.deepEqual(await createLivePreviewModuleAdapters(['research'], registered, { models: [{ id: 'research-only' }] }), [adapter]);
  assert.equal(calls, 1);
  await assert.rejects(createLivePreviewModuleAdapters(['research', 'unknown'], registered, {}), /MODULE_UNSUPPORTED/u);
  await assert.rejects(createLivePreviewModuleAdapters(['../research'], registered, {}), /MODULE_UNSUPPORTED/u);
  assert.equal(calls, 1, 'validate every signed module before importing any factory');
  await assert.rejects(createLivePreviewModuleAdapters(['research'], { research: async () => ({ ...adapter, moduleId: 'gaming' }) }, {}), /ADAPTER_INVALID/u);
});

test('provider transport allows approved metadata and Responses only, narrows deadlines and replaces native secrets with scoped identity', async () => {
  const { session } = fixture();
  const observation = { moduleId: 'gaming', stage: 'generation' };
  const calls = [];
  const scopedFetch = createLivePreviewProviderFetch({ brokerOrigin, session, observation: () => observation,
    now: () => session.expiresAtMs - 60_000, getRemainingMs: () => 20_000,
    fetchImplementation: async (url, init) => { calls.push({ url: String(url), init }); return Response.json({}); } });
  await scopedFetch(brokerOrigin + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer native-test-placeholder',
    'x-stainless-timeout': '8', 'x-privileged-token': 'never-forward' }, body: '{}' });
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer ' + session.brokerBearer,
    'x-arcanos-source-commit': SHA, 'x-arcanos-deployment-id': session.deploymentId, 'x-arcanos-live-module': 'gaming',
    'x-arcanos-request-timeout-ms': '7500', 'content-type': 'application/json', 'x-arcanos-live-stage': 'generation' });
  assert.equal(calls[0].init.redirect, 'error');
  observation.stage = 'answer_audit';
  await scopedFetch(brokerOrigin + '/v1/responses', { method: 'POST', headers: { 'x-stainless-timeout': '3' } });
  assert.equal(calls[1].init.headers['x-arcanos-request-timeout-ms'], '2500');
  await scopedFetch(brokerOrigin + '/v1/models/' + encodeURIComponent(authority), { method: 'GET' });
  assert.equal(calls[2].init.headers['x-arcanos-live-module'], 'gaming');
  assert.equal(calls[2].init.headers['x-arcanos-request-timeout-ms'], '3500');
  assert.equal(calls[2].init.headers['x-arcanos-live-stage'], undefined);
  for (const [url, method] of [[brokerOrigin + '/v1/models/not-approved', 'GET'], [brokerOrigin + '/v1/chat/completions', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'], [brokerOrigin + '/v1/responses?secret=value', 'POST'],
    [brokerOrigin + '/v1/responses', 'GET'], [brokerOrigin + '/v1/models/' + encodeURIComponent(authority), 'POST']]) {
    await assert.rejects(scopedFetch(url, { method }), /PROVIDER_ROUTE_DENIED/u);
  }
  assert.equal(calls.length, 3);
  observation.moduleId = 'unapproved';
  await assert.rejects(scopedFetch(brokerOrigin + '/v1/responses', { method: 'POST' }), /PROVIDER_MODULE_DENIED/u);
  assert.equal(calls.length, 3);
});

test('expired transport deadlines fail before provider fetch and only trusted provider timeout codes label timeouts', async () => {
  const { session } = fixture();
  const observation = { moduleId: 'gaming', stage: 'generation' };
  let calls = 0;
  const exhausted = createLivePreviewProviderFetch({ brokerOrigin, session, observation: () => observation,
    getRemainingMs: () => 999, fetchImplementation: () => { calls++; throw new Error('unreachable'); } });
  await assert.rejects(exhausted(brokerOrigin + '/v1/responses', { method: 'POST' }), /DURATION_LIMIT/u);
  assert.equal(calls, 0);
  for (const [code, expected] of [['LIVE_PREVIEW_BUDGET_EXHAUSTED', 'budget'], ['LIVE_PREVIEW_PROVIDER_TIMEOUT', 'timeout'],
    ['LIVE_PREVIEW_CANCELLED', 'unknown'], ['LIVE_PREVIEW_NATIVE_FAILED', 'unknown']]) {
    delete observation.timeoutStage; delete observation.budgetExhausted;
    const transport = createLivePreviewProviderFetch({ brokerOrigin, session, observation: () => observation,
      fetchImplementation: async () => Response.json({ error: { code } }, { status: 408 }) });
    await transport(brokerOrigin + '/v1/responses', { method: 'POST', signal: AbortSignal.abort() });
    assert.equal(observation.timeoutStage, expected === 'timeout' ? 'generation' : undefined);
    assert.equal(observation.budgetExhausted, expected === 'budget' ? true : undefined);
  }
  delete observation.timeoutStage;
  const cancelled = createLivePreviewProviderFetch({ brokerOrigin, session, observation: () => observation,
    fetchImplementation: async () => { throw new DOMException('disconnect', 'AbortError'); } });
  await assert.rejects(cancelled(brokerOrigin + '/v1/responses', { method: 'POST', signal: AbortSignal.abort() }), /PROVIDER_FAILED/u);
  assert.equal(observation.timeoutStage, undefined);
});

test('native SDK fine-tune metadata is canonicalized to the broker approved exact encoded model route', async () => {
  const { session } = fixture();
  const calls = [];
  const client = new OpenAI({ apiKey: session.brokerBearer, baseURL: brokerOrigin + '/v1', maxRetries: 0,
    fetch: createLivePreviewProviderFetch({ brokerOrigin, session,
      observation: () => ({ moduleId: 'gaming', stage: 'generation' }),
      fetchImplementation: async (url, init) => { calls.push({ url, init }); return Response.json({ id: authority, object: 'model' }); } }) });
  assert.equal((await client.models.retrieve(authority)).id, authority);
  assert.equal(calls[0].url, brokerOrigin + '/v1/models/' + encodeURIComponent(authority));
  assert.equal(calls[0].init.headers['x-arcanos-live-module'], 'gaming');
  assert.equal(calls.length, 1);
});

test('native audit deadline reaches trusted broker timeout before SDK cancellation and remains charged without retries', async () => {
  const { session: original } = fixture();
  const nowMs = Date.now();
  const keys = generateKeyPairSync('ed25519');
  const deployment = Object.fromEntries(['projectId', 'environmentId', 'environmentName', 'serviceId', 'deploymentId']
    .map(key => [key, original[key]]));
  const attestation = { ...deployment, repository: 'pbjustin/Arcanos', headRepository: 'pbjustin/Arcanos', prNumber: 42,
    commitSha: SHA, production: false, isolated: true, dataIsolated: true, credentialIsolated: true, egressRestricted: true,
    controllerRevision: 'd'.repeat(40), backendOrigin: original.backendOrigin, brokerOrigin };
  const approval = { version: 'arcanos-live-pr-preview/v1', approvalId: 'local_timeout_test_123', repository: 'pbjustin/Arcanos',
    prNumber: 42, commitSha: SHA, issuedAtMs: nowMs - 1, expiresAtMs: nowMs + 120_000, deployment,
    attestationSha256: livePreviewAttestationSha256(attestation), moduleIds: ['gaming'],
    models: original.models.map(model => ({ ...model, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 })),
    limits: { maxRequests: 4, maxInputTokensPerRequest: 10_000, maxOutputTokensPerRequest: 1_000,
      maxTotalTokens: 40_000, durationMs: 60_000, maxSpendMicroUsd: 100_000 } };
  const admission = validateLivePreviewAdmission({ enabled: true, signedApproval: signLivePreviewApproval(approval, keys.privateKey),
    trustedApprovalPublicKey: keys.publicKey, attestation, nowMs,
    trustedIsolation: { projectIds: [original.projectId], environmentIds: [original.environmentId] } });
  let nativeCalls = 0;
  let providerAborted = false;
  let sdkSignal;
  const broker = createLivePreviewBroker({ admission, claimRun: async () => true,
    resolveCredential: async () => 'sk-proj-' + 'localunitfixture'.repeat(3),
    invokeProvider: ({ signal }) => { nativeCalls++; signal.addEventListener('abort', () => { providerAborted = true; }, { once: true });
      return new Promise(() => {}); } });
  const session = { ...original, ...await broker.authorizeRun() };
  const observation = { moduleId: 'gaming', stage: 'answer_audit' };
  const client = new OpenAI({ apiKey: session.brokerBearer, baseURL: brokerOrigin + '/v1', maxRetries: 0, timeout: 3_000,
    fetch: createLivePreviewProviderFetch({ brokerOrigin, session, observation: () => observation,
      fetchImplementation: async (_url, init) => {
        sdkSignal = init.signal;
        try {
          return Response.json(await broker.invoke(JSON.parse(init.body), session.brokerBearer, {
            moduleId: init.headers['x-arcanos-live-module'], stage: init.headers['x-arcanos-live-stage'],
            timeoutMs: Number(init.headers['x-arcanos-request-timeout-ms']), signal: init.signal,
          }));
        } catch (error) { return Response.json({ error: { code: error.code, message: error.code } }, { status: 408 }); }
      } }) });
  try {
    await assert.rejects(client.responses.create({ model: authority, input: 'Local timeout fixture', max_output_tokens: 10 }),
      error => error.code === 'LIVE_PREVIEW_PROVIDER_TIMEOUT');
    assert.equal(observation.timeoutStage, 'answer_audit');
    assert.equal(sdkSignal.aborted, false, 'broker deadline returns before native SDK deadline');
    assert.equal(providerAborted, true); assert.equal(nativeCalls, 1);
    assert.deepEqual(broker.evidence().stages.map(({ moduleId, stage, outcome, code }) => ({ moduleId, stage, outcome, code })),
      [{ moduleId: 'gaming', stage: 'answer_audit', outcome: 'failed',
      code: 'LIVE_PREVIEW_PROVIDER_TIMEOUT' }]);
    assert.equal(broker.evidence().usage.requests, 1);
    assert.ok(broker.evidence().usage.reservedTotalTokens > 0);
  } finally { broker.close(); }
});

test('bootstrap refuses unapproved session identities and unsupported modules before any factory or provider transport', async () => {
  const { args, env, session } = fixture();
  let factories = 0;
  const base = { readRuntimeDirectory: async () => [], readSessionFile: async () => JSON.stringify(session),
    moduleFactories: { gaming: async () => { factories++; throw new Error('must not load'); } } };
  for (const admitted of [{ ...session, sourceCommit: 'd'.repeat(40) }, { ...session, deploymentId: 'wrong' },
    { ...session, brokerOrigin: 'https://different.private.example' }, { ...session, moduleIds: ['research'] }]) {
    await assert.rejects(startLivePreview(args, env, { ...base,
      fetchImplementation: async () => Response.json(admitted) }), /BROKER_IDENTITY_MISMATCH/u);
  }
  await assert.rejects(startLivePreview(args, env, { ...base,
    fetchImplementation: async () => Response.json({ error: 'unapproved' }, { status: 403 }) }), /BROKER_ADMISSION_DENIED/u);
  const unsupported = { ...session, moduleIds: ['research'] };
  await assert.rejects(startLivePreview(args, env, { ...base, readSessionFile: async () => JSON.stringify(unsupported),
    fetchImplementation: async () => Response.json(unsupported) }), /MODULE_UNSUPPORTED/u);
  assert.equal(factories, 0);
});

test('generic bootstrap scopes real SDK metadata, generation and audit transports to its selected registered module', async () => {
  const { args, env, session: original } = fixture();
  const session = { ...original, moduleIds: ['research'], models: [{ id: 'research-only' }] };
  const reservedPort = createServer(); reservedPort.listen(0, '127.0.0.1'); await once(reservedPort, 'listening');
  const port = reservedPort.address().port; await new Promise(resolve => reservedPort.close(resolve));
  const stages = [];
  const transports = [];
  const trustedUsage = { requests: 3, elapsedMs: 123, reservedInputTokens: 30, reservedOutputTokens: 30,
    reservedTotalTokens: 60, reservedSpendMicroUsd: 90, observedInputTokens: 20, observedOutputTokens: 20, observedSpendMicroUsd: 60 };
  const physicalFetch = async (url, init) => {
    const value = new URL(String(url));
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer ' + session.brokerBearer);
    assert.equal(init.headers['x-arcanos-source-commit'], SHA);
    assert.equal(init.headers['x-arcanos-deployment-id'], session.deploymentId);
    if (value.pathname === '/session') return Response.json(session);
    if (value.pathname === '/usage') return Response.json({ stages: [...stages], usage: trustedUsage, limits: session.limits });
    transports.push({ url: String(url), init });
    assert.equal(init.headers['x-arcanos-live-module'], 'research');
    if (value.pathname === '/v1/models/research-only') {
      stages.push({ stage: 'provider_metadata', moduleId: 'research' });
      return Response.json({ id: 'research-only', object: 'model', created: 1, owned_by: 'preview' });
    }
    stages.push({ stage: init.headers['x-arcanos-live-stage'] === 'answer_audit' ? 'answer_audit' : 'model_generation', moduleId: 'research' });
    return Response.json({ id: 'resp-local', object: 'response', status: 'completed', model: 'research-only',
      output: [{ id: 'message-local', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Local transport fixture [1].', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
  };
  let evidence;
  const server = await startLivePreview(args, { ...env, PORT: String(port) }, {
    readRuntimeDirectory: async () => [], readSessionFile: async () => JSON.stringify(session), fetchImplementation: physicalFetch,
    moduleFactories: { research: async context => {
      const client = new OpenAI({ apiKey: context.handoff.brokerBearer, baseURL: brokerOrigin + '/v1', maxRetries: 0, timeout: 8_000,
        fetch: createLivePreviewProviderFetch({ brokerOrigin, session, observation: context.observation, fetchImplementation: physicalFetch }) });
      return { moduleId: 'research', validateInput: value => ({ ok: true, input: value }), execute: async (_input, observer) => {
        await client.models.retrieve('research-only');
        await client.responses.create({ model: 'research-only', input: 'local generation', max_output_tokens: 10 });
        observer.onAnswerAuditStart();
        await client.responses.create({ model: 'research-only', input: 'local audit', max_output_tokens: 10 }, { timeout: 3_000 });
        return { accepted: false };
      } };
    } },
    createApplication: (_admitted, deps) => async (_req, res) => {
      await deps.adapters[0].execute({}, { onAnswerAuditStart() {} });
      evidence = { observation: deps.observation(), usage: await deps.usage() };
      res.end('local-bootstrap-complete');
    },
  });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const response = await fetch('http://127.0.0.1:' + port);
    assert.equal(await response.text(), 'local-bootstrap-complete');
    assert.deepEqual(evidence.observation, { moduleId: 'research', stage: 'answer_audit', generationCalls: 1, auditCalls: 1 });
    assert.equal(evidence.usage.providerCalls, 2); assert.equal(evidence.usage.requests, 3);
    assert.equal(evidence.usage.elapsedMs, 123, 'trusted elapsed time must not be reconstructed from clipped expiry');
    assert.equal(transports.length, 3);
    assert.equal(transports[2].init.headers['x-arcanos-request-timeout-ms'], '2500');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
