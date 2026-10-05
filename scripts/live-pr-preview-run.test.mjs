import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createLivePreviewBroker } from './live-pr-preview-broker.mjs';
import { livePreviewAttestationSha256, signLivePreviewApproval, validateLivePreviewAdmission } from './live-pr-preview-policy.mjs';
import { claimLivePreviewApprovalOnce, createBrokerHttpApplication, createOpenAiResponsesTransport,
  loadTrustedResponseModelIdentity,
  parseLivePreviewRunArguments, readTrustedOperatorFile, readTrustedRunnerGitState,
  runLivePreviewSupervisor } from './live-pr-preview-run.mjs';

const SHA = 'a'.repeat(40);
const TRUSTED_SHA = 'b'.repeat(40);
const ROOT = path.resolve(new URL('../', import.meta.url).pathname);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const identity = { projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222', environmentName: 'live-pr-42',
  serviceId: '33333333-3333-4333-8333-333333333333', deploymentId: '44444444-4444-4444-8444-444444444444' };
const bearer = 'broker-secret-'.repeat(5);
const testBearer = 'identity-secret-'.repeat(5);

function inputs() {
  const now = Date.now();
  const attestation = { repository: 'pbjustin/Arcanos', headRepository: 'pbjustin/Arcanos', prNumber: 42,
    commitSha: SHA, ...identity, production: false, isolated: true, dataIsolated: true,
    credentialIsolated: true, egressRestricted: true, controllerRevision: TRUSTED_SHA,
    backendOrigin: 'https://live-pr-42.private.example', brokerOrigin: 'https://broker.private.example' };
  const approval = { version: 'arcanos-live-pr-preview/v1', approvalId: 'single_use_approval_123',
    repository: 'pbjustin/Arcanos', prNumber: 42, commitSha: SHA, moduleIds: ['gaming'], issuedAtMs: now - 1_000,
    expiresAtMs: now + 300_000, attestationSha256: livePreviewAttestationSha256(attestation), deployment: identity,
    limits: { maxRequests: 8, maxInputTokensPerRequest: 4_000, maxOutputTokensPerRequest: 1_000,
      maxTotalTokens: 40_000, durationMs: 120_000, maxSpendMicroUsd: 100_000 },
    models: [{ id: 'approved-model', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }] };
  return { attestation, approval, signedApproval: signLivePreviewApproval(approval, privateKey),
    trust: { trustedRunnerSha: TRUSTED_SHA, approvalPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      trustedIsolation: { projectIds: [identity.projectId], environmentIds: [identity.environmentId] } } };
}

function args(...extra) {
  return ['--approval-file', '/operator/approval.json', '--attestation-file', '/operator/attestation.json',
    '--trust-file', '/operator/trust.json', '--commit-sha', SHA, ...extra];
}

function dependencies(fixture, assertions) {
  return { readOperatorFile: filename => JSON.stringify(filename.endsWith('/trust.json') ? fixture.trust
    : filename.endsWith('/approval.json') ? fixture.signedApproval : fixture.attestation),
  readGitState: () => ({ head: TRUSTED_SHA, clean: true, repository: 'pbjustin/Arcanos' }),
  loadResponseModelIdentity: async () => { assertions.loader++; return (_response, expectedModel) => expectedModel; },
  createBroker: () => { assertions.broker++; throw new Error('broker must stay unreachable'); },
  invokeProvider: () => { assertions.provider++; throw new Error('provider must stay unreachable'); },
  environment: new Proxy({}, { get() { assertions.credential++; throw new Error('credential must stay unread'); } }) };
}

test('supervisor defaults to offline validation with zero broker, credential or provider access', async () => {
  const counters = { broker: 0, credential: 0, provider: 0, loader: 0 };
  const result = await runLivePreviewSupervisor(args(), dependencies(inputs(), counters));
  assert.equal(result.executed, false);
  assert.equal(result.approvalValidated, true);
  assert.equal(result.sourceCommit, SHA);
  assert.equal(result.trustedRunnerSha, TRUSTED_SHA);
  assert.equal(result.liveBackendSuccess, null);
  assert.equal(result.installedPluginOAuthSuccess, null);
  assert.deepEqual(counters, { broker: 0, credential: 0, provider: 0, loader: 0 });
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('execute requires both explicit flags and external durable-claim/session paths', () => {
  for (const extra of [['--execute'], ['--allow-paid-provider'], ['--execute', '--allow-paid-provider']]) {
    assert.throws(() => parseLivePreviewRunArguments(args(...extra)), { code: 'LIVE_PREVIEW_EXECUTION_FLAGS_REQUIRED' });
  }
  assert.equal(parseLivePreviewRunArguments(args('--execute', '--allow-paid-provider', '--claims-dir', '/operator/claims',
    '--session-out', '/operator/session.json')).execute, true);
  assert.throws(() => parseLivePreviewRunArguments(args('--port', '65536')), { code: 'LIVE_PREVIEW_PORT_INVALID' });
  assert.throws(() => parseLivePreviewRunArguments(args('--execute', '--execute')), { code: 'LIVE_PREVIEW_ARGUMENT_INVALID' });
});

test('unsigned, wrong SHA, changed trusted checkout, invalid limits and forks cannot obtain credentials or invoke providers', async () => {
  const cases = [
    { alter: fixture => { fixture.signedApproval.signature = 'x'.repeat(86); }, code: 'LIVE_PREVIEW_APPROVAL_SIGNATURE_INVALID' },
    { alter: fixture => { fixture.signedApproval.approval.commitSha = 'c'.repeat(40); }, code: 'LIVE_PREVIEW_SHA_MISMATCH' },
    { alter: fixture => { fixture.trust.trustedRunnerSha = 'c'.repeat(40); }, code: 'LIVE_PREVIEW_TRUSTED_REVISION_MISMATCH' },
    { alter: fixture => { fixture.signedApproval.approval.moduleIds.push('research'); }, code: 'LIVE_PREVIEW_APPROVAL_SIGNATURE_INVALID' },
    { alter: fixture => { delete fixture.approval.moduleIds;
      fixture.signedApproval = signLivePreviewApproval(fixture.approval, privateKey); }, code: 'LIVE_PREVIEW_APPROVAL_INVALID' },
    { alter: fixture => { fixture.approval.limits.maxSpendMicroUsd = 0;
      fixture.signedApproval = signLivePreviewApproval(fixture.approval, privateKey); }, code: 'LIVE_PREVIEW_LIMITS_INVALID' },
    { alter: fixture => { fixture.attestation.headRepository = 'fork/Arcanos';
      fixture.approval.attestationSha256 = livePreviewAttestationSha256(fixture.attestation);
      fixture.signedApproval = signLivePreviewApproval(fixture.approval, privateKey); }, code: 'LIVE_PREVIEW_FORK_FORBIDDEN' },
    { alter: fixture => { fixture.attestation.production = true;
      fixture.approval.attestationSha256 = livePreviewAttestationSha256(fixture.attestation);
      fixture.signedApproval = signLivePreviewApproval(fixture.approval, privateKey); }, code: 'LIVE_PREVIEW_PRODUCTION_FORBIDDEN' },
  ];
  for (const scenario of cases) {
    const fixture = inputs(); scenario.alter(fixture);
    const counters = { broker: 0, credential: 0, provider: 0, loader: 0 };
    await assert.rejects(runLivePreviewSupervisor(args('--execute', '--allow-paid-provider', '--claims-dir', '/operator/claims',
      '--session-out', '/operator/session.json'), dependencies(fixture, counters)), { code: scenario.code });
    assert.deepEqual(counters, { broker: 0, credential: 0, provider: 0, loader: 0 });
  }
});

test('operator files require current-owner restrictive permissions, external paths and no symlinks', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-live-operator-'));
  try {
    const filename = path.join(directory, 'trust.json');
    writeFileSync(filename, '{}', { mode: 0o600 });
    assert.equal(readTrustedOperatorFile(filename), '{}');
    chmodSync(filename, 0o644);
    assert.throws(() => readTrustedOperatorFile(filename), { code: 'LIVE_PREVIEW_OPERATOR_FILE_UNSAFE' });
    chmodSync(filename, 0o600);
    symlinkSync(filename, path.join(directory, 'link.json'));
    assert.throws(() => readTrustedOperatorFile(path.join(directory, 'link.json')), { code: 'LIVE_PREVIEW_OPERATOR_FILE_UNSAFE' });
    assert.throws(() => readTrustedOperatorFile(filename, directory), { code: 'LIVE_PREVIEW_OPERATOR_PATH_REQUIRED' });
    assert.throws(() => readTrustedOperatorFile('relative.json'), { code: 'LIVE_PREVIEW_OPERATOR_PATH_REQUIRED' });
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('durable atomic approval claims reject replay, traversal and insecure directories', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-live-claims-'));
  try {
    assert.equal(claimLivePreviewApprovalOnce(directory, 'approval_identifier_1234'), true);
    assert.equal(claimLivePreviewApprovalOnce(directory, 'approval_identifier_1234'), false);
    assert.equal(readFileSync(path.join(directory, 'approval_identifier_1234.claim'), 'utf8'), 'claimed\n');
    assert.throws(() => claimLivePreviewApprovalOnce(directory, '../approval_escape'), { code: 'LIVE_PREVIEW_APPROVAL_ID_INVALID' });
    chmodSync(directory, 0o755);
    assert.throws(() => claimLivePreviewApprovalOnce(directory, 'approval_identifier_4567'), { code: 'LIVE_PREVIEW_OPERATOR_FILE_UNSAFE' });
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('explicit approved execution writes only a private handoff, binds loopback and never prints tokens in evidence', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-live-execution-'));
  try {
    const fixture = inputs(); const counters = { broker: 0, credential: 0, provider: 0, loader: 0 };
    fixture.approval.moduleIds = ['gaming', 'research'];
    fixture.signedApproval = signLivePreviewApproval(fixture.approval, privateKey);
    const options = dependencies(fixture, counters);
    options.createBroker = brokerOptions => ({
      authorizeRun: async () => {
        assert.equal(counters.loader, 1);
        assert.equal(typeof brokerOptions.responseModelIdentity, 'function');
        assert.equal(await brokerOptions.claimRun(fixture.approval.approvalId), true);
        assert.equal(await brokerOptions.resolveCredential(), 'fake-isolated-test-key-with-32-characters');
        return { brokerBearer: bearer, testBearer, expiresAtMs: Date.now() + 120_000 };
      },
      evidence: () => ({ usage: { requests: 0 } }), close: () => {},
    });
    options.environment = new Proxy({}, { get() { counters.credential++; return 'fake-isolated-test-key-with-32-characters'; } });
    let bindAddress;
    const server = new EventEmitter();
    server.listen = (_port, host, callback) => { bindAddress = host; callback(); };
    server.address = () => ({ port: 43210 });
    server.close = () => server.emit('close'); server.closeAllConnections = () => {};
    options.createServer = () => server;
    const sessionPath = path.join(directory, 'session.json');
    const result = await runLivePreviewSupervisor(args('--execute', '--allow-paid-provider', '--claims-dir', directory,
      '--session-out', sessionPath), options);
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    assert.equal(bindAddress, '127.0.0.1');
    assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
    assert.equal(session.backendOrigin, fixture.attestation.backendOrigin);
    assert.equal(session.brokerOrigin, fixture.attestation.brokerOrigin);
    assert.equal(session.sourceCommit, SHA); assert.equal(session.approvedSourceCommit, SHA);
    assert.equal(session.serviceId, identity.serviceId); assert.equal(session.testBearer, testBearer);
    assert.deepEqual(session.moduleIds, ['gaming', 'research']);
    assert.equal(counters.credential, 1); assert.equal(counters.provider, 0);
    assert.ok(!JSON.stringify(result.evidence).includes(bearer));
    assert.ok(!JSON.stringify(result.evidence).includes(testBearer));
    result.close(); await result.completed;
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('an existing session output fails before broker authorization or credential lookup', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-live-existing-session-'));
  try {
    const sessionPath = path.join(directory, 'session.json');
    writeFileSync(sessionPath, '{}', { mode: 0o600 });
    const counters = { broker: 0, credential: 0, provider: 0, loader: 0 };
    await assert.rejects(runLivePreviewSupervisor(args('--execute', '--allow-paid-provider', '--claims-dir', directory,
      '--session-out', sessionPath), dependencies(inputs(), counters)), { code: 'LIVE_PREVIEW_SESSION_EXISTS' });
    assert.deepEqual(counters, { broker: 0, credential: 0, provider: 0, loader: 0 });
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('a listener failure closes the authorized broker and leaves no token handoff', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-live-listener-failure-'));
  try {
    const counters = { broker: 0, credential: 0, provider: 0, loader: 0 };
    const options = dependencies(inputs(), counters);
    let closed = false;
    options.createBroker = () => ({
      authorizeRun: async () => ({ brokerBearer: bearer, testBearer, expiresAtMs: Date.now() + 120_000 }),
      close: () => { closed = true; },
    });
    const server = new EventEmitter();
    server.listen = () => server.emit('error', new Error('private raw listener details'));
    server.close = () => {};
    options.createServer = () => server;
    const sessionPath = path.join(directory, 'session.json');
    await assert.rejects(runLivePreviewSupervisor(args('--execute', '--allow-paid-provider', '--claims-dir', directory,
      '--session-out', sessionPath), options), { code: 'LIVE_PREVIEW_BROKER_LISTEN_FAILED' });
    assert.equal(closed, true);
    assert.throws(() => readFileSync(sessionPath), { code: 'ENOENT' });
    assert.equal(counters.provider, 0);
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('trusted Git inspection inherits no provider or CI environment and rejects dirty code', () => {
  const calls = [];
  const outputs = [ROOT, TRUSTED_SHA, 'https://github.com/pbjustin/Arcanos.git', ''];
  const result = readTrustedRunnerGitState(ROOT, (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    return { status: 0, stdout: outputs.shift() };
  });
  assert.equal(result.head, TRUSTED_SHA);
  assert.ok(calls.every(call => Object.keys(call.options.env).join(',') === 'PATH'));
  assert.ok(calls.every(call => call.arguments_.includes('core.fsmonitor=false')));
  const dirtyOutputs = [ROOT, TRUSTED_SHA, 'https://github.com/pbjustin/Arcanos.git', ' M scripts/live-pr-preview-run.mjs'];
  assert.throws(() => readTrustedRunnerGitState(ROOT, () => ({ status: 0, stdout: dirtyOutputs.shift() })),
    { code: 'LIVE_PREVIEW_TRUSTED_CHECKOUT_INVALID' });
});

test('native shared response identity policy is loaded from the fixed trusted revision and preserves helper snapshots', async () => {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(revision.status, 0);
  const responseModelIdentity = await loadTrustedResponseModelIdentity(ROOT, revision.stdout.trim());
  assert.equal(responseModelIdentity({ model: 'gpt-6-luna-2026-07-01' }, 'gpt-6-luna'), 'gpt-6-luna-2026-07-01');
  assert.equal(responseModelIdentity({ model: 'ft:gpt-6.1-sol:arcanos:authority:id' }, 'ft:gpt-6.1-sol:arcanos:authority:id'),
    'ft:gpt-6.1-sol:arcanos:authority:id');
  assert.throws(() => responseModelIdentity({ model: 'ft:gpt-6.1-sol:arcanos:authority:other' }, 'ft:gpt-6.1-sol:arcanos:authority:id'));
  assert.throws(() => responseModelIdentity({ model: 'gpt-6.1-sol' }, 'ft:gpt-6.1-sol:arcanos:authority:id'));
});

test('trusted model policy loader rejects imports, re-exports and runtime dependencies without evaluating source', async () => {
  const forbiddenSources = ["import 'node:fs';", "export { readFile } from 'node:fs';", "export * from 'node:fs';",
    "const dependency = require('node:fs');", 'const secret = process.env.OPENAI_API_KEY;',
    "const effect = globalThis.fetch('https://example.invalid');"];
  for (const source of forbiddenSources) {
    await assert.rejects(loadTrustedResponseModelIdentity(ROOT, TRUSTED_SHA, (command, args_, options) => {
      assert.equal(command, 'git');
      assert.equal(args_.at(-1), TRUSTED_SHA + ':src/shared/gpt/generativeModelPolicyCore.ts');
      assert.deepEqual(Object.keys(options.env), ['PATH']);
      return { status: 0, stdout: source };
    }), { code: 'LIVE_PREVIEW_MODEL_POLICY_DEPENDENCY_FORBIDDEN' });
  }
});

test('failure loading the trusted model policy occurs before any approval claim, credential lookup or broker creation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-live-policy-load-failure-'));
  try {
    const counters = { broker: 0, credential: 0, provider: 0, loader: 0 };
    const options = dependencies(inputs(), counters);
    options.loadResponseModelIdentity = async () => { counters.loader++; throw new Error('trusted source unavailable'); };
    await assert.rejects(runLivePreviewSupervisor(args('--execute', '--allow-paid-provider', '--claims-dir', directory,
      '--session-out', path.join(directory, 'session.json')), options));
    assert.deepEqual(counters, { broker: 0, credential: 0, provider: 0, loader: 1 });
    assert.throws(() => readFileSync(path.join(directory, 'single_use_approval_123.claim')), { code: 'ENOENT' });
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test('real broker uses the native helper snapshot identity policy while fine-tune substitutions still fail closed', async () => {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const responseModelIdentity = await loadTrustedResponseModelIdentity(ROOT, revision.stdout.trim());
  const fixture = inputs();
  const authority = 'ft:gpt-6.1-sol:arcanos:authority:id';
  fixture.approval.models = [{ id: 'gpt-6-luna', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 },
    { id: authority, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 }];
  fixture.signedApproval = signLivePreviewApproval(fixture.approval, privateKey);
  const admission = validateLivePreviewAdmission({ enabled: true, signedApproval: fixture.signedApproval,
    trustedApprovalPublicKey: fixture.trust.approvalPublicKey, attestation: fixture.attestation,
    trustedIsolation: fixture.trust.trustedIsolation });
  const broker = createLivePreviewBroker({ admission, responseModelIdentity, claimRun: () => true,
    resolveCredential: () => 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789abcdefgh',
    invokeProvider: async ({ body }) => ({ status: 200, body: {
      model: body.model === 'gpt-6-luna' ? 'gpt-6-luna-2026-07-01' : authority + '-substitution',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    } }) });
  const session = await broker.authorizeRun();
  const helper = await broker.invoke({ model: 'gpt-6-luna', input: 'question', max_output_tokens: 10 },
    session.brokerBearer, { moduleId: 'gaming' });
  assert.equal(helper.model, 'gpt-6-luna-2026-07-01');
  assert.equal(broker.evidence().stages[0].actualModel, helper.model);
  await assert.rejects(broker.invoke({ model: authority, input: 'question', max_output_tokens: 10 },
    session.brokerBearer, { moduleId: 'gaming' }), { code: 'LIVE_PREVIEW_PROVIDER_MODEL_MISMATCH' });
  assert.equal(broker.evidence().closed, true);
});

function httpRequest({ method = 'POST', url = '/v1/responses', auth = bearer, commit = SHA,
  deployment = identity.deploymentId, stage = 'generation', moduleId = 'gaming', payload = '{}' } = {}) {
  const request = Readable.from([Buffer.from(payload)]);
  request.method = method; request.url = url;
  request.headers = { authorization: 'Bearer ' + auth, 'content-type': 'application/json',
    'x-arcanos-source-commit': commit, 'x-arcanos-deployment-id': deployment, 'x-arcanos-live-stage': stage,
    'x-arcanos-live-module': moduleId };
  return request;
}

function httpResponse() {
  const result = new EventEmitter();
  result.writeHead = (status, headers) => { result.status = status; result.headers = headers; };
  result.end = body => { result.body = JSON.parse(body); result.writableEnded = true; };
  return result;
}

function httpApplication(overrides = {}, moduleIds = ['gaming']) {
  const fixture = inputs();
  fixture.approval.moduleIds = moduleIds;
  let calls = 0; let invokeOptions;
  const broker = { evidence: () => ({ usage: { requests: calls }, stages: [] }),
    invoke: async (_body, _auth, options) => { calls++; invokeOptions = options;
      return { id: 'sanitized-id', usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }; }, ...overrides };
  return { handler: createBrokerHttpApplication({ broker,
    session: { brokerBearer: bearer, testBearer, expiresAtMs: Date.now() + 120_000 },
    admission: { approval: fixture.approval, attestation: fixture.attestation } }), calls: () => calls, options: () => invokeOptions };
}

test('HTTP broker rejects unauthorized identity, deployment drift, forbidden paths, missing stages and oversized bodies before provider access', async () => {
  for (const parameters of [{ auth: 'wrong' }, { commit: 'b'.repeat(40) }, { deployment: 'wrong' },
    { url: '/v1/chat/completions' }, { stage: '' }, { moduleId: '' }, { moduleId: 'research' },
    { payload: JSON.stringify({ input: 'x'.repeat(65_536) }) }]) {
    const app = httpApplication(); const response = httpResponse();
    await app.handler(httpRequest(parameters), response);
    assert.equal(app.calls(), 0);
    assert.ok(response.status === 401 || response.status === 403);
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.ok(!JSON.stringify(response.body).includes(bearer));
  }
});

test('HTTP session and usage require broker identity and bind exact approved commit/deployment', async () => {
  const app = httpApplication(); const response = httpResponse();
  await app.handler(httpRequest({ method: 'GET', url: '/session' }), response);
  assert.equal(response.status, 200);
  assert.equal(response.body.sourceCommit, SHA);
  assert.equal(response.body.deploymentId, identity.deploymentId);
  assert.equal(response.body.testBearer, testBearer);
  assert.equal(response.body.mode, 'live-backend-v1');
  assert.equal(response.body.prNumber, 42);
  assert.deepEqual(response.body.moduleIds, ['gaming']);
  assert.equal(response.body.serviceId, identity.serviceId);
  assert.equal(response.body.backendOrigin, 'https://live-pr-42.private.example');
  assert.equal(response.body.brokerOrigin, 'https://broker.private.example');
  assert.ok(!JSON.stringify(response.body).includes(bearer));
  const usage = httpResponse();
  await app.handler(httpRequest({ method: 'GET', url: '/usage' }), usage);
  assert.deepEqual(usage.body.usage, { requests: 0 });
  assert.equal(app.calls(), 0);
});

test('HTTP session carries only the operator-approved generic module scope', async () => {
  const app = httpApplication({}, ['gaming', 'research']); const response = httpResponse();
  await app.handler(httpRequest({ method: 'GET', url: '/session' }), response);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.moduleIds, ['gaming', 'research']);
  assert.equal(app.calls(), 0);
});

test('HTTP broker maps stage and bounded request timeout without forwarding identity headers', async () => {
  const app = httpApplication(); const response = httpResponse();
  const request = httpRequest({ stage: 'answer_audit', payload: JSON.stringify({ model: 'approved-model', input: 'question', max_output_tokens: 20 }) });
  request.headers['x-arcanos-request-timeout-ms'] = '123';
  await app.handler(request, response);
  assert.equal(response.status, 200); assert.equal(app.calls(), 1);
  assert.equal(app.options().stage, 'answer_audit'); assert.equal(app.options().timeoutMs, 123);
  assert.equal(app.options().moduleId, 'gaming');
  assert.ok(app.options().signal instanceof AbortSignal);
  const rejected = httpRequest(); rejected.headers['x-arcanos-request-timeout-ms'] = '120001';
  await app.handler(rejected, httpResponse());
  assert.equal(app.calls(), 1);
});

test('HTTP broker returns stable codes and never logs or sends arbitrary provider errors', async () => {
  const app = httpApplication({ invoke: async () => { throw new Error('raw provider secret body'); } });
  const response = httpResponse();
  await app.handler(httpRequest(), response);
  assert.deepEqual(response.body, { error: { code: 'LIVE_PREVIEW_REQUEST_FAILED' } });
});

test('HTTP model metadata is approved-only and never accepts an arbitrary provider path', async () => {
  const fetched = [];
  const app = httpApplication({ retrieveModel: async (model, auth, options) => {
    fetched.push({ model, auth, moduleId: options.moduleId }); return { id: model, object: 'model' };
  } });
  const allowed = httpResponse();
  await app.handler(httpRequest({ method: 'GET', url: '/v1/models/approved-model' }), allowed);
  assert.deepEqual(allowed.body, { id: 'approved-model', object: 'model' });
  assert.deepEqual(fetched, [{ model: 'approved-model', auth: bearer, moduleId: 'gaming' }]);
  for (const url of ['/v1/models/unapproved', '/v1/models/approved-model?redirect=https://attacker.invalid',
    '/v1/models/..%2Fresponses', '/v1/models/%61pproved-model']) {
    const rejected = httpResponse();
    await app.handler(httpRequest({ method: 'GET', url }), rejected);
    assert.equal(rejected.status, 403);
  }
  const wrongModule = httpResponse();
  await app.handler(httpRequest({ method: 'GET', url: '/v1/models/approved-model', moduleId: 'research' }), wrongModule);
  assert.equal(wrongModule.status, 403);
  assert.equal(fetched.length, 1);
});

test('HTTP provider requests attach the exact approved module to broker ledger options', async () => {
  const app = httpApplication({}, ['gaming', 'research']);
  const response = httpResponse();
  await app.handler(httpRequest({ moduleId: 'research' }), response);
  assert.equal(response.status, 200);
  assert.equal(app.options().moduleId, 'research');
  const absentModule = httpRequest(); delete absentModule.headers['x-arcanos-live-module'];
  const absentResponse = httpResponse();
  await app.handler(absentModule, absentResponse);
  assert.deepEqual(absentResponse.body, { error: { code: 'LIVE_PREVIEW_MODULE_UNAPPROVED' } });
  const unrelatedResponse = httpResponse();
  await app.handler(httpRequest({ moduleId: 'backstage' }), unrelatedResponse);
  assert.deepEqual(unrelatedResponse.body, { error: { code: 'LIVE_PREVIEW_MODULE_UNAPPROVED' } });
  assert.equal(app.calls(), 1);
});

test('HTTP metadata forwards bounded timeout and rejects invalid timeout before broker access', async () => {
  const timeouts = [];
  const app = httpApplication({ retrieveModel: async (_model, _auth, options) => {
    timeouts.push(options.timeoutMs); return { id: 'approved-model', object: 'model' };
  } });
  const allowed = httpRequest({ method: 'GET', url: '/v1/models/approved-model' });
  allowed.headers['x-arcanos-request-timeout-ms'] = '123';
  const response = httpResponse();
  await app.handler(allowed, response);
  assert.equal(response.status, 200);
  assert.deepEqual(timeouts, [123]);
  for (const timeout of ['0', '-1', '120001', 'bad', '1.5']) {
    const request = httpRequest({ method: 'GET', url: '/v1/models/approved-model' });
    request.headers['x-arcanos-request-timeout-ms'] = timeout;
    const rejected = httpResponse();
    await app.handler(request, rejected);
    assert.equal(rejected.status, 403);
    assert.deepEqual(rejected.body, { error: { code: 'LIVE_PREVIEW_DURATION_LIMIT' } });
  }
  assert.deepEqual(timeouts, [123]);
});

test('native Responses adapter uses fixed endpoint, no redirects and no retries', async () => {
  const calls = [];
  const transport = createOpenAiResponsesTransport(async (...parameters) => {
    calls.push(parameters); return new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200 });
  });
  const signal = new AbortController().signal;
  const result = await transport({ url: 'https://api.openai.com/v1/responses', headers: { authorization: 'Bearer test-placeholder' },
    body: { model: 'approved-model', input: 'question', max_output_tokens: 10 }, signal });
  assert.equal(result.status, 200); assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].signal, signal);
  await assert.rejects(transport({ url: 'https://attacker.invalid/', headers: {}, body: {} }), { code: 'LIVE_PREVIEW_PROVIDER_URL_FORBIDDEN' });
  assert.equal(calls.length, 1);
  const failing = createOpenAiResponsesTransport(async () => new Response('secret provider failure', { status: 429 }));
  await assert.rejects(failing({ url: 'https://api.openai.com/v1/responses', headers: {}, body: {} }), { code: 'LIVE_PREVIEW_PROVIDER_FAILED' });
});

test('native metadata transport restricts canonical model paths and does not send a POST body', async () => {
  const calls = [];
  const transport = createOpenAiResponsesTransport(async (...parameters) => {
    calls.push(parameters); return new Response(JSON.stringify({ id: 'ft:approved:model', object: 'model' }));
  });
  const url = 'https://api.openai.com/v1/models/' + encodeURIComponent('ft:approved:model');
  await transport({ url, method: 'GET', headers: { authorization: 'Bearer test-placeholder' } });
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[0][1].redirect, 'error');
  for (const forbidden of ['https://api.openai.com/v1/models/../responses', 'https://api.openai.com/v1/models/name?x=1',
    'https://api.openai.com/v1/models/%6Eame', 'https://api.openai.com/v1/models/name%2Fresponses']) {
    await assert.rejects(transport({ url: forbidden, method: 'GET', headers: {} }), { code: 'LIVE_PREVIEW_PROVIDER_URL_FORBIDDEN' });
  }
  assert.equal(calls.length, 1);
});

test('native Responses adapter bounds provider response bytes and rejects malformed JSON', async () => {
  const huge = createOpenAiResponsesTransport(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(huge({ url: 'https://api.openai.com/v1/responses', headers: {}, body: {} }),
    { code: 'LIVE_PREVIEW_PROVIDER_RESPONSE_LIMIT' });
  const malformed = createOpenAiResponsesTransport(async () => new Response('secret invalid JSON'));
  await assert.rejects(malformed({ url: 'https://api.openai.com/v1/responses', headers: {}, body: {} }),
    { code: 'LIVE_PREVIEW_PROVIDER_RESPONSE_INVALID' });
});
