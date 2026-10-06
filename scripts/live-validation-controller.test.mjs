import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseLiveValidationControllerArguments, runLiveValidationController, validateLiveValidationArtifact,
  normalizeLiveValidationInventory, assertLiveValidationDeployment, createLiveValidationRailwayApi,
  cleanupLiveValidationRun, sanitizeLiveValidationObservation, sanitizeLiveValidationUsage, validateLiveValidationOperatorArtifact,
  LIVE_VALIDATION_OPERATOR_GATE_IDS, resolveLiveValidationSelection, createLiveValidationServiceClient } from './live-validation-controller.mjs';
import { LIVE_VALIDATION_PROJECT_ID, LIVE_VALIDATION_HARD_LIMITS, LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID } from './live-validation-target.mjs';
import { canonicalLiveValidationJson, validationHash } from './live-validation-bootstrap.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_CASE_MANIFEST } from './live-pr-preview-verifier.mjs';
import { createLiveValidationProvider } from './live-validation-provider.mjs';

const ROOT = path.resolve(new URL('../', import.meta.url).pathname);
const sha = 'a'.repeat(40); const trustedSha = 'b'.repeat(40); const treeSha = 'c'.repeat(40); const compiledSha256 = 'd'.repeat(64);
const envId = '11111111-1111-4111-8111-111111111111'; const runtimeId = '22222222-2222-4222-8222-222222222222';
const runtimeDeploymentId = '55555555-5555-4555-8555-555555555555';
const hash = value => createHash('sha256').update(value).digest('hex');
const profiles = JSON.parse(readFileSync(path.join(ROOT, 'examples/live-validation/profiles.json'), 'utf8'));
const git = { head: trustedSha, clean: true, repository: 'pbjustin/Arcanos' };
function targetFixture() {
  return { version: 'arcanos-live-validation-target/v2', repository: 'pbjustin/Arcanos', projectId: LIVE_VALIDATION_PROJECT_ID,
    environmentId: envId, environmentName: 'live-validation', runtimeServiceId: runtimeId, publicOrigin: 'https://arcanos-v2-validation.up.railway.app',
    limits: { ...LIVE_VALIDATION_HARD_LIMITS }, models: ['ft:gpt-4.1:arcanos:authority:test', 'gpt-6-luna', 'gpt-6.1-sol']
      .map(id => ({ id, inputMicroUsdPerToken: 1.25, outputMicroUsdPerToken: 5 })), writes: false };
}
function deployment(target, stopped = false) {
  return { id: runtimeDeploymentId, projectId: target.projectId, environmentId: target.environmentId, serviceId: target.runtimeServiceId,
    status: 'SUCCESS', deploymentStopped: stopped, meta: { repo: target.repository, commitHash: sha } };
}
const connection = items => ({ pageInfo: { hasNextPage: false }, edges: items.map(node => ({ node })) });
function inventory(target, active = false, stopped = false) {
  return { projectToken: { projectId: target.projectId, environmentId: target.environmentId },
    environment: { id: target.environmentId, projectId: target.projectId, name: 'live-validation', deletedAt: null,
      config: { privateNetworkDisabled: false, services: { [target.runtimeServiceId]: { source: { repo: target.repository, branch: 'main' }, variables: {} } }, sharedVariables: {} },
      serviceInstances: connection([{ id: target.runtimeServiceId, serviceId: target.runtimeServiceId, environmentId: target.environmentId, deletedAt: null,
        latestDeployment: active ? deployment(target, stopped) : null,
        domains: { serviceDomains: [{ domain: new URL(target.publicOrigin).hostname }], customDomains: [] },
        activeDeployments: active && !stopped ? [deployment(target)] : [] }]),
      deploymentTriggers: connection([]), variables: connection([]), volumeInstances: connection([]) },
    privateNetworks: [{ projectId: target.projectId, environmentId: target.environmentId, deletedAt: null }], runtimeTcp: [] };
}
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'arcanos-controller-test-')); chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = targetFixture(); const artifactDirectory = path.join(directory, 'artifacts'); mkdirSync(artifactDirectory, { mode: 0o700 });
  writeFileSync(path.join(artifactDirectory, 'source.tar'), 'opaque-source'); writeFileSync(path.join(artifactDirectory, 'build.tar'), 'opaque-build');
  const manifest = { version: 1, repository: target.repository, sourceCommit: sha, prNumber: 1528, profile: 'gaming-guide',
    workflowRunId: '1234', workflowRunAttempt: 1, controllerRevision: trustedSha, treeSha, compiledSha256,
    files: { 'source.tar': hash('opaque-source'), 'build.tar': hash('opaque-build') } };
  const raw = JSON.stringify(manifest) + '\n'; writeFileSync(path.join(artifactDirectory, 'candidate-attestation.json'), raw);
  const binding = { ...manifest, artifactId: '5678', artifactDigest: 'sha256:' + 'e'.repeat(64), attestationSha256: hash(raw) };
  const targetFile = path.join(directory, 'target.json'); const artifactFile = path.join(directory, 'binding.json');
  writeFileSync(targetFile, JSON.stringify(target), { mode: 0o600 }); writeFileSync(artifactFile, JSON.stringify(binding), { mode: 0o600 });
  const environment = { WORKFLOW_RUN_ID: '1234', WORKFLOW_RUN_ATTEMPT: '1', CONTROLLER_REVISION: trustedSha, GITHUB_ACTOR: 'maintainer',
    GITHUB_TOKEN: 'fixture-github-token', RAILWAY_LIVE_VALIDATION_TOKEN: 'fixture-railway-token', LIVE_VALIDATION_ARTIFACT_DIRECTORY: artifactDirectory };
  const argv = ['--target-file', targetFile, '--artifact-attestation-file', artifactFile, '--pr-number', '1528', '--commit-sha', sha,
    '--profile', 'gaming-guide', '--evidence-dir', path.join(directory, 'evidence')];
  return { directory, target, binding, artifactDirectory, targetFile, artifactFile, argv, environment };
}
function ghFixture(f, options = {}) {
  let prReads = 0;
  const pr = () => ({ number: 1528, state: 'open', draft: true, head: { sha: options.moveHead && ++prReads > 1 ? 'f'.repeat(40) : sha,
    repo: { full_name: 'pbjustin/Arcanos' } }, base: { ref: 'main', sha: trustedSha, repo: { full_name: 'pbjustin/Arcanos' } } });
  return { async get(route) {
    if (route === '/user') return { login: 'maintainer' };
    if (route.endsWith('/pulls/1528')) return pr();
    if (route.includes('/commits/') && route.includes('/pulls?')) return options.ambiguous ? [pr(), pr()] : [pr()];
    if (route.endsWith('/permission')) return { permission: 'maintain' };
    if (route.endsWith('/actions/runs/1234')) return { id: 1234, event: 'workflow_dispatch', run_attempt: 1, head_sha: trustedSha,
      head_branch: 'main', path: '.github/workflows/live-pr-acceptance.yml', repository: { full_name: 'pbjustin/Arcanos' }, actor: { login: 'maintainer' } };
    if (route.endsWith('/actions/artifacts/5678')) return { id: 5678, expired: false, name: 'live-validation-candidate-1234-1',
      digest: f.binding.artifactDigest, workflow_run: { id: 1234, head_sha: trustedSha } };
    if (route.includes('/check-runs?')) return { total_count: 2, check_runs: ['All Checks Complete', 'docs:check'].map(name => ({
      name, head_sha: sha, status: 'completed', conclusion: options.checkFailure ? 'failure' : 'success', app: { slug: 'github-actions' } })) };
    if (route.includes('/jobs?')) return { total_count: 1, jobs: [{ id: 99, name: 'Validate exact candidate without live credentials', status: 'completed', conclusion: 'success', head_sha: trustedSha }] };
    throw new Error('Unexpected mock GitHub route');
  } };
}
function identity(target) {
  const buildManifest = { version: 1, repository: target.repository, sourceCommit: sha, role: 'runtime', treeSha, compiledSha256 };
  return { role: 'runtime', sourceCommit: sha, projectId: target.projectId, environmentId: target.environmentId, serviceId: target.runtimeServiceId,
    deploymentId: runtimeDeploymentId, buildManifestSha256: validationHash(buildManifest), buildManifest };
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
function observation(positive) {
  return { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: positive ? 'accepted' : 'need_new_source',
    reason: positive ? null : 'GAME_MISMATCH', semanticGap: positive ? 'NONCRITICAL_GAP' : 'CONFLICT',
    coverage: { satisfied: positive, assessmentStatus: 'assessed', missingCount: positive ? 0 : 1 },
    selectedCandidateCount: positive ? 1 : 0, selectedEvidenceCount: positive ? 1 : 0,
    candidates: positive ? [] : [{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }],
    qualification: { visible: positive, patchCompatibility: 'unverified', claimsVerifiedCurrentness: false },
    audit: positive ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true } : null,
    auditStartBudget: { runtimeRemainingMs: 120000, requestRemainingMs: 120000 },
    stages: Object.fromEntries(['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response']
      .map(stage => [stage, { status: positive || ['acquisition', 'selection', 'response'].includes(stage) ? 'passed' : 'not_run', elapsedMs: positive ? 10 : null }])) };
}
function executionFixture(f, options = {}) {
  let active = false; let stopped = false; let bound = false; let admitted = false; let workflows = 0; let clock = 1000000;
  const seen = []; let token;
  const usage = plan => ({ ...plan, status: 'active', counts: { workflows }, limits: { ...f.target.limits, maxConcurrency: 1, maxRetries: 0 },
    usage: { requests: workflows ? 2 : 0, metadataRequests: 0, providerCalls: workflows ? 2 : 0, generationCalls: workflows ? 1 : 0, auditCalls: workflows ? 1 : 0,
      reservedInputTokens: 1800, reservedOutputTokens: 400, reservedTotalTokens: 2200, reservedSpendMicroUsd: 10000,
      observedInputTokens: 600, observedOutputTokens: 100, observedTotalTokens: 700, observedSpendMicroUsd: 4000 } });
  let plan;
  const railway = { async inventory() { return inventory(f.target, active, stopped); },
    async bindTestToken(target, value) { assert.equal(target.runtimeServiceId, runtimeId); assert.match(value, /^[a-f0-9]{64}$/u); token = value; bound = true; seen.push('bind'); },
    async deploy(target, role, sourceCommit) { assert.equal(bound, true); assert.equal(sourceCommit, sha); assert.equal(role, 'runtime'); active = true; seen.push('deploy'); if (options.longDeploy) clock += 700000; return runtimeDeploymentId; },
    async deployment() { return deployment(f.target, stopped); }, async stop() { stopped = true; seen.push('stop'); } };
  const service = { async requestJSON(route, request = {}) {
    seen.push(route);
    if (route !== '/ready') {
      assert.equal(request.headers?.['x-arcanos-source-commit'], sha, 'all execution/usage/cleanup routes require exact source identity');
      assert.equal(request.headers?.['x-arcanos-deployment-id'], runtimeDeploymentId, 'all execution/usage/cleanup routes require exact deployment identity');
    }
    if (route === '/ready') { const proof = identity(f.target); if (options.wrongCompiled) { proof.buildManifest.compiledSha256 = 'f'.repeat(64); proof.buildManifestSha256 = validationHash(proof.buildManifest); } return { status: 200, body: { ...proof, ...(options.wrongManifest ? { buildManifestSha256: 'e'.repeat(64) } : {}),
      readiness: { modelCredentialBound: !options.missingKey, providerCallsEnabled: false, durableWritesEnabled: false } } }; }
    if (route === '/runs') { admitted = true; plan = request.body; return { status: 200, body: { admitted: true, runId: plan.runId } }; }
    if (route === '/usage') return { status: 200, body: usage(plan) };
    if (route === '/stop') return { status: 200, body: { stopped: true, runId: plan.runId } };
    if (route === '/acceptance') {
      workflows++; const entry = profiles.profiles.find(value => value.id === request.body.caseId); const positive = entry.id.endsWith('positive');
      const evidence = evidenceFor(entry); if (options.unboundAudit && positive) evidence.audit.boundToFinalAnswer = false;
      const projected = observation(positive); if (options.lostConflict && !positive) projected.candidates = [];
      if (options.leakToken && positive) evidence.result.sources[0].url = 'https://' + token + '.example.org';
      return { status: 200, body: { identity: identity(f.target), caseId: entry.id, evidence, observation: projected,
        profilePassed: true, durableWrites: 0, productionChanged: false } };
    }
    throw new Error('Unexpected service route');
  } };
  const dependencies = { environment: f.environment, readGitState: () => git, createGitHubApi: () => ghFixture(f, options),
    createRailwayApi: () => railway, createServiceClient: input => { assert.equal(input.token, token); return service; }, now: () => clock,
    randomBytes: () => Buffer.alloc(32, 17), sleep: async () => {} };
  return { dependencies, seen, railway, service, admitted: () => admitted, stopped: () => stopped, plan: () => plan };
}
const execute = (f, e) => runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], e.dependencies);

test('CLI accepts PR, exact SHA or both, and requires paired paid flags with hard ceilings', t => {
  const f = fixture(t);
  assert.equal(parseLiveValidationControllerArguments(f.argv).execute, false);
  for (const pair of [['--execute'], ['--allow-paid-provider'], ['--duration-ms', '600001'], ['--max-provider-requests', '33'],
    ['--max-spend-micro-usd', '2000001'], ['--max-workflows', '3']]) assert.throws(() => parseLiveValidationControllerArguments([...f.argv, ...pair]));
  const without = key => f.argv.filter((_, index) => f.argv[index] !== key && f.argv[index - 1] !== key);
  assert.equal(parseLiveValidationControllerArguments(without('--commit-sha')).prNumber, 1528);
  assert.equal(parseLiveValidationControllerArguments(without('--pr-number')).commitSha, sha);
});
test('default preflight validates exact opaque artifacts without network, credentials or deployment', async t => {
  const f = fixture(t);
  const result = await runLiveValidationController(f.argv, { environment: f.environment, readGitState: () => git,
    createGitHubApi: () => { throw new Error('must remain offline'); }, createRailwayApi: () => { throw new Error('must remain offline'); } });
  assert.equal(result.status, 'PASS'); assert.equal(result.infrastructureMutation, false); assert.equal(result.paidProviderEnabled, false);
});
test('PR resolution allows the authorized draft, rejects moved heads and ambiguous SHA selection', async t => {
  const f = fixture(t); const github = ghFixture(f);
  assert.deepEqual(await resolveLiveValidationSelection(github, { prNumber: 1528 }), { prNumber: 1528, commitSha: sha });
  assert.deepEqual(await resolveLiveValidationSelection(github, { commitSha: sha }), { prNumber: 1528, commitSha: sha });
  await assert.rejects(resolveLiveValidationSelection(ghFixture(f, { ambiguous: true }), { commitSha: sha }), { code: 'LIVE_VALIDATION_PR_SELECTION_AMBIGUOUS' });
  await assert.rejects(resolveLiveValidationSelection(github, { prNumber: 1528, commitSha: 'f'.repeat(40) }));
});
test('independent archive hashes and manifest SHA/tree/compiled identity reject drift or symlink artifacts', t => {
  const f = fixture(t); const args = parseLiveValidationControllerArguments(f.argv);
  assert.equal(validateLiveValidationArtifact(f.binding, { args, git, directory: f.artifactDirectory, environment: f.environment }).sourceCommit, sha);
  writeFileSync(path.join(f.artifactDirectory, 'source.tar'), 'changed');
  assert.throws(() => validateLiveValidationArtifact(f.binding, { args, git, directory: f.artifactDirectory, environment: f.environment }));
  rmSync(path.join(f.artifactDirectory, 'source.tar')); symlinkSync(f.artifactFile, path.join(f.artifactDirectory, 'source.tar'));
  assert.throws(() => validateLiveValidationArtifact(f.binding, { args, git, directory: f.artifactDirectory, environment: f.environment }));
});
test('operator premerge bootstrap requires each actual offline gate and exact source/build binding', t => {
  const f = fixture(t); const args = parseLiveValidationControllerArguments([...f.argv, '--operator-bootstrap']);
  const binding = { version: 'arcanos-live-validation-operator-bootstrap/v1', repository: f.target.repository, sourceCommit: sha, prNumber: 1528,
    profile: 'gaming-guide', trustedControllerSha: trustedSha, treeSha, compiledSha256, files: f.binding.files,
    offlineGateRecords: LIVE_VALIDATION_OPERATOR_GATE_IDS.map(gate => ({ gate, status: 'PASS', commitSha: sha, evidenceSha256: 'e'.repeat(64) })) };
  assert.equal(validateLiveValidationOperatorArtifact(binding, { args, git, directory: f.artifactDirectory, raw: JSON.stringify(binding) }).artifactAuthority, 'operator_bootstrap');
  binding.offlineGateRecords[0].status = 'FAIL';
  assert.throws(() => validateLiveValidationOperatorArtifact(binding, { args, git, directory: f.artifactDirectory, raw: JSON.stringify(binding) }));
});
test('inventory rejects production, extra services, shared credentials, volumes, open TCP and hidden pagination', t => {
  const f = fixture(t); assert.doesNotThrow(() => normalizeLiveValidationInventory(f.target, inventory(f.target), { phase: 'predeploy' }));
  for (const mutate of [x => { x.projectToken.environmentId = LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID; },
    x => { x.environment.config.sharedVariables.OPENAI_API_KEY = {}; }, x => { x.environment.config.services[runtimeId].variables.REDIS_URL = {}; },
    x => { x.environment.volumeInstances = connection([{ volumeId: runtimeDeploymentId, environmentId: envId, serviceId: runtimeId, mountPath: '/data' }]); },
    x => { x.runtimeTcp = [{ environmentId: envId, serviceId: runtimeId, id: runtimeDeploymentId }]; },
    x => { x.environment.serviceInstances.pageInfo.hasNextPage = true; }, x => { x.environment.config.services[runtimeDeploymentId] = {}; }]) {
    const value = inventory(f.target); mutate(value); assert.throws(() => normalizeLiveValidationInventory(f.target, value, { phase: 'predeploy' }));
  }
});
test('deployment proof uses observed exact commit metadata and rejects branch labels and foreign IDs', t => {
  const f = fixture(t); assert.doesNotThrow(() => assertLiveValidationDeployment(deployment(f.target), f.target, 'runtime', sha));
  for (const value of [{ ...deployment(f.target), environmentId: LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID },
    { ...deployment(f.target), meta: { repo: f.target.repository, branch: sha } }, { ...deployment(f.target), serviceId: runtimeDeploymentId }])
    assert.throws(() => assertLiveValidationDeployment(value, f.target, 'runtime', sha));
});
test('one-service mocked flow binds ephemeral token before exact deploy, proves manifest, runs both profiles and stops only its deployment', async t => {
  const f = fixture(t); const e = executionFixture(f, { longDeploy: true }); const result = await execute(f, e);
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.cases.map(value => value.status), ['PASS', 'PASS']);
  assert.equal(e.plan().expiresAtMs - 1700000, 600000); assert.equal(result.paidElapsedMs, 0);
  assert.deepEqual(e.seen.slice(0, 3), ['bind', 'deploy', '/ready']); assert.equal(e.stopped(), true);
  assert.equal(result.cases[1].observation.candidates[0].reasonCodes[0], 'GAME_MISMATCH');
  assert.equal(JSON.stringify(result).includes(Buffer.alloc(32, 17).toString('hex')), false);
});
test('moved PR after deployment, missing key and mismatched compiled manifest block paid admission and stop exact deployment', async t => {
  for (const options of [{ moveHead: true }, { missingKey: true }, { wrongManifest: true }, { wrongCompiled: true }]) await t.test(JSON.stringify(options), async child => {
    const f = fixture(child); const e = executionFixture(f, options); const result = await execute(f, e);
    assert.equal(result.status, 'BLOCKED'); assert.equal(e.admitted(), false); assert.equal(e.stopped(), true);
  });
});
test('failed GitHub checks or workflow reruns reject before token binding/deployment', async t => {
  const f = fixture(t); const e = executionFixture(f, { checkFailure: true }); await assert.rejects(execute(f, e)); assert.deepEqual(e.seen, []);
  f.environment.WORKFLOW_RUN_ATTEMPT = '2'; await assert.rejects(execute(f, e)); assert.deepEqual(e.seen, []);
});
test('forged PASS cannot replace mandatory bound audit or preserve a missing negative semantic conflict reason', async t => {
  for (const options of [{ unboundAudit: true }, { lostConflict: true }, { leakToken: true }]) await t.test(JSON.stringify(options), async child => {
    const f = fixture(child); const e = executionFixture(f, options); const result = await execute(f, e);
    assert.equal(result.status, 'FAILED'); assert.equal(e.stopped(), true);
    assert.equal(JSON.stringify(result).includes(Buffer.alloc(32, 17).toString('hex')), false);
  });
});
test('observations retain bounded semantic codes and timings while dropping arbitrary candidate data', () => {
  const value = observation(false); value.candidates.push({ decision: 'secret text', reasonCodes: ['private prompt', 'CONFLICT'], source: 'private URL' });
  const sanitized = sanitizeLiveValidationObservation(value); assert.equal(sanitized.reason, 'GAME_MISMATCH');
  assert.deepEqual(sanitized.candidates[1], { decision: 'unobserved', reasonCodes: ['CONFLICT'] }); assert.doesNotMatch(JSON.stringify(sanitized), /private/);
});
test('cleanup refuses target-swapped deployment state before any stop operation', async t => {
  const f = fixture(t); const state = { version: 'arcanos-live-validation-controller-state/v1', targetHash: validationHash(f.target), prNumber: 1528,
    commitSha: sha, runId: 'a'.repeat(32), runtimeDeploymentId, runtimeCreated: true, runStarted: false, completed: false, cleanupComplete: false };
  let stops = 0; const railway = { async inventory() { return inventory(f.target); }, async deployment() { return { ...deployment(f.target), serviceId: runtimeDeploymentId }; }, async stop() { stops++; } };
  const result = await cleanupLiveValidationRun({ target: f.target, args: { prNumber: 1528, commitSha: sha }, state, railway, writeState: () => {} });
  assert.equal(result.status, 'FAIL'); assert.equal(stops, 0);
});
test('Railway API requests only variable names and explicitly pinned deploy and token binding mutations', async t => {
  const f = fixture(t); const calls = []; const client = createLiveValidationRailwayApi({ token: 'fixture-test-scoped-token', fetchImplementation: async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const data = request.query.includes('variableUpsert') ? { variableUpsert: true } : { serviceInstanceDeployV2: runtimeDeploymentId };
    return new Response(JSON.stringify({ data }), { status: 200 });
  } });
  await client.bindTestToken(f.target, 'a'.repeat(64)); await client.deploy(f.target, 'runtime', sha); await client.inventory(f.target);
  assert.equal(calls[0].variables.input.skipDeploys, true); assert.equal(calls[0].variables.input.name, 'ARCANOS_LIVE_VALIDATION_TEST_TOKEN');
  assert.equal(calls[1].variables.commitSha, sha); assert.match(calls[2].query, /decryptVariables:false/); assert.doesNotMatch(calls[2].query, /variablesForServiceDeployment|node\{name.*value/);
});
test('normal HTTPS service client rejects aliases/redirects and never sends bearer to an arbitrary route', async () => {
  let calls = 0; const client = createLiveValidationServiceClient({ origin: targetFixture().publicOrigin, token: 'a'.repeat(64), fetchImplementation: async (_url, init) => {
    calls++; assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, 'Bearer ' + 'a'.repeat(64)); return new Response('{}', { status: 200 });
  } });
  await assert.rejects(client.requestJSON('//attacker.invalid')); await assert.rejects(client.requestJSON('/ready?redirect=1')); assert.equal(calls, 0);
  await client.requestJSON('/ready'); assert.equal(calls, 1);
});
test('provider usage evidence rejects excess budget, negative counts and unsupported provider counters', t => {
  const f = fixture(t); const plan = { runId: 'a'.repeat(32), commitSha: sha, prNumber: 1528, runtimeDeploymentId, profileHash: 'b'.repeat(64) };
  const value = { ...plan, counts: { workflows: 2 }, limits: { ...f.target.limits, maxConcurrency: 1, maxRetries: 0 },
    usage: Object.fromEntries(['requests', 'metadataRequests', 'providerCalls', 'generationCalls', 'auditCalls', 'reservedInputTokens', 'reservedOutputTokens',
      'reservedTotalTokens', 'reservedSpendMicroUsd', 'observedInputTokens', 'observedOutputTokens', 'observedTotalTokens', 'observedSpendMicroUsd'].map(key => [key, 0])) };
  assert.doesNotThrow(() => sanitizeLiveValidationUsage(value, { plan, target: f.target })); value.usage.reservedSpendMicroUsd = 2000001;
  assert.throws(() => sanitizeLiveValidationUsage(value, { plan, target: f.target })); value.usage.reservedSpendMicroUsd = 0; value.usage.providerCalls = -1;
  assert.throws(() => sanitizeLiveValidationUsage(value, { plan, target: f.target }));
});

test('controller sanitizes the actual direct-provider snapshot including workflow and metadata counters', async t => {
  const f = fixture(t);
  const plan = { runId: 'a'.repeat(32), commitSha: sha, prNumber: 1528, runtimeDeploymentId, profileHash: 'b'.repeat(64) };
  const model = f.target.models[0].id;
  const observation = { moduleId: 'gaming', stage: 'generation' };
  const provider = createLiveValidationProvider({ target: f.target,
    identity: { sourceCommit: sha, deploymentId: runtimeDeploymentId },
    apiKey: 'sk-unit-test-fixture-' + 'x'.repeat(40), observation: () => observation,
    fetchImplementation: async (_url, init) => Response.json(init.method === 'GET' ? { id: model, object: 'model' }
      : { id: 'response', object: 'response', model, output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }) });
  t.after(() => provider.close());
  const usage = () => sanitizeLiveValidationUsage({ ...plan, ...provider.snapshot(),
    status: provider.snapshot().closed ? 'stopped' : 'active' }, { plan, target: f.target });
  assert.equal(usage().workflows, 0); assert.equal(usage().requests, 0);
  await provider.fetch('https://api.openai.com/v1/models/' + encodeURIComponent(model), { method: 'GET' });
  provider.beginWorkflow('gaming-guide-positive');
  const invoke = () => provider.fetch('https://api.openai.com/v1/responses', { method: 'POST',
    body: JSON.stringify({ model, input: 'Use acquired source evidence.', max_output_tokens: 100 }) });
  await invoke(); observation.stage = 'answer_audit'; await invoke(); provider.endWorkflow();
  provider.beginWorkflow('gaming-guide-negative'); provider.endWorkflow();
  const actual = usage();
  assert.equal(actual.status, 'active'); assert.equal(actual.workflows, 2);
  assert.equal(actual.requests, 3); assert.equal(actual.metadataRequests, 1);
  assert.equal(actual.providerCalls, 2); assert.equal(actual.generationCalls, 1); assert.equal(actual.auditCalls, 1);
  assert.equal(actual.observedInputTokens, 20); assert.equal(actual.observedOutputTokens, 10);
  assert.equal(actual.observedTotalTokens, 30);
  assert.ok(actual.reservedSpendMicroUsd >= actual.observedSpendMicroUsd);
});
