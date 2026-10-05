import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLiveValidationControllerArguments, runLiveValidationController, validateLiveValidationArtifact,
  normalizeLiveValidationInventory, assertLiveValidationDeployment, createLiveValidationRailwayApi,
  cleanupLiveValidationRun, sanitizeLiveValidationUsage, validateLiveValidationOperatorArtifact,
  LIVE_VALIDATION_OPERATOR_GATE_IDS, LIVE_VALIDATION_ACCEPTANCE_TRANSPORT_TIMEOUT_MS } from './live-validation-controller.mjs';
import { LIVE_VALIDATION_PROJECT_ID, LIVE_VALIDATION_HARD_LIMITS, LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID,
  LIVE_VALIDATION_QUOTA_LEDGER_MOUNT } from './live-validation-target.mjs';
import { liveValidationTargetSha256, canonicalLiveValidationJson } from './live-validation-policy.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_CASE_MANIFEST } from './live-pr-preview-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = 'a'.repeat(40); const trustedSha = 'b'.repeat(40);
const envId = '11111111-1111-4111-8111-111111111111';
const runtimeId = '22222222-2222-4222-8222-222222222222';
const supervisorId = '33333333-3333-4333-8333-333333333333';
const volumeId = '44444444-4444-4444-8444-444444444444';
const runtimeDeploymentId = '55555555-5555-4555-8555-555555555555';
const supervisorDeploymentId = '66666666-6666-4666-8666-666666666666';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => hash(canonicalLiveValidationJson(value));
const profiles = JSON.parse(readFileSync(path.join(ROOT, 'examples/live-validation/profiles.json'), 'utf8'));
const git = { head: trustedSha, clean: true, repository: 'pbjustin/Arcanos' };
function targetFixture() {
  return { version: 'arcanos-live-validation-target/v1', repository: 'pbjustin/Arcanos', projectId: LIVE_VALIDATION_PROJECT_ID,
    environmentId: envId, environmentName: 'live-validation', runtimeServiceId: runtimeId, supervisorServiceId: supervisorId,
    privateOrigins: { runtime: 'https://runtime.railway.internal:8443', supervisor: 'https://supervisor.railway.internal:8443' },
    mtlsPeers: { runtime: { dns: 'runtime.railway.internal', sha256: 'a'.repeat(64) },
      supervisor: { dns: 'supervisor.railway.internal', sha256: 'b'.repeat(64) }, verifier: { dns: 'verifier.railway.internal', sha256: 'c'.repeat(64) } },
    trustedSupervisorSha: trustedSha, limits: { ...LIVE_VALIDATION_HARD_LIMITS },
    models: ['ft:gpt-4.1:arcanos:authority:test', 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: 1.25, outputMicroUsdPerToken: 5 })), writes: false };
}
function deployment(target, role, sourceCommit, id = role === 'runtime' ? runtimeDeploymentId : supervisorDeploymentId) {
  return { id, projectId: target.projectId, environmentId: target.environmentId, serviceId: target[`${role}ServiceId`],
    status: 'SUCCESS', deploymentStopped: false, meta: { repo: target.repository, commitHash: sourceCommit } };
}
const connection = items => ({ pageInfo: { hasNextPage: false }, edges: items.map(node => ({ node })) });
function inventory(target, runtimeActive = false, stopped = false) {
  return { projectToken: { projectId: target.projectId, environmentId: target.environmentId },
    environment: { id: target.environmentId, projectId: target.projectId, name: 'live-validation', deletedAt: null,
      config: { privateNetworkDisabled: false, services: Object.fromEntries(['runtime', 'supervisor'].map(role => [target[`${role}ServiceId`], {
        source: { repo: target.repository, branch: 'main' }, variables: {} }])), sharedVariables: {} },
      serviceInstances: connection(['runtime', 'supervisor'].map(role => ({ id: target[`${role}ServiceId`],
        serviceId: target[`${role}ServiceId`], environmentId: target.environmentId, deletedAt: null,
        latestDeployment: deployment(target, role, role === 'runtime' ? sha : trustedSha),
        domains: { serviceDomains: [], customDomains: [] }, activeDeployments: role === 'runtime'
          ? runtimeActive && !stopped ? [deployment(target, role, sha)] : [] : [deployment(target, role, trustedSha)] }))),
      deploymentTriggers: connection([]), variables: connection([]),
      volumeInstances: connection([{ id: volumeId, volumeId, environmentId: target.environmentId,
        serviceId: target.supervisorServiceId, mountPath: LIVE_VALIDATION_QUOTA_LEDGER_MOUNT, deletedAt: null }]) },
    privateNetworks: [{ projectId: target.projectId, environmentId: target.environmentId, deletedAt: null }], runtimeTcp: [], supervisorTcp: [] };
}
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'arcanos-controller-test-')); chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = targetFixture(); const artifactDirectory = path.join(directory, 'artifacts'); mkdirSync(artifactDirectory, { mode: 0o700 });
  writeFileSync(path.join(artifactDirectory, 'source.tar'), 'opaque-source'); writeFileSync(path.join(artifactDirectory, 'build.tar'), 'opaque-build');
  const manifest = { version: 1, repository: target.repository, sourceCommit: sha, prNumber: 1527, profile: 'gaming-guide',
    workflowRunId: '1234', workflowRunAttempt: 1, controllerRevision: trustedSha,
    files: { 'source.tar': hash('opaque-source'), 'build.tar': hash('opaque-build') } };
  const raw = JSON.stringify(manifest) + '\n'; writeFileSync(path.join(artifactDirectory, 'candidate-attestation.json'), raw);
  const binding = { ...manifest, artifactId: '5678', artifactDigest: 'sha256:' + 'd'.repeat(64), attestationSha256: hash(raw) };
  const targetFile = path.join(directory, 'target.json'); const artifactFile = path.join(directory, 'binding.json');
  writeFileSync(targetFile, JSON.stringify(target), { mode: 0o600 }); writeFileSync(artifactFile, JSON.stringify(binding), { mode: 0o600 });
  const signingKey = path.join(directory, 'signing-key.pem');
  writeFileSync(signingKey, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const environment = { WORKFLOW_RUN_ID: '1234', WORKFLOW_RUN_ATTEMPT: '1', CONTROLLER_REVISION: trustedSha, GITHUB_ACTOR: 'maintainer',
    GITHUB_TOKEN: 'fixture-github-token', RAILWAY_LIVE_VALIDATION_TOKEN: 'fixture-railway-token',
    LIVE_VALIDATION_ARTIFACT_DIRECTORY: artifactDirectory, LIVE_VALIDATION_APPROVAL_SIGNING_KEY_FILE: signingKey };
  const argv = ['--target-file', targetFile, '--artifact-attestation-file', artifactFile, '--pr-number', '1527', '--commit-sha', sha,
    '--profile', 'gaming-guide', '--evidence-dir', path.join(directory, 'evidence')];
  return { directory, target, binding, artifactDirectory, targetFile, artifactFile, argv, environment };
}
function ghFixture(f, { moveHead = false, checkFailure = false } = {}) {
  let prReads = 0;
  return { async get(route) {
    if (route === '/user') return { login: 'maintainer' };
    if (route.endsWith('/pulls/1527')) return { state: 'open', draft: false,
      head: { sha: moveHead && ++prReads > 1 ? 'c'.repeat(40) : sha, repo: { full_name: 'pbjustin/Arcanos' } },
      base: { ref: 'main', sha: trustedSha, repo: { full_name: 'pbjustin/Arcanos' } } };
    if (route.endsWith('/permission')) return { permission: 'maintain' };
    if (route.endsWith('/actions/runs/1234')) return { id: 1234, event: 'workflow_dispatch', run_attempt: 1, head_sha: trustedSha,
      head_branch: 'main', path: '.github/workflows/live-pr-acceptance.yml', repository: { full_name: 'pbjustin/Arcanos' }, actor: { login: 'maintainer' } };
    if (route.endsWith('/actions/artifacts/5678')) return { id: 5678, expired: false, name: 'live-validation-candidate-1234-1',
      digest: f.binding.artifactDigest, workflow_run: { id: 1234, head_sha: trustedSha } };
    if (route.includes('/check-runs?')) return { total_count: 2, check_runs: ['All Checks Complete', 'docs:check'].map(name => ({
      name, head_sha: sha, status: 'completed', conclusion: checkFailure ? 'failure' : 'success', app: { slug: 'github-actions' } })) };
    if (route.includes('/jobs?')) return { total_count: 1, jobs: [{ id: 99, name: 'Validate exact candidate without live credentials',
      status: 'completed', conclusion: 'success', head_sha: trustedSha }] };
    throw new Error('Unexpected mock GitHub route');
  } };
}
function observedIdentity(target, role) {
  return { role, sourceCommit: role === 'runtime' ? sha : trustedSha, projectId: target.projectId,
    environmentId: target.environmentId, serviceId: target[`${role}ServiceId`],
    deploymentId: role === 'runtime' ? runtimeDeploymentId : supervisorDeploymentId, buildManifestSha256: role === 'runtime' ? 'e'.repeat(64) : 'f'.repeat(64) };
}
function evidenceFor(entry) {
  const positive = entry.id.endsWith('positive'); const spec = LIVE_PREVIEW_CASE_MANIFEST.find(item => item.caseId === entry.caseId);
  const limits = { maxRequests: 32, maxInputTokensPerRequest: 1_000, maxOutputTokensPerRequest: 300,
    maxTotalTokens: 20_000, durationMs: 600_000, maxSpendMicroUsd: 2_000_000, maxConcurrency: 1, maxRetries: 0 };
  return createLivePreviewEvidence({ sourceCommit: sha, approvedSourceCommit: sha, deploymentId: runtimeDeploymentId, moduleId: 'gaming', mode: 'live-backend-v1' }, {
    caseId: entry.caseId, failureCode: spec.failureCode, stages: spec.stages,
    result: positive ? { ok: true, route: 'gaming', mode: 'guide', data: { response: 'Use the supplied documented blade path [1].',
      sources: [{ url: entry.input.candidateUrls[0], snippet: 'Grounded preparation and blade guidance.' }],
      grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true, fetchedSuppliedSourceCount: 1,
        usableSourceCount: 1, citableSourceCount: 1, selectedChunkCount: 1, suppliedEvidenceSourceCount: 1 } } } : undefined,
    audit: positive ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true }
      : { assessmentStatus: 'not_run', decision: 'unavailable', boundToFinalAnswer: false },
    usage: { requests: positive ? 2 : 0, providerCalls: positive ? 2 : 0, generationCalls: positive ? 1 : 0, auditCalls: positive ? 1 : 0,
      reservedInputTokens: positive ? 1_800 : 0, reservedOutputTokens: positive ? 400 : 0, reservedTotalTokens: positive ? 2_200 : 0,
      reservedSpendMicroUsd: positive ? 10_000 : 0, observedInputTokens: positive ? 600 : 0, observedOutputTokens: positive ? 100 : 0,
      observedSpendMicroUsd: positive ? 4_000 : 0, elapsedMs: 100, limits } });
}
function executionFixture(f, options = {}) {
  const calls = []; let deployed = false; let stopped = false; let closed = false; let plan; let workflows = 0; let providerCalls = 0;
  const identity = role => observedIdentity(f.target, role);
  const railway = { async inventory() { calls.push('inventory'); return inventory(f.target, deployed, stopped); },
    async deploy(target, role, sourceCommit) { calls.push(['deploy', role, sourceCommit]); assert.equal(role, 'runtime'); assert.equal(sourceCommit, sha); deployed = true; return runtimeDeploymentId; },
    async deployment(id) { const role = id === runtimeDeploymentId ? 'runtime' : 'supervisor'; return { ...deployment(f.target, role, role === 'runtime' ? sha : trustedSha), deploymentStopped: role === 'runtime' && stopped,
      ...(options.wrongDeployment && role === 'runtime' ? { meta: { repo: f.target.repository, commitHash: 'c'.repeat(40) } } : {}) }; },
    async stop(id) { calls.push(['stop', id]); assert.equal(id, runtimeDeploymentId); stopped = true; } };
  const usage = () => ({ runId: plan.runId, commitSha: sha, prNumber: 1527, runtimeDeploymentId, profileHash: plan.profileHash,
    status: closed ? 'stopped' : 'active', limits: { ...f.target.limits, maxConcurrency: 1, maxRetries: 0 }, counts: { workflows },
    usage: { requests: providerCalls, metadataRequests: 0, providerCalls, generationCalls: providerCalls / 2, auditCalls: providerCalls / 2,
      reservedInputTokens: providerCalls * 900, reservedOutputTokens: providerCalls * 200, reservedTotalTokens: providerCalls * 1100,
      reservedSpendMicroUsd: providerCalls * 5000, observedInputTokens: providerCalls * 300, observedOutputTokens: providerCalls * 50,
      observedTotalTokens: providerCalls * 350, observedSpendMicroUsd: providerCalls * 2000 } });
  function client(role) { return { async requestJSON(route, request = {}) {
    calls.push([role, route]); let body;
    if (route === '/ready') body = { ...identity(role), readiness: { providerCallsEnabled: false, ...(role === 'supervisor' ? { modelCredentialBound: true } : {}) } };
    else if (route === '/handshake') body = { challenge: request.body.challenge, runtime: identity('runtime'), supervisor: identity('supervisor'), channel: 'mtls-private', verified: !options.badHandshake };
    else if (route === '/runs') { plan = request.body.plan; body = { runId: plan.runId, brokerBearer: 'x'.repeat(64), testBearer: 'y'.repeat(64), expiresAtMs: plan.expiresAtMs }; }
    else if (route === '/admit') body = { admitted: true, runId: plan.runId };
    else if (route.endsWith('/begin')) { workflows++; body = { caseId: route.split('/').at(-2) }; }
    else if (route.endsWith('/end')) body = { completed: true };
    else if (route === '/acceptance') {
      assert.equal(request.headers['x-arcanos-source-commit'], sha); assert.equal(request.headers['x-arcanos-deployment-id'], runtimeDeploymentId);
      assert.equal(request.headers['x-arcanos-live-run-id'], plan.runId);
      const entry = profiles.profiles.find(item => item.id === request.body.caseId); assert.deepEqual(request.body.input, entry.input);
      if (entry.id.endsWith('positive') || options.negativeProvider) providerCalls += 2;
      const evidence = evidenceFor(entry);
      if (options.unboundAudit && entry.id.endsWith('positive')) evidence.audit.boundToFinalAnswer = false;
      if (options.auditTimeout && entry.id.endsWith('positive')) {
        evidence.audit.assessmentStatus = 'unavailable'; evidence.audit.decision = 'unavailable'; evidence.audit.boundToFinalAnswer = false;
        evidence.stages.answer_audit = 'timed_out';
      }
      if (options.wrongSource && entry.id.endsWith('positive')) evidence.result.sources[0].documentUrlSha256 = 'c'.repeat(64);
      if (options.injectBearer && entry.id.endsWith('positive')) evidence.result.sources[0].url = 'https://' + 'x'.repeat(64) + '.example.com/';
      body = { identity: identity('runtime'), caseId: entry.id, evidence, profilePassed: !options.auditTimeout, productionChanged: false, durableWrites: 0,
        observation: { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: entry.expected.outcome, semanticGap: entry.expected.semanticGap,
          coverage: { satisfied: true, assessmentStatus: 'assessed', missingCount: 0 }, selectedEvidenceCount: 1, selectedCandidateCount: 1,
          audit: options.auditTimeout ? { assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false }
            : { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true },
          auditStartBudget: { runtimeRemainingMs: 11_000, requestRemainingMs: 100 },
          arbitraryPayload: 'never-publish-private-content',
          qualification: { visible: true, patchCompatibility: 'unverified', claimsVerifiedCurrentness: false },
          stages: Object.fromEntries(['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response']
            .map(stage => [stage, { status: options.auditTimeout && stage === 'answer_audit' ? 'timed_out' : 'passed', elapsedMs: 1 }])) } };
    } else if (route.endsWith('/stop')) { closed = true; body = { runId: plan?.runId ?? route.split('/')[2], status: 'stopped' }; }
    else if (route.endsWith('/usage')) body = usage();
    else throw new Error('Unexpected mock private route');
    return { status: 200, body };
  } }; }
  return { calls, dependencies: { environment: f.environment, repositoryRoot: ROOT, readGitState: () => git, now: () => 1_000,
    createGitHubApi: () => ghFixture(f, options), createRailwayApi: () => railway,
    createPrivateClient: ({ serverIdentity }) => client(serverIdentity.role) } };
}

test('CLI requires paired explicit paid flags and caps every request, workflow, spend and duration', t => {
  const f = fixture(t); assert.equal(parseLiveValidationControllerArguments(f.argv).execute, false);
  for (const extra of [['--execute'], ['--allow-paid-provider'], ['--max-provider-requests', '33'], ['--max-workflows', '3'],
    ['--max-spend-micro-usd', '2000001'], ['--duration-ms', '600001'], ['--commit-sha', '`danger`']])
    assert.throws(() => parseLiveValidationControllerArguments([...f.argv, ...extra]));
});
test('default offline preflight performs no GitHub, Railway, TLS, provider or deployment calls', async t => {
  const f = fixture(t); const network = () => { throw new Error('A network factory was invoked'); };
  const result = await runLiveValidationController(f.argv, { environment: f.environment, readGitState: () => git,
    createGitHubApi: network, createRailwayApi: network, createPrivateClient: network });
  assert.equal(result.code, 'LIVE_VALIDATION_OFFLINE_PREFLIGHT_PASS'); assert.equal(result.paidProviderEnabled, false);
});
function operatorBinding(f) {
  return { version: 'arcanos-live-validation-operator-bootstrap/v1', repository: f.target.repository, sourceCommit: sha,
    prNumber: 1527, profile: 'gaming-guide', trustedControllerSha: trustedSha, files: f.binding.files,
    offlineGateRecords: LIVE_VALIDATION_OPERATOR_GATE_IDS.map(gate => ({ gate, status: 'PASS', commitSha: sha, evidenceSha256: hash(gate) })) };
}
test('explicit operator bootstrap supports premerge offline and paid CLI without inventing a GitHub Actions run', async t => {
  const f = fixture(t); writeFileSync(f.artifactFile, JSON.stringify(operatorBinding(f)));
  const mock = executionFixture(f); const original = mock.dependencies.createGitHubApi;
  const githubRoutes = []; mock.dependencies.createGitHubApi = () => {
    const api = original(); return { get(route) { githubRoutes.push(route); return api.get(route); } };
  };
  const offline = await runLiveValidationController([...f.argv, '--operator-bootstrap'], mock.dependencies);
  assert.equal(offline.artifactAuthority, 'operator_bootstrap'); assert.equal(githubRoutes.length, 0);
  await assert.rejects(runLiveValidationController(f.argv, mock.dependencies), { code: 'LIVE_VALIDATION_ARTIFACT_BINDING_INVALID' });
  const result = await runLiveValidationController([...f.argv, '--operator-bootstrap', '--execute', '--allow-paid-provider'], mock.dependencies);
  assert.equal(result.status, 'PASS'); assert.equal(result.artifactAuthority, 'operator_bootstrap');
  assert.ok(githubRoutes.includes('/user')); assert.equal(githubRoutes.some(route => route.includes('/actions/')), false);
  assert.equal(JSON.stringify(result).includes('workflowRunId'), false);
});
test('operator approval is commit-bound, requires every successful offline gate, and cannot replace normal workflow provenance', t => {
  const f = fixture(t); const binding = operatorBinding(f);
  const options = { args: parseLiveValidationControllerArguments([...f.argv, '--operator-bootstrap']), git,
    directory: f.artifactDirectory, raw: JSON.stringify(binding) };
  assert.equal(validateLiveValidationOperatorArtifact(binding, options).artifactAuthority, 'operator_bootstrap');
  for (const mutate of [value => { value.trustedControllerSha = sha; }, value => { value.sourceCommit = trustedSha; },
    value => { value.offlineGateRecords.pop(); }, value => { value.offlineGateRecords[0].status = 'FAIL'; },
    value => { value.offlineGateRecords[0].commitSha = trustedSha; }, value => { value.offlineGateRecords[0].evidenceSha256 = '0'.repeat(64); }]) {
    const changed = structuredClone(binding); mutate(changed); assert.throws(() => validateLiveValidationOperatorArtifact(changed, options));
  }
});
test('artifact hashes are independently recomputed and SHA, controller, attempts, symlinks and byte drift reject', t => {
  const f = fixture(t); const options = { args: parseLiveValidationControllerArguments(f.argv), git, directory: f.artifactDirectory, environment: f.environment };
  assert.equal(validateLiveValidationArtifact(f.binding, options).sourceCommit, sha);
  for (const change of [{ sourceCommit: 'c'.repeat(40) }, { controllerRevision: 'c'.repeat(40) }, { workflowRunAttempt: 2 }])
    assert.throws(() => validateLiveValidationArtifact({ ...f.binding, ...change }, options));
  writeFileSync(path.join(f.artifactDirectory, 'source.tar'), 'drift'); assert.throws(() => validateLiveValidationArtifact(f.binding, options), { code: 'LIVE_VALIDATION_ARTIFACT_DIGEST_MISMATCH' });
  rmSync(path.join(f.artifactDirectory, 'source.tar')); symlinkSync(f.targetFile, path.join(f.artifactDirectory, 'source.tar'));
  assert.throws(() => validateLiveValidationArtifact(f.binding, options), { code: 'LIVE_VALIDATION_ARTIFACT_INVALID' });
});
test('production targets fail before admission or any network factory', async t => {
  const f = fixture(t); f.target.environmentId = LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID;
  writeFileSync(f.targetFile, JSON.stringify(f.target)); let calls = 0;
  await assert.rejects(runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], { environment: f.environment,
    readGitState: () => git, createGitHubApi: () => { calls++; } }), { code: 'LIVE_VALIDATION_TARGET_PROTECTED' }); assert.equal(calls, 0);
});
test('inventory refuses incomplete pages, shared vars, external routes, missing ledger, extra services and source branch assertions', t => {
  const f = fixture(t); assert.equal(normalizeLiveValidationInventory(f.target, inventory(f.target)).inventory.services.length, 2);
  for (const mutate of [raw => { raw.environment.variables.pageInfo.hasNextPage = true; },
    raw => { raw.environment.variables = connection([{ name: 'OPENAI_API_KEY', environmentId: envId, serviceId: null }]); },
    raw => { raw.environment.config.sharedVariables.INHERITED_MODEL_KEY = { value: 'never-read-or-print' }; },
    raw => { raw.environment.config.privateNetworkDisabled = true; },
    raw => { raw.runtimeTcp.push({ id: volumeId, environmentId: envId, serviceId: runtimeId }); },
    raw => { raw.environment.volumeInstances = connection([]); },
    raw => { raw.environment.config.services[volumeId] = {}; },
    raw => { delete raw.environment.serviceInstances.edges[0].node.latestDeployment.meta.commitHash;
      raw.environment.serviceInstances.edges[0].node.latestDeployment.meta.message = sha;
      raw.environment.config.services[runtimeId].source.branch = 'main'; },
    raw => { raw.projectToken.environmentId = LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID; }]) {
    const raw = inventory(f.target); mutate(raw); assert.throws(() => normalizeLiveValidationInventory(f.target, raw));
  }
});
test('actual deployment UUID, environment, service and meta.commitHash prove exact SHA, never a message or branch', t => {
  const f = fixture(t); const valid = deployment(f.target, 'runtime', sha);
  assert.equal(assertLiveValidationDeployment(valid, f.target, 'runtime', sha).id, runtimeDeploymentId);
  for (const changed of [{ ...valid, meta: { repo: f.target.repository, commitHash: trustedSha, message: sha } },
    { ...valid, serviceId: supervisorId }, { ...valid, environmentId: LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID },
    { ...valid, status: 'BUILDING' }]) assert.throws(() => assertLiveValidationDeployment(changed, f.target, 'runtime', sha));
});
test('predeploy accepts a genuinely fresh service, but never a branch-only or hidden active deployment as observed SHA', t => {
  const f = fixture(t); const raw = inventory(f.target);
  for (const edge of raw.environment.serviceInstances.edges) { edge.node.latestDeployment = null; edge.node.activeDeployments = []; }
  assert.deepEqual(normalizeLiveValidationInventory(f.target, raw, { phase: 'predeploy' }).inventory.services.map(item => item.source.commitSha), [null, null]);
  assert.throws(() => normalizeLiveValidationInventory(f.target, raw));
  raw.environment.serviceInstances.edges[0].node.activeDeployments = [deployment(f.target, 'runtime', sha)];
  assert.throws(() => normalizeLiveValidationInventory(f.target, raw, { phase: 'predeploy' }), { code: 'LIVE_VALIDATION_DEPLOYMENT_METADATA_INVALID' });
});
test('GitHub failed offline gates and paid workflow reruns block before deploy or admission', async t => {
  const f = fixture(t); const mock = executionFixture(f, { checkFailure: true });
  await assert.rejects(runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies), { code: 'LIVE_VALIDATION_REQUIRED_CHECK_FAILED' });
  assert.equal(mock.calls.length, 0);
  f.environment.WORKFLOW_RUN_ATTEMPT = '2';
  await assert.rejects(runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies), { code: 'LIVE_VALIDATION_RERUN_FORBIDDEN' });
  assert.equal(mock.calls.length, 0);
});
test('moved PR head after deploy or failed runtime handshake rejects before paid admission and stops only the created runtime', async t => {
  for (const options of [{ moveHead: true }, { badHandshake: true }, { wrongDeployment: true }]) {
    const f = fixture(t); const mock = executionFixture(f, options);
    const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies);
    assert.equal(result.status, 'BLOCKED'); assert.equal(mock.calls.some(call => Array.isArray(call) && call[1] === '/runs'), false);
    assert.deepEqual(mock.calls.filter(call => Array.isArray(call) && call[0] === 'stop'), [['stop', runtimeDeploymentId]]);
  }
});
test('complete mocked live flow checks both cases, real supervisor usage, source hashes and always revokes/stops without leaking bearers', async t => {
  const f = fixture(t); const mock = executionFixture(f);
  const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies);
  assert.equal(result.status, 'PASS', JSON.stringify(result)); assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases.map(item => item.actualUsage.providerCalls), [2, 0]);
  assert.equal(result.cleanup.status, 'PASS'); assert.equal(result.actualUsage.providerCalls, 2);
  assert.equal(mock.calls.some(call => Array.isArray(call) && call[1]?.endsWith('/stop')), true);
  const publicOutput = readFileSync(path.join(f.directory, 'evidence', 'acceptance-summary.json'), 'utf8');
  assert.equal(publicOutput.includes('x'.repeat(64)), false); assert.equal(publicOutput.includes('y'.repeat(64)), false);
  assert.equal(publicOutput.includes('supplied documented blade'), false);
  const privateState = JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'controller-state.private.json'), 'utf8'));
  assert.equal(privateState.session, null); assert.equal(privateState.cleanupComplete, true);
  await assert.rejects(runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies), { code: 'LIVE_VALIDATION_RUN_REPLAY_FORBIDDEN' });
  const inventoryReads = mock.calls.filter(call => call === 'inventory').length;
  const cleaned = await runLiveValidationController(['cleanup', ...f.argv.filter((_, index) => ![2, 3].includes(index))], mock.dependencies);
  assert.equal(cleaned.status, 'PASS');
  assert.ok(mock.calls.filter(call => call === 'inventory').length > inventoryReads, 'Repeated cleanup needs fresh scoped platform readback');
});
test('only acceptance gets the larger transport ceiling and every live request is capped by the remaining signed run', async t => {
  for (const elapsedAfterAdmission of [0, 400_000]) {
    const f = fixture(t); const mock = executionFixture(f); let clock = 1_000;
    mock.dependencies.now = () => clock;
    const createPrivate = mock.dependencies.createPrivateClient; const requests = []; const ceilings = [];
    mock.dependencies.createPrivateClient = options => {
      ceilings.push({ role: options.serverIdentity.role, timeoutMs: options.timeoutMs });
      const client = createPrivate(options);
      return { async requestJSON(route, request = {}) {
        requests.push({ route, timeoutMs: request.timeoutMs, remainingMs: 601_000 - clock });
        const result = await client.requestJSON(route, request);
        if (route === '/admit') clock += elapsedAfterAdmission;
        return result;
      } };
    };
    const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(ceilings, [{ role: 'supervisor', timeoutMs: 60_000 },
      { role: 'runtime', timeoutMs: LIVE_VALIDATION_ACCEPTANCE_TRANSPORT_TIMEOUT_MS }]);
    const acceptance = requests.filter(request => request.route === '/acceptance'); assert.equal(acceptance.length, 2);
    assert.ok(acceptance.every(request => request.timeoutMs === Math.min(315_000, request.remainingMs)));
    assert.ok(requests.filter(request => request.route !== '/acceptance').every(request => request.timeoutMs <= 60_000));
    assert.ok(requests.every(request => request.timeoutMs <= request.remainingMs));
  }
});
test('forged runtime PASS cannot replace bound answer audit, approved document digest or actual negative-case zero-provider usage', async t => {
  for (const options of [{ unboundAudit: true }, { wrongSource: true }, { negativeProvider: true }]) {
    const f = fixture(t); const mock = executionFixture(f, options);
    const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies);
    assert.equal(result.status, 'FAILED'); assert.equal(result.cleanup.status, 'PASS');
    assert.ok(['LIVE_VALIDATION_PROFILE_EVIDENCE_FAILED', 'LIVE_VALIDATION_SUPPLIED_SOURCE_BINDING_FAILED', 'LIVE_VALIDATION_ACTUAL_PROVIDER_USAGE_FAILED'].includes(result.code), result.code);
  }
});
test('failed mandatory answer audit preserves sanitized exact-SHA diagnostics, stage timings, start budgets and actual usage', async t => {
  const f = fixture(t); const mock = executionFixture(f, { auditTimeout: true });
  const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies);
  assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_FAILED');
  assert.equal(result.observedCases.length, 1); assert.equal(result.runtimeIdentity.sourceCommit, sha);
  const observed = result.observedCases[0]; assert.equal(observed.status, 'FAILED');
  assert.equal(observed.evidence.audit.assessmentStatus, 'unavailable'); assert.equal(observed.evidence.audit.boundToFinalAnswer, false);
  assert.equal(observed.observation.stages.answer_audit.status, 'timed_out');
  assert.deepEqual(observed.observation.auditStartBudget, { runtimeRemainingMs: 11000, requestRemainingMs: 100 });
  assert.equal(result.actualUsage.providerCalls, 2); assert.equal(result.usageReadback, 'PASS'); assert.equal(result.cleanup.status, 'PASS');
  assert.equal(JSON.stringify(result).includes('never-publish-private-content'), false);
  assert.equal(JSON.stringify(result).includes('x'.repeat(64)), false);
});
test('candidate diagnostic strings cannot publish a current session bearer through a source origin', async t => {
  const f = fixture(t); const mock = executionFixture(f, { injectBearer: true });
  const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], mock.dependencies);
  assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_EVIDENCE_SECRET_REJECTED');
  assert.equal(JSON.stringify(result).includes('x'.repeat(64)), false);
  assert.equal(readFileSync(path.join(f.directory, 'evidence', 'acceptance-summary.json'), 'utf8').includes('x'.repeat(64)), false);
  assert.equal(result.cleanup.status, 'PASS');
});
test('cleanup refuses a target-swapped or foreign deployment state, and never calls remove/delete operations', async t => {
  const f = fixture(t); const args = parseLiveValidationControllerArguments(f.argv);
  const state = { version: 'arcanos-live-validation-controller-state/v1', targetHash: liveValidationTargetSha256(f.target),
    prNumber: 1527, commitSha: sha, runId: 'a'.repeat(32), runtimeDeploymentId, supervisorDeploymentId,
    runtimeCreated: true, session: null, completed: false, cleanupComplete: false };
  let stops = 0;
  const railway = { async inventory() { return inventory(f.target); }, async deployment() { return { ...deployment(f.target, 'runtime', sha), serviceId: supervisorId }; }, async stop() { stops++; } };
  const result = await cleanupLiveValidationRun({ target: f.target, args, state, railway, writeState() {} });
  assert.equal(result.status, 'FAIL'); assert.equal(stops, 0);
  await assert.rejects(cleanupLiveValidationRun({ target: f.target, args, state: { ...state, targetHash: 'c'.repeat(64) }, railway, writeState() {} }), { code: 'LIVE_VALIDATION_CLEANUP_STATE_INVALID' });
  const wrongScope = { ...railway, async inventory() { const raw = inventory(f.target); raw.projectToken.environmentId = LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID; return raw; } };
  await cleanupLiveValidationRun({ target: f.target, args, state, railway: wrongScope, writeState() {} }); assert.equal(stops, 0);
});
test('Railway client uses project-environment credentials, metadata-only variables and precise deploy/stop mutations', async t => {
  const f = fixture(t); const calls = [];
  const api = createLiveValidationRailwayApi({ token: 'dedicated-project-token', async fetchImplementation(url, options) {
    calls.push({ url, ...options, body: JSON.parse(options.body) }); const query = calls.at(-1).body.query;
    const data = query.includes('serviceInstanceDeployV2') ? { serviceInstanceDeployV2: runtimeDeploymentId }
      : query.includes('deploymentStop') ? { deploymentStop: true } : query.includes('LiveValidationDeployment') ? { deployment: deployment(f.target, 'runtime', sha) } : inventory(f.target);
    return { ok: true, headers: new Headers(), async text() { return JSON.stringify({ data }); } };
  } });
  await api.inventory(f.target); await api.deploy(f.target, 'runtime', sha); await api.deployment(runtimeDeploymentId); await api.stop(runtimeDeploymentId);
  assert.equal(calls[0].headers['Project-Access-Token'], 'dedicated-project-token'); assert.equal(calls[0].headers.authorization, undefined);
  assert.match(calls[0].body.query, /config\(decryptVariables:false\)/u);
  assert.doesNotMatch(calls[0].body.query, /\bvalue\b|decryptVariables:true/u);
  assert.deepEqual(calls[1].body.variables, { environmentId: envId, serviceId: runtimeId, commitSha: sha });
  assert.equal(calls.some(call => /environmentDelete|serviceDelete|deploymentRemove|volumeDelete/u.test(call.body.query)), false);
});
test('usage rejects exceeding spend or negative counts rather than trusting runtime-local counters', t => {
  const f = fixture(t); const plan = { runId: 'a'.repeat(32), commitSha: sha, prNumber: 1527, runtimeDeploymentId, profileHash: canonicalHash(profiles) };
  const value = { ...plan, status: 'active', limits: { ...f.target.limits, maxConcurrency: 1, maxRetries: 0 }, counts: { workflows: 0 },
    usage: Object.fromEntries(['requests', 'metadataRequests', 'providerCalls', 'generationCalls', 'auditCalls', 'reservedInputTokens', 'reservedOutputTokens',
      'reservedTotalTokens', 'reservedSpendMicroUsd', 'observedInputTokens', 'observedOutputTokens', 'observedTotalTokens', 'observedSpendMicroUsd'].map(key => [key, 0])) };
  assert.equal(sanitizeLiveValidationUsage(value, { plan, target: f.target }).providerCalls, 0);
  value.usage.reservedSpendMicroUsd = 2_000_001; assert.throws(() => sanitizeLiveValidationUsage(value, { plan, target: f.target }));
});
