import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { livePreviewAttestationSha256, signLivePreviewApproval } from './live-pr-preview-policy.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_CASE_MANIFEST, LIVE_PREVIEW_MODE } from './live-pr-preview-verifier.mjs';
import { parseLivePreviewE2eArguments, runLivePreviewE2e, sanitizeLivePreviewEvidence } from './live-pr-preview-e2e.mjs';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);
const TRUSTED_SHA = 'b'.repeat(40);
const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const BACKEND = 'https://backend.live-pr-42.preview.example.com';
const BROKER = 'https://broker.live-pr-42.preview.example.com';
const SOURCE = 'https://guides.example.com/secret-path/guide?private=query#fragment';
const limits = { maxRequests: 16, maxInputTokensPerRequest: 1_000, maxOutputTokensPerRequest: 300,
  maxTotalTokens: 20_000, durationMs: 60_000, maxSpendMicroUsd: 100_000 };

function fixture(caseId = 'useful_grounded_guide', moduleId = 'gaming') {
  const keys = generateKeyPairSync('ed25519');
  const deployment = { projectId: UUIDS[0], environmentId: UUIDS[1], environmentName: 'live-pr-42',
    serviceId: UUIDS[2], deploymentId: UUIDS[3] };
  const attestation = { repository: 'pbjustin/Arcanos', headRepository: 'pbjustin/Arcanos', prNumber: 42,
    commitSha: SHA, ...deployment, production: false, isolated: true, dataIsolated: true,
    credentialIsolated: true, egressRestricted: true, controllerRevision: TRUSTED_SHA,
    backendOrigin: BACKEND, brokerOrigin: BROKER };
  const approval = { version: 'arcanos-live-pr-preview/v1', approvalId: 'approval_unique_123456',
    repository: 'pbjustin/Arcanos', prNumber: 42, commitSha: SHA, issuedAtMs: NOW - 1,
    expiresAtMs: NOW + 120_000, attestationSha256: livePreviewAttestationSha256(attestation), deployment,
    limits: { ...limits }, moduleIds: [moduleId], models: [{ id: 'approved-model', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }] };
  const session = { version: 1, mode: LIVE_PREVIEW_MODE, sourceCommit: SHA, approvedSourceCommit: SHA,
    ...deployment, prNumber: 42, expiresAtMs: NOW + limits.durationMs,
    testBearer: 'arcanos-preview-' + 'd'.repeat(64), brokerBearer: 'e'.repeat(64),
    limits: { ...limits }, moduleIds: [moduleId], models: approval.models, backendOrigin: BACKEND, brokerOrigin: BROKER,
    requestTimeoutMs: 10_000 };
  const identity = { sourceCommit: SHA, approvedSourceCommit: SHA, deploymentId: deployment.deploymentId, moduleId, mode: LIVE_PREVIEW_MODE };
  const trust = { trustedRunnerSha: TRUSTED_SHA, approvalPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    trustedIsolation: { projectIds: [deployment.projectId], environmentIds: [deployment.environmentId] } };
  const files = { approval: signLivePreviewApproval(approval, keys.privateKey), attestation, trust, session,
    scenario: { version: 1, moduleId, cases: [{ caseId, sourceUrls: [SOURCE], input: moduleId === 'gaming'
      ? { mode: 'guide', game: 'Any supported game', guideUrl: SOURCE, guideUrls: [], prompt: 'Explain the supported progression in this guide.' }
      : { query: 'Explain this supported research finding.', documents: [SOURCE] } }] } };
  const expected = LIVE_PREVIEW_CASE_MANIFEST.find(entry => entry.caseId === caseId);
  const generationCalls = expected.provider === 'none' ? 0 : 1;
  const auditCalls = expected.provider === 'generation_and_audit' ? 1 : 0;
  const providerCalls = generationCalls + auditCalls;
  const usage = { requests: providerCalls + 1, providerCalls, generationCalls, auditCalls,
    reservedInputTokens: providerCalls * 100, reservedOutputTokens: providerCalls * 100,
    reservedTotalTokens: providerCalls * 200, reservedSpendMicroUsd: providerCalls * 300,
    observedInputTokens: caseId.includes('timeout') ? 0 : providerCalls * 50,
    observedOutputTokens: caseId.includes('timeout') ? 0 : providerCalls * 50,
    observedSpendMicroUsd: caseId.includes('timeout') ? 0 : providerCalls * 150, elapsedMs: 100,
    limits: { ...limits, maxConcurrency: 1, maxRetries: 0 } };
  const positive = caseId === 'useful_grounded_guide';
  const result = positive ? { ok: true, data: { response: 'A useful grounded guide cites its supplied evidence [1].',
    sources: [{ url: SOURCE, snippet: 'Supported guide details.' }],
    grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true,
      fetchedSuppliedSourceCount: 1, usableSourceCount: 1, citableSourceCount: 1,
      selectedChunkCount: 1, suppliedEvidenceSourceCount: 1 } } } : undefined;
  const audit = positive ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true }
    : caseId === 'audit_timeout' ? { assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false } : undefined;
  const evidence = createLivePreviewEvidence(identity, { caseId, failureCode: expected.failureCode,
    stages: expected.stages, usage, result, audit });
  const metadataStage = { request: 1, moduleId, stage: 'provider_metadata', model: 'approved-model', outcome: 'completed' };
  const stages = [metadataStage,
    ...(generationCalls ? [{ request: 2, moduleId, stage: 'model_generation', model: 'approved-model',
      outcome: caseId === 'model_timeout' ? 'failed' : 'completed',
      ...(caseId === 'model_timeout' ? { code: 'LIVE_PREVIEW_PROVIDER_TIMEOUT' } : {}) }] : []),
    ...(auditCalls ? [{ request: 3, moduleId, stage: 'answer_audit', model: 'approved-model',
      outcome: caseId === 'audit_timeout' ? 'failed' : 'completed',
      ...(caseId === 'audit_timeout' ? { code: 'LIVE_PREVIEW_PROVIDER_TIMEOUT' } : {}) }] : [])];
  const snapshot = values => ({ mode: 'live-backend', commitSha: SHA, deployment, expiresAtMs: session.expiresAtMs,
    limits: usage.limits, usage: { ...values, rejectedBudgetRequests: caseId === 'exhausted_budget' ? 1 : 0 },
    stages, closed: caseId.includes('timeout'), budgetExhausted: caseId === 'exhausted_budget',
    rejections: caseId === 'exhausted_budget' ? [{ moduleId, stage: 'model_generation', code: 'LIVE_PREVIEW_BUDGET_EXHAUSTED' }] : [] });
  const before = snapshot({ ...usage, requests: 1, providerCalls: 0, generationCalls: 0, auditCalls: 0,
    reservedInputTokens: 0, reservedOutputTokens: 0, reservedTotalTokens: 0, reservedSpendMicroUsd: 0,
    observedInputTokens: 0, observedOutputTokens: 0, observedSpendMicroUsd: 0, elapsedMs: 0 });
  before.stages = [metadataStage];
  before.rejections = []; before.budgetExhausted = false; before.usage.rejectedBudgetRequests = 0;
  const after = snapshot({ ...usage, elapsedMs: 101 });
  const requests = [];
  let usageReads = 0;
  const fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-arcanos-source-commit'], SHA);
    assert.equal(options.headers['x-arcanos-deployment-id'], deployment.deploymentId);
    if (url === BROKER + '/session') return Response.json(session);
    if (url === BROKER + '/usage') return Response.json(usageReads++ === 0 ? before : after);
    assert.equal(url, BACKEND + '/__preview/live/' + moduleId);
    if (caseId === 'unauthorized_test_identity') {
      assert.notEqual(options.headers.authorization, 'Bearer ' + session.testBearer);
      return Response.json({ code: 'UNAUTHORIZED_TEST_IDENTITY' }, { status: 401 });
    }
    assert.equal(options.headers.authorization, 'Bearer ' + session.testBearer);
    if (moduleId === 'gaming') assert.equal(JSON.parse(options.body).input.game, 'Any supported game');
    else assert.deepEqual(JSON.parse(options.body).input, files.scenario.cases[0].input);
    return Response.json(evidence);
  };
  const args = ['--commit-sha', SHA, '--pr-number', '42', '--backend-base-url', BACKEND, '--module-id', moduleId,
    '--case-id', caseId, '--scenario-file', 'scenario', '--session-file', 'session',
    '--approval-file', 'approval', '--attestation-file', 'attestation', '--trust-file', 'trust', '--execute', '--allow-network'];
  const dependencies = { now: () => NOW, readOperatorFile: file => JSON.stringify(files[file]),
    readGitState: () => ({ clean: true, repository: 'pbjustin/Arcanos', head: TRUSTED_SHA }), fetch };
  const resign = () => { approval.attestationSha256 = livePreviewAttestationSha256(attestation);
    files.approval = signLivePreviewApproval(approval, keys.privateKey); };
  return { args, dependencies, files, requests, evidence, before, after, session, approval, attestation, resign, identity };
}

test('default mode does not read sessions, credentials or perform network requests', async () => {
  const result = await runLivePreviewE2e(['--commit-sha', SHA, '--pr-number', '42', '--backend-base-url', BACKEND, '--module-id', 'gaming'], {
    readOperatorFile: () => { assert.fail('dry run must not read credentials'); },
    readGitState: () => { assert.fail('dry run needs no trusted checkout'); },
    fetch: () => { assert.fail('dry run must not perform network calls'); } });
  assert.equal(result.executed, false);
  assert.equal(result.caseIds.length, 8);
  assert.deepEqual(result.verification, { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' });
});

test('dry run validates every supplied scenario without admission, credentials or network access', async () => {
  const f = fixture();
  f.files.scenario.cases.push({ ...f.files.scenario.cases[0], caseId: 'unauthorized_test_identity' });
  const args = ['--commit-sha', SHA, '--pr-number', '42', '--backend-base-url', BACKEND,
    '--module-id', 'gaming', '--scenario-file', 'scenario'];
  const dependencies = {
    readOperatorFile: file => { assert.equal(file, 'scenario'); return JSON.stringify(f.files.scenario); },
    readGitState: () => { assert.fail('scenario validation needs no trusted checkout'); },
    fetch: () => { assert.fail('scenario validation must not perform network calls'); },
  };
  const result = await runLivePreviewE2e(args, dependencies);
  assert.deepEqual(result.scenarioCaseIds, ['useful_grounded_guide', 'unauthorized_test_identity']);
  assert.equal(result.verification.liveBackend, 'unverified');
  assert.equal(result.executed, false);
  f.files.scenario.cases[1].sourceUrls = [];
  await assert.rejects(runLivePreviewE2e(args, dependencies), /SCENARIO_INVALID/u);
  const selected = await runLivePreviewE2e(args.concat('--case-id', 'useful_grounded_guide'), dependencies);
  assert.deepEqual(selected.scenarioCaseIds, ['useful_grounded_guide']);
  await assert.rejects(runLivePreviewE2e(args.concat('--case-id', 'audit_timeout'), dependencies), /SCENARIO_INVALID/u);
});

test('dry run rejects malformed scenario contracts and oversized inputs before execution', async () => {
  for (const mutate of [
    scenario => { scenario.cases = []; },
    scenario => { scenario.cases.push(scenario.cases[0]); },
    scenario => { scenario.moduleId = 'research'; },
    scenario => { scenario.cases[0].sourceUrls = ['not a URL']; },
    scenario => { scenario.cases[0].input.prompt = 'x'.repeat(32 * 1024); },
  ]) {
    const f = fixture(); mutate(f.files.scenario);
    const args = ['--commit-sha', SHA, '--pr-number', '42', '--backend-base-url', BACKEND,
      '--module-id', 'gaming', '--scenario-file', 'scenario'];
    await assert.rejects(runLivePreviewE2e(args, {
      readOperatorFile: () => JSON.stringify(f.files.scenario),
      fetch: () => { assert.fail('invalid scenarios must fail before requests'); },
    }), /SCENARIO_INVALID|REQUEST_LIMIT/u);
  }
});

test('both explicit execution flags, complete inputs and finite HTTP limits are required', () => {
  const f = fixture();
  assert.throws(() => parseLivePreviewE2eArguments(f.args.filter(value => value !== '--allow-network')), /EXECUTION_FLAGS_REQUIRED/u);
  assert.throws(() => parseLivePreviewE2eArguments(f.args.slice(0, 8).concat('--execute', '--allow-network')), /EXECUTION_INPUT_REQUIRED/u);
  assert.throws(() => parseLivePreviewE2eArguments(f.args.concat('--request-timeout-ms', 'NaN')), /LIMIT_INVALID/u);
  assert.throws(() => parseLivePreviewE2eArguments(f.args.concat('--request-timeout-ms', '0')), /LIMIT_INVALID/u);
});

for (const item of LIVE_PREVIEW_CASE_MANIFEST) test(`mocked HTTP exercises ${item.caseId} and trusted resource correlation`, async () => {
  const f = fixture(item.caseId);
  const result = await runLivePreviewE2e(f.args, f.dependencies);
  assert.equal(result.verification.status, 'PASS');
  assert.equal(result.verification.accepted, item.caseId === 'useful_grounded_guide');
  assert.equal(result.httpRequests, 4);
  assert.equal(f.requests[0].url, BROKER + '/session');
  assert.equal(result.verificationStages.installedPluginOAuth, 'unverified');
  assert.equal(result.verificationStages.syntheticPreview, 'unverified');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(f.session.testBearer) && !serialized.includes(f.session.brokerBearer)
    && !serialized.includes('secret-path') && !serialized.includes('private=query') && !serialized.includes('useful grounded guide'));
});

for (const [name, modify, code] of [
  ['invalid approval signature', f => { f.files.approval.signature = 'a'.repeat(86); }, 'SIGNATURE_INVALID'],
  ['fork source repository', f => { f.attestation.headRepository = 'fork/Arcanos'; f.resign(); }, 'FORK_FORBIDDEN'],
  ['expired approval', f => { f.approval.expiresAtMs = NOW; f.resign(); }, 'APPROVAL_EXPIRED'],
  ['missing spending limit', f => { delete f.approval.limits.maxSpendMicroUsd; f.resign(); }, 'LIMITS_INVALID'],
  ['unapproved SHA', f => { f.session.sourceCommit = 'c'.repeat(40); }, 'SESSION_INVALID'],
  ['unapproved deployment', f => { f.session.deploymentId = UUIDS[0]; }, 'SESSION_INVALID'],
  ['unsigned backend target', f => { f.session.backendOrigin = 'https://other.live-pr-42.preview.example.com'; }, 'ORIGIN_MISMATCH'],
  ['unsigned broker target', f => { f.session.brokerOrigin = 'https://other.live-pr-42.preview.example.com'; }, 'ORIGIN_MISMATCH'],
  ['production target', f => { f.session.backendOrigin = 'https://production.live-pr-42.example.com'; }, 'ORIGIN_INVALID'],
  ['dirty trusted runner', f => { f.dependencies.readGitState = () => ({ clean: false }); }, 'TRUSTED_REVISION_MISMATCH'],
  ['malformed test credentials', f => { f.session.testBearer = 'real-chatgpt-oauth'; }, 'SESSION_INVALID'],
  ['unapproved module', f => { f.args[f.args.indexOf('--module-id') + 1] = 'research'; }, 'MODULE_UNAPPROVED'],
]) test(`${name} fails closed before any network request`, async () => {
  const f = fixture(); modify(f);
  await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), new RegExp(code, 'u'));
  assert.equal(f.requests.length, 0);
});

test('broker served identity mismatch fails before backend receives test bearer', async () => {
  const f = fixture();
  f.dependencies.fetch = async url => { f.requests.push(url); return Response.json({ ...f.session, sourceCommit: 'c'.repeat(40) }); };
  await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), /BROKER_IDENTITY_MISMATCH/u);
  assert.deepEqual(f.requests, [BROKER + '/session']);
});

test('HTTP200 fallback or missing audit cannot count as a useful guide', async () => {
  for (const field of ['fallback', 'audit']) {
    const f = fixture();
    if (field === 'fallback') { f.evidence.result.fallback = true; f.evidence.result.acceptedAnswer = false; }
    else f.evidence.audit.decision = 'unavailable';
    const result = await runLivePreviewE2e(f.args, f.dependencies);
    assert.equal(result.verification.status, 'FAIL');
    assert.equal(result.verificationStages.liveBackend, 'unverified');
  }
});

test('provider count fabrication and missing real timeout outcomes fail closed', async () => {
  const count = fixture(); count.after.usage.auditCalls = 0;
  await assert.rejects(runLivePreviewE2e(count.args, count.dependencies), /PROVIDER_LEDGER_INVALID/u);
  const timeout = fixture('model_timeout'); delete timeout.after.stages[1].code;
  await assert.rejects(runLivePreviewE2e(timeout.args, timeout.dependencies), /PROVIDER_TIMEOUT_UNPROVEN/u);
});

test('budget or authorization denial with unobserved provider usage fails closed', async () => {
  const budget = fixture('exhausted_budget'); budget.after.rejections = [];
  await assert.rejects(runLivePreviewE2e(budget.args, budget.dependencies), /BUDGET_DENIAL_UNPROVEN/u);
  const unauthorized = fixture('unauthorized_test_identity'); unauthorized.after.usage.providerCalls = 1;
  await assert.rejects(runLivePreviewE2e(unauthorized.args, unauthorized.dependencies), /PROVIDER_LEDGER_INVALID/u);
});

test('a source outside the operator scenario cannot become an accepted citation', async () => {
  const f = fixture(); f.evidence.result.sources[0].documentUrlSha256 = '0'.repeat(64);
  await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), /CITATION_SOURCE_MISMATCH/u);
});

test('oversized citation or source arrays fail closed rather than silently narrowing assertions', async () => {
  const citations = fixture(); citations.evidence.result.citationIndices = Array(33).fill(1);
  await assert.rejects(runLivePreviewE2e(citations.args, citations.dependencies), /EVIDENCE_INVALID/u);
  const sources = fixture(); sources.evidence.result.sources = Array(9).fill(sources.evidence.result.sources[0]);
  await assert.rejects(runLivePreviewE2e(sources.args, sources.dependencies), /EVIDENCE_INVALID/u);
});

test('module-neutral scenarios exercise the same verified profile without Gaming input assumptions', async () => {
  const f = fixture('useful_grounded_guide', 'research_analysis');
  const result = await runLivePreviewE2e(f.args, f.dependencies);
  assert.equal(result.verification.status, 'PASS');
  assert.equal(result.moduleId, 'research_analysis');
  assert.equal(result.evidence.identity.moduleId, 'research_analysis');
  assert.equal(result.evidence.acceptanceProfile, 'grounded-audited-answer-v1');
  assert.equal(result.verificationStages.installedPluginOAuth, 'unverified');
});

test('trusted requested and actual model identities remain distinct sanitized evidence', async () => {
  const f = fixture();
  f.after.stages[1].actualModel = 'approved-model-2026-10-05';
  f.after.stages[1].providerMessage = 'confidential provider body';
  const result = await runLivePreviewE2e(f.args, f.dependencies);
  assert.equal(result.verification.status, 'PASS');
  assert.deepEqual(result.observedModels[1], { moduleId: 'gaming', stage: 'model_generation',
    requestedModel: 'approved-model', actualModel: 'approved-model-2026-10-05', outcome: 'completed' });
  assert.equal(result.observedModels[0].actualModel, null);
  assert.ok(!JSON.stringify(result).includes('confidential provider body'));
});

test('invalid actual model identities and known credential injection fail closed', async () => {
  for (const actualModel of ['bad\nmodel', 'x'.repeat(257)]) {
    const f = fixture(); f.after.stages[1].actualModel = actualModel;
    await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), /PROVIDER_LEDGER_INVALID/u);
  }
  const secret = fixture(); secret.after.stages[1].actualModel = secret.session.brokerBearer;
  await assert.rejects(runLivePreviewE2e(secret.args, secret.dependencies), /LIVE_PREVIEW_SECRET_IN_EVIDENCE/u);
});

test('different modules in trusted stage or rejection ledgers cannot establish this module coverage', async () => {
  const stage = fixture(); stage.after.stages[1].moduleId = 'research';
  await assert.rejects(runLivePreviewE2e(stage.args, stage.dependencies), /PROVIDER_LEDGER_INVALID/u);
  const rejection = fixture('exhausted_budget'); rejection.after.rejections[0].moduleId = 'research';
  await assert.rejects(runLivePreviewE2e(rejection.args, rejection.dependencies), /REJECTION_LEDGER_INVALID/u);
});

test('an observed SDK cancellation plus exact timeout contract remains a bounded timeout case', async () => {
  const f = fixture('model_timeout'); f.after.stages[1].code = 'LIVE_PREVIEW_CANCELLED';
  const result = await runLivePreviewE2e(f.args, f.dependencies);
  assert.equal(result.verification.status, 'PASS');
  const closed = fixture('model_timeout'); closed.after.closed = false;
  await assert.rejects(runLivePreviewE2e(closed.args, closed.dependencies), /PROVIDER_TIMEOUT_UNPROVEN/u);
});

test('known session credential injected into a source host is rejected before evidence publication', async () => {
  const f = fixture();
  const poisonedSource = 'https://' + f.session.brokerBearer + '.example.com/';
  f.files.scenario.cases[0].sourceUrls = [poisonedSource];
  f.evidence.result.sources[0].url = poisonedSource;
  f.evidence.result.sources[0].documentUrlSha256 = createHash('sha256').update(poisonedSource).digest('hex');
  await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), /LIVE_PREVIEW_SECRET_IN_EVIDENCE/u);
});

test('timeouts and oversized bodies are bounded without retries', async () => {
  const timeout = fixture(); timeout.args.push('--request-timeout-ms', '1');
  let count = 0; timeout.dependencies.fetch = () => { count++; return new Promise(() => {}); };
  await assert.rejects(runLivePreviewE2e(timeout.args, timeout.dependencies), /REQUEST_TIMEOUT/u);
  assert.equal(count, 1);
  const huge = fixture(); huge.dependencies.fetch = async () => new Response('x'.repeat(128 * 1024 + 1),
    { headers: { 'content-type': 'application/json' } });
  await assert.rejects(runLivePreviewE2e(huge.args, huge.dependencies), /RESPONSE_LIMIT/u);
});

test('redirected responses are refused and the full response is never logged', async () => {
  const f = fixture(); f.dependencies.fetch = async () => ({ status: 200, redirected: true, body: [],
    url: 'https://production.example.com', headers: new Headers({ 'content-type': 'application/json' }) });
  await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), /RESPONSE_INVALID/u);
});

test('unsafe operator files fail without reading or fetching any live credential', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'arcanos-e2e-'));
  try {
    chmodSync(directory, 0o700);
    const file = path.join(directory, 'approval.json'); writeFileSync(file, '{}', { mode: 0o644 });
    const f = fixture(); f.args[f.args.indexOf('--approval-file') + 1] = file;
    delete f.dependencies.readOperatorFile;
    await assert.rejects(runLivePreviewE2e(f.args, f.dependencies), /OPERATOR_FILE_INVALID/u);
    assert.equal(f.requests.length, 0);
  } finally { rmSync(directory, { recursive: true }); }
});

test('offline eight-case aggregation verifies contracts without claiming live execution', async () => {
  const observations = LIVE_PREVIEW_CASE_MANIFEST.map(item => fixture(item.caseId).evidence);
  const result = await runLivePreviewE2e(['--commit-sha', SHA, '--module-id', 'gaming', '--deployment-id', UUIDS[3], '--verify-evidence', 'saved'], {
    readOperatorFile: () => JSON.stringify(observations), fetch: () => { assert.fail('offline aggregation must not fetch'); } });
  assert.equal(result.executed, false);
  assert.equal(result.suite.status, 'PASS');
  assert.equal(result.suite.code, 'LIVE_BACKEND_PREVIEW_CONTRACT_PASS');
  assert.equal(result.suite.verification.liveBackend, 'unverified');
  assert.equal(result.suite.verification.installedPluginOAuth, 'unverified');
});

test('sanitization excludes arbitrary fields, source paths and identity secrets', () => {
  const f = fixture(); f.evidence.secret = f.session.brokerBearer;
  f.evidence.audit.providerBody = 'confidential'; f.evidence.result.response = 'secret-answer';
  const safe = sanitizeLivePreviewEvidence(f.evidence);
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes('confidential') && !serialized.includes('secret-answer') && !serialized.includes(f.session.brokerBearer));
  assert.equal(safe.result.sources[0].url, 'https://guides.example.com/');
  assert.match(safe.result.sources[0].documentUrlSha256, /^[0-9a-f]{64}$/u);
});
