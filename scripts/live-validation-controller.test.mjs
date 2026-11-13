import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseLiveValidationControllerArguments, runLiveValidationController, validateLiveValidationArtifact,
  normalizeLiveValidationInventory, assertLiveValidationDeployment, createLiveValidationRailwayApi,
  cleanupLiveValidationRun, sanitizeLiveValidationObservation, sanitizeLiveValidationUsage, validateLiveValidationOperatorArtifact,
  LIVE_VALIDATION_OPERATOR_GATE_IDS, resolveLiveValidationSelection, createLiveValidationServiceClient } from './live-validation-controller.mjs';
import { LIVE_VALIDATION_PROJECT_ID, LIVE_VALIDATION_HARD_LIMITS, LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID } from './live-validation-target.mjs';
import { canonicalLiveValidationJson, validationHash } from './live-validation-bootstrap.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_CASE_MANIFEST,
  sanitizeLiveValidationAuditRejection } from './live-pr-preview-verifier.mjs';
import { createLiveValidationProvider } from './live-validation-provider.mjs';
import * as privateAnswerController from './live-validation-controller.mjs';

const ROOT = path.resolve(new URL('../', import.meta.url).pathname);
const sha = 'a'.repeat(40); const trustedSha = 'b'.repeat(40); const treeSha = 'c'.repeat(40); const compiledSha256 = 'd'.repeat(64);
const envId = '11111111-1111-4111-8111-111111111111'; const runtimeId = '22222222-2222-4222-8222-222222222222';
const runtimeDeploymentId = '55555555-5555-4555-8555-555555555555';
const hash = value => createHash('sha256').update(value).digest('hex');
const ANSWER_TEXT = 'Use the supplied documented blade path [1].';
const profiles = JSON.parse(readFileSync(path.join(ROOT, 'examples/live-validation/profiles.json'), 'utf8'));
function profileFixture() {
  const value = structuredClone(profiles);
  for (const entry of value.profiles) {
    delete entry.expected.clarification;
    delete entry.expected.requiredModelStages;
  }
  return value;
}
function clarificationFixture() {
  return { version: 1, submittedCount: 4, completedCount: 4, postAcquisitionCount: 3,
    sameWorkflow: true, revisionsAdvanced: true, retainedEvidence: true, budgetsPreserved: true, acquisitionCount: 1 };
}
const git = { head: trustedSha, clean: true, repository: 'pbjustin/Arcanos' };
function targetFixture() {
  return { version: 'arcanos-live-validation-target/v2', repository: 'pbjustin/Arcanos', projectId: LIVE_VALIDATION_PROJECT_ID,
    environmentId: envId, environmentName: 'live-validation', runtimeServiceId: runtimeId, publicOrigin: 'https://arcanos-v2-validation.up.railway.app',
    limits: { ...LIVE_VALIDATION_HARD_LIMITS }, models: ['ft:gpt-4.1:arcanos:authority:test', 'gpt-6-luna', 'gpt-6.1-sol']
      .map(id => ({ id, inputMicroUsdPerToken: 1.25, outputMicroUsdPerToken: 5 })), writes: false };
}
function deployment(target, stopped = false) {
  return { id: runtimeDeploymentId, projectId: target.projectId, environmentId: target.environmentId, serviceId: target.runtimeServiceId,
    status: 'SUCCESS', deploymentStopped: stopped, meta: { repo: target.repository, commitHash: sha,
      serviceManifest: { deploy: { restartPolicyType: 'NEVER', numReplicas: 1, multiRegionConfig: { 'us-west2': { numReplicas: 1 } } } } } };
}
function cleanupState(target, overrides = {}) {
  return { version: 'arcanos-live-validation-controller-state/v1', targetHash: validationHash(target), prNumber: 1528,
    commitSha: sha, runId: 'a'.repeat(32), runtimeDeploymentId, runtimeCreated: true, runStarted: false,
    completed: false, cleanupComplete: false, ...overrides };
}
const connection = items => ({ pageInfo: { hasNextPage: false }, edges: items.map(node => ({ node })) });
function inventory(target, active = false, stopped = false) {
  return { projectToken: { projectId: target.projectId, environmentId: target.environmentId },
    environment: { id: target.environmentId, projectId: target.projectId, name: 'live-validation', deletedAt: null,
      config: { privateNetworkDisabled: false, services: { [target.runtimeServiceId]: { source: { repo: target.repository, branch: 'main' }, variables: {} } }, sharedVariables: {} },
      serviceInstances: connection([{ id: target.runtimeServiceId, serviceId: target.runtimeServiceId, environmentId: target.environmentId, deletedAt: null,
        restartPolicyType: 'NEVER', numReplicas: 1,
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
    result: positive ? { ok: true, route: 'gaming', mode: 'guide', data: { response: ANSWER_TEXT,
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
/** Accepted synthetic answer data stays separate from closed public evidence. */
function privateAnswerFor(entry, response = ANSWER_TEXT) {
  return { version: 1, response, subjectHash: validationHash(response),
    contextFingerprint: validationHash({ scope: 'offline-private-answer' }),
    sources: [{ index: 1, url: entry.input.candidateUrls[0] }] };
}
/** Call through the module namespace so the before-feature suite can still load. */
const validatePrivateAnswer = (...args) => privateAnswerController.validateLiveValidationPrivateAnswer(...args);
function observation(positive) {
  return { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: positive ? 'accepted' : 'need_new_source',
    reason: positive ? null : 'GAME_MISMATCH',
    semanticGap: positive ? profiles.profiles.find(entry => entry.id === 'gaming-guide-positive').expected.semanticGap : 'CONFLICT',
    coverage: { satisfied: positive, assessmentStatus: 'assessed', missingCount: positive ? 0 : 1 },
    selectedCandidateCount: positive ? 1 : 0, selectedEvidenceCount: positive ? 1 : 0,
    candidates: positive ? [] : [{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }],
    qualification: { visible: positive && profiles.profiles.find(entry => entry.id === 'gaming-guide-positive').expected.qualifiedUnknownPatch === true,
      patchCompatibility: 'unverified', claimsVerifiedCurrentness: false },
    audit: positive ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true } : null,
    auditStartBudget: { runtimeRemainingMs: 120000, requestRemainingMs: 120000 },
    stages: Object.fromEntries(['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response']
      .map(stage => [stage, { status: positive || ['acquisition', 'selection', 'response'].includes(stage) ? 'passed' : 'not_run', elapsedMs: positive ? 10 : null }])) };
}
function executionFixture(f, options = {}) {
  const executionProfiles = options.profiles ?? profileFixture();
  let active = false; let stopped = false; let bound = false; let admitted = false; let workflows = 0; let clock = 1000000;
  const seen = []; let token;
  const usage = plan => ({ ...plan, status: 'active', counts: { workflows }, limits: { ...f.target.limits, maxConcurrency: 1, maxRetries: 0 },
    usage: { requests: workflows ? 2 : 0, metadataRequests: 0, providerCalls: workflows ? 2 : 0, generationCalls: workflows ? 1 : 0, auditCalls: workflows ? 1 : 0,
      reservedInputTokens: 1800, reservedOutputTokens: 400, reservedTotalTokens: 2200, reservedSpendMicroUsd: 10000,
      observedInputTokens: 600, observedOutputTokens: 100, observedTotalTokens: 700, observedSpendMicroUsd: 4000 } });
  let plan;
  const railway = { async inventory() { return inventory(f.target, active, stopped); },
    async bindTestToken(target, value) { assert.equal(target.runtimeServiceId, runtimeId); assert.match(value, /^[a-f0-9]{64}$/u); token = value; bound = true; seen.push('bind'); },
    async deploy(target, role, sourceCommit) { assert.equal(bound, true); assert.equal(sourceCommit, sha); assert.equal(role, 'runtime');
      options.onDeploy?.(); active = true; seen.push('deploy'); if (options.longDeploy) clock += 700000;
      if (options.lostDeployResponse) throw Object.assign(new Error('fixture lost deployment response'), { code: 'LIVE_VALIDATION_RAILWAY_REQUEST_FAILED' });
      return runtimeDeploymentId; },
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
      workflows++; const entry = executionProfiles.profiles.find(value => value.id === request.body.caseId); const positive = entry.id.endsWith('positive');
      const evidence = evidenceFor(entry); if (options.unboundAudit && positive) evidence.audit.boundToFinalAnswer = false;
      const projected = observation(positive); if (options.lostConflict && !positive) projected.candidates = [];
      if (positive) options.mutateObservation?.(projected);
      if (options.leakToken && positive) evidence.result.sources[0].url = 'https://' + token + '.example.org';
      options.mutateEvidence?.(evidence, positive);
      let privateAnswer = positive && !options.omitPrivateAnswer ? privateAnswerFor(entry) : undefined;
      if (privateAnswer) options.mutatePrivateAnswer?.(privateAnswer, { token, evidence, observation: projected });
      if (!positive && options.negativePrivateAnswer) privateAnswer = privateAnswerFor(entry, 'Unexpected negative answer [1].');
      options.beforeAcceptanceReturn?.({ positive });
      return { status: 200, body: { identity: identity(f.target), caseId: entry.id, evidence, observation: projected,
        profilePassed: true, durableWrites: 0, productionChanged: false, ...(privateAnswer ? { privateAnswer } : {}) } };
    }
    throw new Error('Unexpected service route');
  } };
  const dependencies = { environment: f.environment, readGitState: () => git, createGitHubApi: () => ghFixture(f, options),
    readProfiles: () => executionProfiles,
    createRailwayApi: () => railway, createServiceClient: input => { assert.equal(input.token, token); return service; }, now: () => clock,
    randomBytes: () => Buffer.alloc(32, 17), sleep: async () => {} };
  return { dependencies, seen, railway, service, admitted: () => admitted, stopped: () => stopped, plan: () => plan };
}
const execute = (f, e) => runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], e.dependencies);

test('controller leaves a competing one-shot claim intact before runtime mutation', async t => {
  const f = fixture(t); const e = executionFixture(f);
  const stateFile = path.join(f.directory, 'evidence', 'controller-state.private.json');
  const winningClaim = '{"claim":"concurrent-controller-fixture"}\n';
  e.dependencies.createRailwayApi = () => {
    // Model a second controller publishing its claim just after the initial file check.
    writeFileSync(stateFile, winningClaim, { mode: 0o600, flag: 'wx' });
    return e.railway;
  };
  await assert.rejects(execute(f, e), { code: 'LIVE_VALIDATION_RUN_REPLAY_FORBIDDEN' });
  assert.equal(readFileSync(stateFile, 'utf8'), winningClaim);
  assert.deepEqual(e.seen, []);
});

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
test('tightened target limits require exact CLI agreement before preflight, execution or cleanup I/O', async t => {
  const f = fixture(t);
  f.target.limits = { maxSpendMicroUsd: 1_000_000, maxRequests: 31, maxWorkflows: 1, durationMs: 300_000 };
  writeFileSync(f.targetFile, JSON.stringify(f.target));
  const calls = [];
  const dependencies = { environment: f.environment, readGitState: () => git,
    createGitHubApi: () => { calls.push('github'); throw new Error('must remain offline'); },
    createRailwayApi: () => { calls.push('railway'); throw new Error('must remain offline'); },
    createServiceClient: () => { calls.push('service'); throw new Error('must remain offline'); } };
  for (const argv of [f.argv, [...f.argv, '--execute', '--allow-paid-provider'], ['cleanup', ...f.argv]]) {
    await assert.rejects(runLiveValidationController(argv, dependencies), { code: 'LIVE_VALIDATION_OPERATOR_LIMIT_MISMATCH' });
    assert.deepEqual(calls, []);
    assert.equal(existsSync(path.join(f.directory, 'evidence')), false);
  }
  const caps = ['--max-spend-micro-usd', '1000000', '--max-provider-requests', '31',
    '--max-workflows', '1', '--duration-ms', '300000'];
  const preflight = await runLiveValidationController([...f.argv, ...caps], dependencies);
  assert.equal(preflight.status, 'PASS'); assert.deepEqual(preflight.limits, f.target.limits);
  const cleanup = await runLiveValidationController(['cleanup', ...f.argv, ...caps], dependencies);
  assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.code, 'LIVE_VALIDATION_CLEANUP_NO_RUN');
  assert.deepEqual(calls, []);
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
test('inventory rejects replica or automatic restart settings that could reset process-local paid quotas', () => {
  const target = targetFixture();
  for (const changes of [{ restartPolicyType: 'ALWAYS' }, { restartPolicyType: 'ON_FAILURE' }, { numReplicas: 2 },
    { numReplicas: null }, { restartPolicyType: null }]) {
    const raw = inventory(target); Object.assign(raw.environment.serviceInstances.edges[0].node, changes);
    assert.throws(() => normalizeLiveValidationInventory(target, raw, { phase: 'predeploy' }), { code: 'LIVE_VALIDATION_RUNTIME_POLICY_INVALID' });
  }
});
test('deployment proof uses observed exact commit metadata and rejects branch labels and foreign IDs', t => {
  const f = fixture(t); assert.doesNotThrow(() => assertLiveValidationDeployment(deployment(f.target), f.target, 'runtime', sha));
  for (const value of [{ ...deployment(f.target), environmentId: LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID },
    { ...deployment(f.target), meta: { repo: f.target.repository, branch: sha } }, { ...deployment(f.target), serviceId: runtimeDeploymentId }])
    assert.throws(() => assertLiveValidationDeployment(value, f.target, 'runtime', sha));
});
test('paid deployment proof rejects effective restart, replica and multi-region overrides', () => {
  const target = targetFixture();
  for (const change of [deploy => { deploy.restartPolicyType = 'ON_FAILURE'; }, deploy => { deploy.numReplicas = 2; },
    deploy => { deploy.multiRegionConfig['us-east4'] = { numReplicas: 1 }; },
    deploy => { deploy.multiRegionConfig['us-west2'].numReplicas = 2; }]) {
    const value = deployment(target); change(value.meta.serviceManifest.deploy);
    assert.throws(() => assertLiveValidationDeployment(value, target, 'runtime', sha), { code: 'LIVE_VALIDATION_RUNTIME_POLICY_INVALID' });
    const raw = inventory(target, true); raw.environment.serviceInstances.edges[0].node.latestDeployment = value;
    assert.throws(() => normalizeLiveValidationInventory(target, raw), { code: 'LIVE_VALIDATION_RUNTIME_POLICY_INVALID' });
  }
});
test('one-service mocked flow binds ephemeral token before exact deploy, proves manifest, runs both profiles and stops only its deployment', async t => {
  const f = fixture(t); const e = executionFixture(f, { longDeploy: true }); const result = await execute(f, e);
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.cases.map(value => value.status), ['PASS', 'PASS']);
  assert.equal(e.plan().expiresAtMs - 1700000, 600000); assert.equal(result.paidElapsedMs, 0);
  assert.deepEqual(e.seen.slice(0, 3), ['bind', 'deploy', '/ready']); assert.equal(e.stopped(), true);
  assert.equal(result.cases[1].observation.candidates[0].reasonCodes[0], 'GAME_MISMATCH');
  assert.equal(JSON.stringify(result).includes(Buffer.alloc(32, 17).toString('hex')), false);
  const answerFile = path.join(f.directory, 'evidence', 'accepted-answer.private.json');
  const retained = JSON.parse(readFileSync(answerFile, 'utf8'));
  const positive = profileFixture().profiles.find(entry => entry.id === 'gaming-guide-positive');
  assert.equal(lstatSync(answerFile).mode & 0o077, 0);
  assert.equal(lstatSync(path.dirname(answerFile)).mode & 0o077, 0);
  if (typeof process.getuid === 'function') assert.equal(lstatSync(answerFile).uid, process.getuid());
  assert.equal(retained.response, ANSWER_TEXT); assert.equal(retained.subjectHash, validationHash(ANSWER_TEXT));
  assert.equal(retained.caseId, positive.id); assert.equal(retained.sourceCommit, sha);
  assert.equal(retained.runId, result.runId); assert.equal(retained.profileHash, e.plan().profileHash);
  assert.deepEqual(retained.sources, privateAnswerFor(positive).sources);
  assert.deepEqual(retained.runtimeIdentity, result.runtimeIdentity);
  assert.equal(result.cases[0].answerArtifactSha256, validationHash(privateAnswerFor(positive)));
  assert.equal(Object.hasOwn(result.cases[1], 'answerArtifactSha256'), false);
  for (const publicValue of [result, JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'acceptance-summary.json'), 'utf8'))]) {
    const serialized = JSON.stringify(publicValue);
    assert.equal(serialized.includes(ANSWER_TEXT), false);
    assert.equal(serialized.includes(positive.input.candidateUrls[0]), false);
    assert.equal(serialized.includes('privateAnswer'), false);
    assert.equal(serialized.includes('contextFingerprint'), false);
  }
});

test('private answer validation accepts exact bound content while cloning it away from caller mutation', () => {
  const entry = profileFixture().profiles.find(value => value.id === 'gaming-guide-positive');
  const input = privateAnswerFor(entry);
  const validated = validatePrivateAnswer(input, { evidence: evidenceFor(entry), observation: observation(true) });
  assert.deepEqual(validated, input); assert.notEqual(validated, input); assert.notEqual(validated.sources, input.sources);
  input.sources[0].url = 'https://different.example.org/changed';
  assert.equal(validated.sources[0].url, entry.input.candidateUrls[0]);
});

test('private answer validation counts numeric citations separately from descriptive Markdown labels', () => {
  const entry = profileFixture().profiles.find(value => value.id === 'gaming-guide-positive');
  const answer = `Follow the documented preparation [1]. See the [Source 2 engine notes](${entry.input.candidateUrls[0]}).`;
  const input = privateAnswerFor(entry, answer);
  assert.deepEqual(validatePrivateAnswer(input, { evidence: evidenceFor(entry), observation: observation(true) }), input);
});

test('private answer validation rejects invalid shapes, unbound content, citations, sources and audit state', async t => {
  const entry = profileFixture().profiles.find(value => value.id === 'gaming-guide-positive');
  const mutations = [
    ['unknown field', value => { value.rawSource = 'private acquired source'; }],
    ['missing field', value => { delete value.contextFingerprint; }],
    ['wrong version', value => { value.version = 2; }],
    ['empty answer', value => { value.response = ' '; value.subjectHash = validationHash(value.response); }],
    ['oversized answer', value => { value.response = 'x'.repeat(65_537); value.subjectHash = validationHash(value.response); }],
    ['changed answer hash', value => { value.response += ' altered'; }],
    ['invalid context fingerprint', value => { value.contextFingerprint = 'not-a-hash'; }],
    ['source ordinal', value => { value.sources[0].index = 2; }],
    ['unknown source field', value => { value.sources[0].body = 'private source'; }],
    ['wrong source URL', value => { value.sources[0].url = 'https://different.example.org/guide'; }],
    ['plain HTTP', value => { value.sources[0].url = value.sources[0].url.replace('https:', 'http:'); }],
    ['credential-bearing URL', value => { const url = new URL(value.sources[0].url); url.username = 'fixture'; value.sources[0].url = url.toString(); }],
    ['no sources', value => { value.sources = []; }],
    ['duplicate source', value => { value.sources.push({ ...value.sources[0] }); }],
    ['missing citation', value => { value.response = 'An answer without a citation.'; value.subjectHash = validationHash(value.response); }],
    ['out of range citation', value => { value.response = 'A claimed answer [2].'; value.subjectHash = validationHash(value.response); }],
    ['unusable source', (_value, evidence) => { evidence.result.sources[0].usable = false; }],
    ['source hash mismatch', (_value, evidence) => { evidence.result.sources[0].documentUrlSha256 = 'e'.repeat(64); }],
    ['citation proof mismatch', (_value, evidence) => { evidence.result.citationIndices = []; }],
    ['not accepted', (_value, evidence) => { evidence.result.acceptedAnswer = false; }],
    ['unresolved citations', (_value, evidence) => { evidence.result.citationsResolved = false; }],
    ['unbound audit', (_value, evidence) => { evidence.audit.boundToFinalAnswer = false; }],
    ['rejected audit', (_value, evidence) => { evidence.audit.decision = 'reject'; }],
    ['unfinished audit', (_value, evidence) => { evidence.audit.assessmentStatus = 'unavailable'; }],
    ['missing coverage', (_value, _evidence, observed) => { observed.coverage.satisfied = false; }],
    ['unbound observation', (_value, _evidence, observed) => { observed.audit.boundToFinalAnswer = false; }],
    ['rejected observation audit', (_value, _evidence, observed) => { observed.audit.decision = 'reject'; }],
    ['unfinished observation audit', (_value, _evidence, observed) => { observed.audit.assessmentStatus = 'unavailable'; }]
  ];
  for (const [label, mutate] of mutations) await t.test(label, () => {
    const value = privateAnswerFor(entry); const evidence = evidenceFor(entry); const observed = observation(true);
    mutate(value, evidence, observed);
    assert.throws(() => validatePrivateAnswer(value, { evidence, observation: observed }), { code: 'LIVE_VALIDATION_PRIVATE_ANSWER_INVALID' });
  });
});

test('private answer validation rejects a known secret without exposing it in the error', () => {
  const entry = profileFixture().profiles.find(value => value.id === 'gaming-guide-positive');
  const secret = 'test-private-secret-value';
  const value = privateAnswerFor(entry, `This private answer contains ${secret}. [1]`);
  assert.throws(() => validatePrivateAnswer(value, { evidence: evidenceFor(entry), observation: observation(true), secrets: [secret] }),
    error => error.code === 'LIVE_VALIDATION_PRIVATE_ANSWER_INVALID' && !String(error).includes(secret));
});

test('failed positive proof never retains the private payload or returns it in the summary', async t => {
  for (const [label, options] of [
    ['missing private payload', { omitPrivateAnswer: true }],
    ['changed private answer', { mutatePrivateAnswer: value => { value.response += ' unbound'; } }],
    ['unbound audit', { unboundAudit: true }],
    ['fallback result', { mutateEvidence: (evidence, positive) => { if (positive) evidence.result.acceptedAnswer = false; } }],
    ['runtime token in answer', { mutatePrivateAnswer: (value, { token }) => {
      value.response = `Private ${token} [1]`; value.subjectHash = validationHash(value.response);
    } }]
  ]) await t.test(label, async child => {
    const f = fixture(child); const e = executionFixture(f, options); const result = await execute(f, e);
    assert.notEqual(result.status, 'PASS'); assert.equal(e.stopped(), true);
    assert.equal(existsSync(path.join(f.directory, 'evidence', 'accepted-answer.private.json')), false);
    const publicJson = JSON.stringify(result);
    assert.equal(publicJson.includes(ANSWER_TEXT), false);
    assert.equal(publicJson.includes('unbound'), false);
    assert.equal(publicJson.includes(Buffer.alloc(32, 17).toString('hex')), false);
    assert.equal(publicJson.includes('privateAnswer'), false);
  });
});

test('a negative profile cannot replace the accepted positive private artifact', async t => {
  const f = fixture(t); const e = executionFixture(f, { negativePrivateAnswer: true });
  const result = await execute(f, e);
  assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PRIVATE_ANSWER_INVALID');
  const retained = JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'accepted-answer.private.json'), 'utf8'));
  assert.equal(retained.response, ANSWER_TEXT); assert.notEqual(retained.response, 'Unexpected negative answer [1].');
  assert.equal(JSON.stringify(result).includes('Unexpected negative answer'), false);
  assert.equal(Object.hasOwn(result.observedCases[1], 'answerArtifactSha256'), false);
});

test('private answer retention refuses a symlink destination without overwriting its target', async t => {
  const f = fixture(t); const target = path.join(f.directory, 'keep-existing.txt');
  writeFileSync(target, 'keep-existing-content', { mode: 0o600 });
  const e = executionFixture(f, { beforeAcceptanceReturn: ({ positive }) => {
    if (positive) symlinkSync(target, path.join(f.directory, 'evidence', 'accepted-answer.private.json'));
  } });
  const result = await execute(f, e);
  assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_STATE_UNSAFE');
  assert.equal(readFileSync(target, 'utf8'), 'keep-existing-content'); assert.equal(e.stopped(), true);
  assert.equal(JSON.stringify(result).includes(ANSWER_TEXT), false);
});
test('accepted deployment with a lost response preserves intent and blocks cleanup without provider admission or guessed stop', async t => {
  const f = fixture(t); let persistedBeforeDeploy;
  const e = executionFixture(f, { lostDeployResponse: true, onDeploy: () => {
    persistedBeforeDeploy = JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'controller-state.private.json'), 'utf8'));
  } });
  const result = await execute(f, e);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.code, 'LIVE_VALIDATION_RAILWAY_REQUEST_FAILED');
  assert.equal(result.cleanup.status, 'FAIL'); assert.equal(result.cleanup.code, 'LIVE_VALIDATION_CLEANUP_BLOCKED');
  assert.equal(result.cleanup.runtimeDeploymentStopped, false); assert.equal(result.cleanup.runClosed, true);
  assert.ok(result.cleanup.failures.includes('LIVE_VALIDATION_CLEANUP_DEPLOYMENT_OUTCOME_UNKNOWN'));
  assert.equal(persistedBeforeDeploy.runtimeDeployAttempted, true);
  assert.equal(persistedBeforeDeploy.runtimeCreated, false); assert.equal(persistedBeforeDeploy.runtimeDeploymentId, null);
  const state = JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'controller-state.private.json'), 'utf8'));
  assert.equal(state.runtimeDeployAttempted, true); assert.equal(state.runtimeCreated, false);
  assert.equal(state.runtimeDeploymentId, null); assert.equal(state.cleanupComplete, false);
  assert.equal(e.admitted(), false); assert.equal(e.stopped(), false);
  assert.deepEqual(e.seen, ['bind', 'deploy']);
  const cleanup = await runLiveValidationController(['cleanup', ...f.argv], e.dependencies);
  assert.equal(cleanup.status, 'FAIL'); assert.equal(cleanup.runtimeDeploymentStopped, false);
  assert.equal(e.stopped(), false); assert.deepEqual(e.seen, ['bind', 'deploy']);
});
test('unknown deployment outcomes cannot claim cleanup from an empty snapshot or adopt an active deployment', async t => {
  for (const [label, intent, active, pass] of [
    ['no attempt, absent', false, false, true], ['no attempt, active', false, true, false],
    ['attempt, absent', true, false, false], ['attempt, active', true, true, false],
    ['legacy unknown, absent', undefined, false, false], ['legacy unknown, active', undefined, true, false],
  ]) await t.test(label, async () => {
    const target = targetFixture(); const calls = [];
    const state = cleanupState(target, { runtimeCreated: false, runtimeDeploymentId: null,
      ...(intent === undefined ? {} : { runtimeDeployAttempted: intent }) });
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state,
      railway: { inventory: async () => { calls.push('inventory'); return inventory(target, active); },
        deployment: async () => { throw new Error('must not adopt deployment'); },
        stop: async () => { throw new Error('must not stop ambiguous deployment'); } },
      writeState: () => calls.push('writeState') });
    assert.equal(result.status, pass ? 'PASS' : 'FAIL');
    assert.equal(result.runtimeDeploymentStopped, pass); assert.equal(state.cleanupComplete, pass);
    assert.deepEqual(calls, ['inventory', 'inventory', 'writeState']);
    if (intent !== false) assert.ok(result.failures.includes('LIVE_VALIDATION_CLEANUP_DEPLOYMENT_OUTCOME_UNKNOWN'));
  });
});
test('deployment intent schema rejects contradictory and nonboolean states before cleanup I/O', async () => {
  const target = targetFixture(); let calls = 0;
  for (const intent of [false, null, 'true', 1]) await assert.rejects(cleanupLiveValidationRun({ target,
    args: { prNumber: 1528, commitSha: sha }, state: cleanupState(target, { runtimeDeployAttempted: intent }),
    railway: { inventory: async () => { calls++; throw new Error('must not run'); } }, writeState: () => calls++ }),
  { code: 'LIVE_VALIDATION_CLEANUP_STATE_INVALID' });
  assert.equal(calls, 0);
});
test('owned terminal readback still blocks a clean verdict if authoritative inventory retains an active deployment', async () => {
  const target = targetFixture(); const state = cleanupState(target); let mutations = 0;
  const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state,
    railway: { inventory: async () => inventory(target, true), deployment: async () => deployment(target, true),
      stop: async () => { mutations++; } }, writeState: () => {} });
  assert.equal(result.status, 'FAIL'); assert.equal(state.cleanupComplete, false);
  assert.ok(result.failures.includes('LIVE_VALIDATION_CLEANUP_ACTIVE_DEPLOYMENT_REMAINS'));
  assert.equal(mutations, 0);
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
test('answer audit receipt preserves only bounded audit diagnostics', () => {
  const value = observation(true);
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, value.audit);
  const audit = { assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false };
  for (const reasonCode of ['AUDIT_INPUT_UNAVAILABLE', 'AUDIT_BUDGET_EXHAUSTED', 'AUDIT_PROVIDER_INCOMPLETE',
    'AUDIT_MALFORMED', 'AUDIT_TIMEOUT', 'AUDIT_PROVIDER_ERROR']) {
    value.audit = { ...audit, reasonCode, effectiveTimeoutMs: 12_000,
      rawBody: 'private upstream response', model: 'private model', sourceId: 'private evidence' };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, { ...audit, reasonCode, effectiveTimeoutMs: 12_000 });
  }
  value.audit = { ...audit, reasonCode: 'AUDIT_PRIVATE_PAYLOAD', effectiveTimeoutMs: 0 };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, { ...audit, effectiveTimeoutMs: 0 });
  for (const effectiveTimeoutMs of [-1, 1.5, 12_001, null, 'private timeout']) {
    value.audit = { ...audit, effectiveTimeoutMs };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, audit);
  }
  value.audit = { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true,
    reasonCode: 'AUDIT_TIMEOUT', effectiveTimeoutMs: 9000 };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit,
    { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true, effectiveTimeoutMs: 9000 });
});
test('answer audit provider result diagnostics project only bounded metadata', () => {
  const value = observation(true);
  const audit = { assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false,
    reasonCode: 'AUDIT_PROVIDER_INCOMPLETE' };
  const diagnostic = { resultClass: 'provider_incomplete', providerStatus: 'incomplete', finishReason: 'length',
    incompleteReason: 'max_output_tokens', truncated: true, contentFiltered: false, contentLengthClass: 'bounded',
    messageStatus: 'in_progress' };
  value.audit = { ...audit, providerDiagnostic: { ...diagnostic, rawText: 'private output', modelId: 'private model',
    requestId: 'private request', sourceUrl: 'private source', contentLength: 123, outputKind: 'tool_output' } };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, { ...audit, providerDiagnostic: diagnostic });

  value.audit.providerDiagnostic = { resultClass: 'malformed_json', providerStatus: 'private provider status',
    finishReason: 'unknown', incompleteReason: 'private reason', truncated: 'true', contentFiltered: 1,
    contentLengthClass: 123, error: { message: 'private error' } };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, {
    ...audit, providerDiagnostic: { resultClass: 'malformed_json', finishReason: 'unknown' }
  });

  for (const invalid of [undefined, null, [], { finishReason: 'stop' }, { resultClass: 'private class' }]) {
    value.audit.providerDiagnostic = invalid;
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, audit);
  }

  for (const outputKind of ['refusal', 'tool_output']) {
    value.audit.providerDiagnostic = { resultClass: 'unsupported_output', outputKind, messageStatus: 'incomplete' };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, {
      ...audit, providerDiagnostic: { resultClass: 'unsupported_output', outputKind }
    });
  }
  value.audit.providerDiagnostic = { resultClass: 'unsupported_output', outputKind: 'private kind' };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, {
    ...audit, providerDiagnostic: { resultClass: 'unsupported_output' }
  });

  value.audit.providerDiagnostic = { resultClass: 'provider_incomplete', messageStatus: 'private status' };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, {
    ...audit, providerDiagnostic: { resultClass: 'provider_incomplete' }
  });

  for (const resultClass of ['unexpected_finish', 'commentary_only', 'missing_content', 'oversized_content', 'invalid_schema']) {
    const status = { ...audit, reasonCode: resultClass === 'invalid_schema' ? 'AUDIT_MALFORMED' : 'AUDIT_PROVIDER_INCOMPLETE' };
    value.audit = { ...status, providerDiagnostic: { resultClass, rawText: 'private audit text' } };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, { ...status, providerDiagnostic: { resultClass } });
  }

  const completed = { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true };
  value.audit = { ...completed, providerDiagnostic: { resultClass: 'complete', contentLengthClass: 'bounded' } };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, value.audit);
  value.audit = { ...completed, providerDiagnostic: diagnostic };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, completed);
  value.audit = { ...audit, providerDiagnostic: { resultClass: 'complete' } };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, audit);
  const notRun = { assessmentStatus: 'not_run', decision: 'unavailable', boundToFinalAnswer: false };
  value.audit = { ...notRun, providerDiagnostic: diagnostic };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, notRun);
});

test('completed rejected audit receipts retain only safe findings and a bounded blocking count', () => {
  const value = observation(true);
  const audit = { assessmentStatus: 'completed', decision: 'reject', boundToFinalAnswer: false, effectiveTimeoutMs: 12_000 };
  value.audit = { ...audit, findingCodes: ['PROFILE_FLOOR_NOT_MET', 'PRIVATE_PROVIDER_CODE',
    'MATERIAL_FACT_UNRESOLVED', 'PROFILE_FLOOR_NOT_MET'], blockingFindingCount: 4,
    rawBody: 'private audit body', evidenceRefs: ['private evidence reference'], dimensionScores: { clarity: 1 } };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, { ...audit,
    findingCodes: ['MATERIAL_FACT_UNRESOLVED', 'PROFILE_FLOOR_NOT_MET', 'UNCLASSIFIED_AUDIT_FINDING'],
    blockingFindingCount: 4,
    findingCounts: { MATERIAL_FACT_UNRESOLVED: 1, PROFILE_FLOOR_NOT_MET: 2, UNCLASSIFIED_AUDIT_FINDING: 1 } });
  for (const malformed of [{ blockingFindingCount: 0 }, { blockingFindingCount: 33 }, { blockingFindingCount: 1.5 },
    { findingCodes: ['MATERIAL_FACT_UNRESOLVED', { code: 'private' }] },
    { findingCodes: ['MATERIAL_FACT_UNRESOLVED', 'PROFILE_FLOOR_NOT_MET'], blockingFindingCount: 1 },
    { findingCodes: Array(33).fill('MATERIAL_FACT_UNRESOLVED') }]) {
    value.audit = { ...audit, findingCodes: ['MATERIAL_FACT_UNRESOLVED'], blockingFindingCount: 1, ...malformed };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, audit);
  }
  value.audit = audit;
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, audit);
  for (const [assessmentStatus, decision] of [['completed', 'accept'], ['completed', 'partial'], ['unavailable', 'unavailable']]) {
    const otherAudit = { ...audit, assessmentStatus, decision };
    value.audit = { ...otherAudit, findingCodes: ['MATERIAL_FACT_UNRESOLVED'], blockingFindingCount: 1 };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, otherAudit);
  }
});
test('rejection counts retain repeated and reviewed findings through adapter and controller projection', () => {
  const value = observation(true);
  const audit = { assessmentStatus: 'completed', decision: 'reject', boundToFinalAnswer: false };
  const adapterProjection = sanitizeLiveValidationAuditRejection({ blockingFindingCount: 7,
    findingCodes: ['FALLBACK_PRESENTED_AS_COMPLETED', 'PLAYER_CONSTRAINT_IGNORED', 'PLAYER_CONSTRAINT_IGNORED',
      'PRIVATE_PROVIDER_CODE', 'PRIVATE_OTHER_CODE', 'MATERIAL_FACT_UNRESOLVED', 'MATERIAL_FACT_UNRESOLVED'] });
  value.audit = { ...audit, ...adapterProjection };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, {
    ...audit, blockingFindingCount: 7,
    findingCodes: ['FALLBACK_PRESENTED_AS_COMPLETED', 'MATERIAL_FACT_UNRESOLVED', 'PLAYER_CONSTRAINT_IGNORED',
      'UNCLASSIFIED_AUDIT_FINDING'],
    findingCounts: { FALLBACK_PRESENTED_AS_COMPLETED: 1, MATERIAL_FACT_UNRESOLVED: 2, PLAYER_CONSTRAINT_IGNORED: 2,
      UNCLASSIFIED_AUDIT_FINDING: 2 }
  });
});
test('rejection receipts distinguish explicit unclassified findings from unmapped codes', () => {
  const value = observation(true);
  const audit = { assessmentStatus: 'completed', decision: 'reject', boundToFinalAnswer: false };
  const unclassified = 'UNCLASSIFIED_AUDIT_FINDING';
  const privateCode = 'MODEL_SUPPLIED_PRIVATE_IDENTIFIER';
  for (const [codes, unmappedFindingCount] of [
    [[unclassified, unclassified], 0],
    [[unclassified, privateCode], 1],
    [[privateCode, privateCode], 2]
  ]) {
    value.audit = { ...audit, ...sanitizeLiveValidationAuditRejection({
      blockingFindingCount: 3, findingCodes: ['MATERIAL_FACT_UNRESOLVED', ...codes]
    }, 'assessment') };
    const projection = sanitizeLiveValidationObservation(value).audit;
    assert.deepEqual(projection, { ...audit, findingCodes: ['MATERIAL_FACT_UNRESOLVED', unclassified],
      blockingFindingCount: 3, findingCounts: { MATERIAL_FACT_UNRESOLVED: 1, [unclassified]: 2 },
      unmappedFindingCount });
    assert.equal(JSON.stringify(projection).includes(privateCode), false);
  }
});

test('rejection receipts retain unmapped counts only with a consistent allowlisted aggregate', () => {
  const value = observation(true);
  const audit = { assessmentStatus: 'completed', decision: 'reject', boundToFinalAnswer: false };
  const previous = { ...audit, findingCodes: ['UNCLASSIFIED_AUDIT_FINDING'], blockingFindingCount: 1,
    findingCounts: { UNCLASSIFIED_AUDIT_FINDING: 1 } };
  value.audit = previous;
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, previous);
  for (const unmappedFindingCount of [-1, 2, 0.5, 'MODEL_SUPPLIED_PRIVATE_IDENTIFIER', null, { private: 'hidden' }]) {
    value.audit = { ...previous, unmappedFindingCount };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, previous);
  }
  const { findingCounts: _counts, ...withoutCounts } = previous;
  value.audit = { ...withoutCounts, unmappedFindingCount: 1 };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, previous);
  const classified = { ...audit, findingCodes: ['MATERIAL_FACT_UNRESOLVED'], blockingFindingCount: 1,
    findingCounts: { MATERIAL_FACT_UNRESOLVED: 1 } };
  value.audit = { ...classified, unmappedFindingCount: 0 };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, classified);
});

test('historical rejections and invalid count maps retain the original sanitized receipt fields', () => {
  const value = observation(true);
  const historicalAudit = { assessmentStatus: 'completed', decision: 'reject', boundToFinalAnswer: false,
    findingCodes: ['MATERIAL_FACT_UNRESOLVED', 'PROFILE_FLOOR_NOT_MET', 'UNCLASSIFIED_AUDIT_FINDING'],
    blockingFindingCount: 8 };
  value.audit = historicalAudit;
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, historicalAudit);
  for (const findingCounts of [
    { MATERIAL_FACT_UNRESOLVED: 1, PROFILE_FLOOR_NOT_MET: 1, UNCLASSIFIED_AUDIT_FINDING: 5 },
    { MATERIAL_FACT_UNRESOLVED: 1.5, PROFILE_FLOOR_NOT_MET: 1.5, UNCLASSIFIED_AUDIT_FINDING: 5 },
    { MATERIAL_FACT_UNRESOLVED: 0, PROFILE_FLOOR_NOT_MET: 1, UNCLASSIFIED_AUDIT_FINDING: 7 },
    { MATERIAL_FACT_UNRESOLVED: 2, PROFILE_FLOOR_NOT_MET: 2, UNCLASSIFIED_AUDIT_FINDING: 3, UNSUPPORTED_CLAIM: 1 },
    { MATERIAL_FACT_UNRESOLVED: 2, PROFILE_FLOOR_NOT_MET: 2, UNCLASSIFIED_AUDIT_FINDING: 3, PRIVATE_PROVIDER_CODE: 1 },
    JSON.parse('{"MATERIAL_FACT_UNRESOLVED":2,"PROFILE_FLOOR_NOT_MET":2,"UNCLASSIFIED_AUDIT_FINDING":3,"__proto__":1}'),
    { MATERIAL_FACT_UNRESOLVED: 4, PROFILE_FLOOR_NOT_MET: 4 },
    ['private value']
  ]) {
    value.audit = { ...historicalAudit, findingCounts };
    assert.deepEqual(sanitizeLiveValidationObservation(value).audit, historicalAudit);
  }
  const completeCodes = { ...historicalAudit, blockingFindingCount: historicalAudit.findingCodes.length };
  value.audit = { ...completeCodes, findingCounts: { PRIVATE_PROVIDER_CODE: 3 } };
  assert.deepEqual(sanitizeLiveValidationObservation(value).audit, completeCodes);
});
test('optional clarification observations expose only bounded counts and invariants', () => {
  const value = observation(true);
  assert.equal(Object.hasOwn(sanitizeLiveValidationObservation(value), 'clarification'), false);
  value.clarification = { ...clarificationFixture(), workflowId: 'private-workflow', sessionId: 'private-session',
    replies: [{ question: 'private reply' }], selectedEvidenceIds: ['private-evidence'] };
  const sanitized = sanitizeLiveValidationObservation(value);
  assert.deepEqual(sanitized.clarification, clarificationFixture());
  assert.doesNotMatch(JSON.stringify(sanitized), /private/);
  for (const mutation of [{ version: 2 }, { submittedCount: 9 }, { completedCount: 5 }, { postAcquisitionCount: 5 },
    { completedCount: -1 }, { submittedCount: 4.5 }, { sameWorkflow: 'true' }, { acquisitionCount: 2 }]) {
    value.clarification = { ...clarificationFixture(), ...mutation };
    assert.equal(Object.hasOwn(sanitizeLiveValidationObservation(value), 'clarification'), false);
  }
});
test('required clarification proof passes only with exact counts and retained single-workflow evidence', async t => {
  const requiredProfiles = profileFixture();
  requiredProfiles.profiles[0].expected.clarification = { completedCount: 4, postAcquisitionCount: 3 };
  requiredProfiles.profiles[0].expected.requiredModelStages = ['intake', 'reasoning', 'final'];
  const f = fixture(t); const e = executionFixture(f, { profiles: requiredProfiles,
    mutateObservation: value => { value.clarification = clarificationFixture(); } });
  const result = await execute(f, e);
  assert.equal(result.status, 'PASS'); assert.equal(e.stopped(), true);
  assert.deepEqual(result.cases[0].observation.clarification, clarificationFixture());
});
test('valid clarification proof cannot replace a required model stage and still cleans up only the owned deployment', async t => {
  const requiredProfiles = profileFixture();
  requiredProfiles.profiles[0].expected.clarification = { completedCount: 4, postAcquisitionCount: 3 };
  requiredProfiles.profiles[0].expected.requiredModelStages = ['intake', 'reasoning', 'final'];
  const f = fixture(t); const e = executionFixture(f, { profiles: requiredProfiles, mutateObservation: value => {
    value.clarification = clarificationFixture(); value.stages.reasoning = { status: 'not_run', elapsedMs: null };
  } });
  const result = await execute(f, e);
  assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_STAGE_FAILED');
  assert.deepEqual(result.observedCases[0].observation.clarification, clarificationFixture());
  assert.equal(result.cleanup.status, 'PASS'); assert.equal(e.stopped(), true);
  const state = JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'controller-state.private.json'), 'utf8'));
  assert.equal(state.runtimeDeployAttempted, true); assert.equal(state.cleanupComplete, true);
});
test('runtime claimed PASS cannot replace missing, malformed or contradictory clarification proof', async t => {
  const mutations = [undefined, { version: 2 }, { submittedCount: 9 }, { completedCount: 5 }, { postAcquisitionCount: 5 },
    { submittedCount: 5 }, { completedCount: 3, postAcquisitionCount: 3 }, { postAcquisitionCount: 2 },
    { sameWorkflow: false }, { revisionsAdvanced: false }, { retainedEvidence: false }, { budgetsPreserved: false },
    { acquisitionCount: 0 }, { acquisitionCount: 2 }, { revisionsAdvanced: 'true' }];
  for (const mutation of mutations) await t.test(JSON.stringify(mutation) ?? 'absent', async child => {
    const requiredProfiles = profileFixture();
    requiredProfiles.profiles[0].expected.clarification = { completedCount: 4, postAcquisitionCount: 3 };
    const f = fixture(child); const e = executionFixture(f, { profiles: requiredProfiles,
      mutateObservation: value => { if (mutation) value.clarification = { ...clarificationFixture(), ...mutation }; } });
    const result = await execute(f, e);
    assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_CLARIFICATION_FAILED');
    assert.equal(result.observedCases[0].runtimeClaimedPass, true); assert.equal(e.stopped(), true);
  });
});
test('legacy profiles allow no clarification proof and direct paths require one observed model stage', async t => {
  const f = fixture(t); const e = executionFixture(f, { mutateObservation: value => {
    value.stages.intake = { status: 'not_run', elapsedMs: null };
    value.stages.reasoning = { status: 'not_run', elapsedMs: null };
  } });
  const result = await execute(f, e);
  assert.equal(result.status, 'PASS'); assert.equal(Object.hasOwn(result.cases[0].observation, 'clarification'), false);
  assert.equal(result.cases[0].observation.stages.final.status, 'passed');
});
test('positive proof rejects failed or unobserved model execution despite aggregate provider calls', async t => {
  for (const status of ['not_run', 'started', 'failed', 'timed_out', 'passed']) await t.test(status, async child => {
    const f = fixture(child); const e = executionFixture(f, { mutateObservation: value => {
      for (const stage of ['intake', 'reasoning', 'final']) value.stages[stage] = { status, elapsedMs: null };
    } });
    const result = await execute(f, e);
    assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_STAGE_FAILED');
    assert.equal(result.actualUsage.generationCalls, 1); assert.equal(result.actualUsage.auditCalls, 1);
    assert.equal(e.stopped(), true);
  });
});
test('profiles can require all measured model stages without requiring clarification proof', async t => {
  const requiredProfiles = profileFixture();
  requiredProfiles.profiles[0].expected.requiredModelStages = ['intake', 'reasoning', 'final'];
  const f = fixture(t); const e = executionFixture(f, { profiles: requiredProfiles });
  const result = await execute(f, e);
  assert.equal(result.status, 'PASS');
  assert.equal(Object.hasOwn(result.cases[0].observation, 'clarification'), false);
});
test('required model stages and positive acquisition/audit/response stages must complete with timing evidence', async t => {
  for (const stage of ['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response']) {
    for (const status of ['not_run', 'failed', 'timed_out', 'passed']) await t.test(`${stage} ${status}`, async child => {
      const requiredProfiles = profileFixture();
      requiredProfiles.profiles[0].expected.requiredModelStages = ['intake', 'reasoning', 'final'];
      const f = fixture(child); const e = executionFixture(f, { profiles: requiredProfiles, mutateObservation: value => {
        value.stages[stage] = { status, elapsedMs: status === 'passed' ? null : 10 };
      } });
      const result = await execute(f, e);
      assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_STAGE_FAILED');
      assert.equal(e.stopped(), true);
    });
  }
});
test('malformed bounded clarification or model-stage requirements fail before deployment or paid admission', async t => {
  const requirements = [{ clarification: null }, { clarification: { completedCount: 0, postAcquisitionCount: 0 } },
    { clarification: { completedCount: 9, postAcquisitionCount: 3 } }, { clarification: { completedCount: 4, postAcquisitionCount: 5 } },
    { clarification: { completedCount: 4, postAcquisitionCount: 3, workflowId: 'private' } },
    { requiredModelStages: [] }, { requiredModelStages: ['final', 'final'] }, { requiredModelStages: ['generation'] },
    { requiredModelStages: ['private prompt'] }, { requiredModelStages: 'final' }];
  for (const requirement of requirements) await t.test(JSON.stringify(requirement), async child => {
    const requiredProfiles = profileFixture(); Object.assign(requiredProfiles.profiles[0].expected, requirement);
    const f = fixture(child); const e = executionFixture(f, { profiles: requiredProfiles });
    await assert.rejects(execute(f, e), { code: 'LIVE_VALIDATION_PROFILE_INVALID' }); assert.deepEqual(e.seen, []);
  });
});
test('cleanup refuses mismatched deployment ID, project, environment, service or source before any mutation', async t => {
  const target = targetFixture();
  for (const changes of [{ id: runtimeId }, { projectId: envId }, { environmentId: runtimeId },
    { serviceId: runtimeDeploymentId }, { meta: { repo: target.repository, commitHash: trustedSha } }]) {
    await t.test(JSON.stringify(changes), async () => {
      const state = cleanupState(target); const mutations = [];
      const railway = { async inventory() { return inventory(target); },
        async deployment() { return { ...deployment(target), ...changes }; },
        async stop(id) { mutations.push(['stop', id]); }, async cancel(id) { mutations.push(['cancel', id]); } };
      const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway, writeState: () => {} });
      assert.equal(result.status, 'FAIL'); assert.equal(state.cleanupComplete, false); assert.deepEqual(mutations, []);
    });
  }
});
test('cleanup cancels interrupted queued and building deployments and verifies exact-owned terminal readback', async t => {
  const target = targetFixture();
  for (const status of ['QUEUED', 'BUILDING']) await t.test(status, async () => {
    const state = cleanupState(target); let cancelled = false; const mutations = [];
    const railway = { async inventory() { return inventory(target); },
      async deployment(id) { assert.equal(id, runtimeDeploymentId); return { ...deployment(target), status: cancelled ? 'REMOVED' : status }; },
      async cancel(id) { mutations.push(['cancel', id]); cancelled = true; }, async stop(id) { mutations.push(['stop', id]); } };
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway, writeState: () => {} });
    assert.equal(result.status, 'PASS'); assert.equal(result.runtimeDeploymentStopped, true); assert.equal(result.runClosed, true);
    assert.equal(state.cleanupComplete, true); assert.deepEqual(mutations, [['cancel', runtimeDeploymentId]]);
  });
});
test('cleanup stops its verified deployment despite inventory drift or metadata unavailability and reports failure', async t => {
  const target = targetFixture();
  for (const drift of ['shared-variable', 'overlap', 'unavailable']) await t.test(drift, async () => {
    const state = cleanupState(target, { runStarted: true }); let stopped = false; const mutations = [];
    const railway = { async inventory() {
      if (drift === 'unavailable') throw new Error('metadata unavailable');
      const raw = inventory(target, true, stopped);
      if (drift === 'shared-variable') raw.environment.config.sharedVariables.OPENAI_API_KEY = {};
      if (drift === 'overlap') raw.environment.serviceInstances.edges[0].node.activeDeployments.push({ ...deployment(target), id: runtimeId });
      return raw;
    }, async deployment(id) { assert.equal(id, runtimeDeploymentId); return deployment(target, stopped); },
    async stop(id) { mutations.push(['stop', id]); stopped = true; }, async cancel(id) { mutations.push(['cancel', id]); } };
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway, writeState: () => {} });
    assert.equal(result.status, 'FAIL'); assert.equal(result.runtimeDeploymentStopped, true); assert.equal(result.runClosed, true);
    assert.equal(state.cleanupComplete, false); assert.equal(result.definitionsRetained, false);
    assert.ok(result.failures.length > 0); assert.deepEqual(mutations, [['stop', runtimeDeploymentId]]);
  });
});
test('cleanup rejects mismatched or unterminated cancellation readback', async t => {
  const target = targetFixture();
  for (const changes of [{ id: runtimeId }, { status: 'BUILDING' }]) await t.test(JSON.stringify(changes), async () => {
    let reads = 0; let cancellations = 0; let clock = 1_000_000;
    const state = cleanupState(target);
    const railway = { async inventory() { return inventory(target); },
      async deployment() { return { ...deployment(target), status: ++reads === 1 ? 'BUILDING' : 'REMOVED', ...(reads > 1 ? changes : {}) }; },
      async cancel() { cancellations++; }, async stop() { assert.fail('must cancel a build'); } };
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway,
      writeState: () => {}, now: () => clock, sleep: async ms => { clock += ms; } });
    assert.equal(result.status, 'FAIL'); assert.equal(result.runtimeDeploymentStopped, false); assert.equal(cancellations, 1);
    assert.ok(clock <= 1_060_000);
  });
});
test('cleanup waits for asynchronous removal and rechecks ownership on each readback', async t => {
  const target = targetFixture();
  for (const swapped of [false, true]) await t.test(String(swapped), async () => {
    let reads = 0; let polls = 0; let clock = 1_000_000;
    const state = cleanupState(target);
    const railway = { async inventory() { return inventory(target); }, async cancel(id) { assert.equal(id, runtimeDeploymentId); },
      async deployment() { return { ...deployment(target), status: ++reads < 3 ? 'BUILDING' : 'REMOVED',
        ...(swapped && reads === 3 ? { id: runtimeId } : {}) }; }, async stop() { assert.fail('must cancel a build'); } };
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway,
      writeState: () => {}, now: () => clock, sleep: async ms => { clock += ms; polls++; } });
    assert.equal(result.status, swapped ? 'FAIL' : 'PASS'); assert.equal(polls, 1); assert.equal(reads, 3);
    assert.equal(result.runtimeDeploymentStopped, !swapped);
  });
});
test('cleanup changes a rejected build cancellation to stop only after verifying a running owned deployment', async t => {
  const target = targetFixture();
  for (const readback of ['running', 'foreign', 'unchanged', 'unavailable']) await t.test(readback, async () => {
    let reads = 0; let stopped = false; const mutations = [];
    const state = cleanupState(target);
    const railway = { async inventory() { return inventory(target); }, async deployment() {
      reads++;
      if (reads > 1 && readback === 'unavailable') throw new Error('metadata unavailable');
      return { ...deployment(target, stopped), status: reads === 1 || readback === 'unchanged' ? 'BUILDING' : 'SUCCESS',
        ...(reads > 1 && readback === 'foreign' ? { id: runtimeId } : {}) };
    }, async cancel(id) { mutations.push(['cancel', id]); throw Object.assign(new Error('not building'), { code: 'LIVE_VALIDATION_CLEANUP_CANCEL_FAILED' }); },
    async stop(id) { mutations.push(['stop', id]); stopped = true; } };
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway, writeState: () => {} });
    assert.equal(result.status, readback === 'running' ? 'PASS' : 'FAIL');
    assert.equal(result.runtimeDeploymentStopped, readback === 'running');
    assert.deepEqual(mutations, [['cancel', runtimeDeploymentId], ...(readback === 'running' ? [['stop', runtimeDeploymentId]] : [])]);
    if (readback === 'unchanged' || readback === 'unavailable') assert.ok(result.failures.includes('LIVE_VALIDATION_CLEANUP_CANCEL_FAILED'));
  });
});
test('crashed cleanup requires stopped readback unless effective deployment policy proves NEVER restart', async t => {
  const target = targetFixture();
  for (const restartPolicyType of ['NEVER', 'ALWAYS']) await t.test(restartPolicyType, async () => {
    const state = cleanupState(target); let stopped = false; let stops = 0;
    const railway = { async inventory() {
      const raw = inventory(target); raw.environment.serviceInstances.edges[0].node.restartPolicyType = restartPolicyType; return raw;
    }, async deployment() { const value = { ...deployment(target, stopped), status: 'CRASHED' };
      value.meta.serviceManifest.deploy.restartPolicyType = restartPolicyType; return value; },
    async stop(id) { assert.equal(id, runtimeDeploymentId); stopped = true; stops++; }, async cancel() { assert.fail('must not cancel a crashed runtime'); } };
    const result = await cleanupLiveValidationRun({ target, args: { prNumber: 1528, commitSha: sha }, state, railway, writeState: () => {} });
    assert.equal(result.status, restartPolicyType === 'NEVER' ? 'PASS' : 'FAIL');
    assert.equal(result.runtimeDeploymentStopped, true); assert.equal(stops, restartPolicyType === 'NEVER' ? 0 : 1);
  });
});
test('Railway API requests only variable names and explicitly pinned deploy and token binding mutations', async t => {
  const f = fixture(t); const calls = []; const client = createLiveValidationRailwayApi({ token: 'fixture-test-scoped-token', fetchImplementation: async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const data = request.query.includes('variableUpsert') ? { variableUpsert: true }
      : request.query.includes('deploymentCancel') ? { deploymentCancel: true }
        : request.query.includes('deploymentStop') ? { deploymentStop: true } : { serviceInstanceDeployV2: runtimeDeploymentId };
    return new Response(JSON.stringify({ data }), { status: 200 });
  } });
  await client.bindTestToken(f.target, 'a'.repeat(64)); await client.deploy(f.target, 'runtime', sha); await client.inventory(f.target);
  assert.equal(calls[0].variables.input.skipDeploys, true); assert.equal(calls[0].variables.input.name, 'ARCANOS_LIVE_VALIDATION_TEST_TOKEN');
  assert.equal(calls[1].variables.commitSha, sha); assert.match(calls[2].query, /decryptVariables:false/); assert.doesNotMatch(calls[2].query, /variablesForServiceDeployment|node\{name.*value/);
  await client.cancel(runtimeDeploymentId); await client.stop(runtimeDeploymentId);
  assert.match(calls[3].query, /deploymentCancel\(id:\$id\)/); assert.equal(calls[3].variables.id, runtimeDeploymentId);
  assert.match(calls[4].query, /deploymentStop\(id:\$id\)/); assert.equal(calls[4].variables.id, runtimeDeploymentId);
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
  assert.deepEqual(actual.modelValidation, [{ stage: 'metadata', outcome: 'completed',
    elapsedMs: provider.snapshot().stages[0].elapsedMs, reserved: true }]);
  assert.deepEqual(actual.answerAuditProvider, [{ outcome: 'completed',
    elapsedMs: provider.snapshot().stages[2].elapsedMs }]);
  assert.equal(actual.providerCalls, 2); assert.equal(actual.generationCalls, 1); assert.equal(actual.auditCalls, 1);
  assert.equal(actual.observedInputTokens, 20); assert.equal(actual.observedOutputTokens, 10);
  assert.equal(actual.observedTotalTokens, 30);
  assert.ok(actual.reservedSpendMicroUsd >= actual.observedSpendMicroUsd);
});

test('controller retains a reserved audit failure when the run expires during settlement', async t => {
  const { target } = fixture(t);
  const plan = { runId: 'a'.repeat(32), commitSha: sha, prNumber: 1528, runtimeDeploymentId, profileHash: 'b'.repeat(64) };
  const model = target.models[0].id;
  const observation = { moduleId: 'gaming', stage: 'generation' };
  const expiresAtMs = 10_000;
  let nowMs = 0;
  const provider = createLiveValidationProvider({ target,
    identity: { sourceCommit: sha, deploymentId: runtimeDeploymentId },
    apiKey: 'sk-unit-test-fixture-' + 'x'.repeat(40), observation: () => observation,
    now: () => nowMs, expiresAtMs,
    fetchImplementation: async () => {
      if (observation.stage === 'answer_audit') nowMs = expiresAtMs;
      return Response.json({ id: 'response', object: 'response', model, output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    } });
  t.after(() => provider.close());
  provider.beginWorkflow('gaming-guide-positive');
  const invoke = () => provider.fetch('https://api.openai.com/v1/responses', { method: 'POST',
    body: JSON.stringify({ model, input: 'Use acquired source evidence.', max_output_tokens: 100 }) });
  await invoke();
  observation.stage = 'answer_audit';
  await assert.rejects(invoke(), { code: 'LIVE_VALIDATION_BUDGET_EXPIRED' });
  const snapshot = provider.snapshot();
  assert.equal(snapshot.closed, true);
  assert.equal(snapshot.usage.auditCalls, 1);
  assert.equal(snapshot.stages[1].code, 'LIVE_VALIDATION_BUDGET_EXPIRED');
  const actual = sanitizeLiveValidationUsage({ ...plan, ...snapshot, status: 'stopped' }, { plan, target });
  assert.deepEqual(actual.answerAuditProvider, [
    { outcome: 'failed', elapsedMs: expiresAtMs, code: 'LIVE_VALIDATION_BUDGET_EXPIRED' }
  ]);
});

test('answer audit provider receipt keeps only bounded reserved-call diagnostics', t => {
  const { target } = fixture(t);
  const plan = { runId: 'a'.repeat(32), commitSha: sha, prNumber: 1528, runtimeDeploymentId, profileHash: 'b'.repeat(64) };
  const provider = createLiveValidationProvider({ target, identity: { sourceCommit: sha, deploymentId: runtimeDeploymentId },
    apiKey: 'sk-unit-test-fixture-' + 'x'.repeat(40), fetchImplementation: () => assert.fail('unexpected transport') });
  t.after(() => provider.close());
  const snapshot = provider.snapshot();
  const summarize = (stages, auditCalls = 1) => sanitizeLiveValidationUsage({ ...plan, ...snapshot, stages,
    usage: { ...snapshot.usage, requests: auditCalls, providerCalls: auditCalls, auditCalls } }, { plan, target });
  const stage = { stage: 'answer_audit', outcome: 'failed', elapsedMs: 34 };
  const codes = ['LIVE_VALIDATION_PROVIDER_TIMEOUT', 'LIVE_VALIDATION_PROVIDER_CANCELLED', 'LIVE_VALIDATION_RUN_CLOSED',
    'LIVE_VALIDATION_PROVIDER_MODEL_MISMATCH', 'LIVE_VALIDATION_PROVIDER_FAILED', 'LIVE_VALIDATION_PROVIDER_RESPONSE_INVALID',
    'LIVE_VALIDATION_PROVIDER_RESPONSE_LIMIT', 'LIVE_VALIDATION_USAGE_INVALID'];
  assert.equal(summarize(undefined).answerAuditProvider, undefined);
  assert.deepEqual(summarize([stage]).answerAuditProvider, [{ outcome: 'failed', elapsedMs: 34 }]);
  for (const code of codes) {
    const usage = summarize([{ ...stage, code, model: 'private model', actualModel: 'private provider model',
      caseId: 'private case', requestId: 'private request', rawBody: 'private response' }]);
    assert.deepEqual(usage.answerAuditProvider, [{ outcome: 'failed', elapsedMs: 34, code }]);
    assert.doesNotMatch(JSON.stringify(usage), /private/);
  }
  assert.equal(summarize([stage], 0).answerAuditProvider, undefined);
  for (const stages of [[stage, stage], Array(target.limits.maxRequests + 2).fill({ stage: 'generation' }),
    [{ ...stage, outcome: 'private outcome' }], [{ ...stage, code: 'LIVE_VALIDATION_PRIVATE_PAYLOAD' }],
    [{ ...stage, elapsedMs: -1 }], [{ ...stage, elapsedMs: target.limits.durationMs + 1 }],
    [{ ...stage, outcome: 'completed', code: codes[0] }]]) {
    const usage = summarize(stages);
    assert.equal(usage.answerAuditProvider, undefined);
    assert.equal(usage.auditCalls, 1);
  }
});

test('model validation receipt preserves bounded outcomes and drops raw or inconsistent diagnostics', t => {
  const { target } = fixture(t);
  const plan = { runId: 'a'.repeat(32), commitSha: sha, prNumber: 1528, runtimeDeploymentId, profileHash: 'b'.repeat(64) };
  const provider = createLiveValidationProvider({ target, identity: { sourceCommit: sha, deploymentId: runtimeDeploymentId },
    apiKey: 'sk-unit-test-fixture-' + 'x'.repeat(40), fetchImplementation: () => assert.fail('unexpected transport') });
  t.after(() => provider.close());
  const snapshot = provider.snapshot();
  const summarize = (stages, metadataRequests = 1) => sanitizeLiveValidationUsage({ ...plan, ...snapshot, stages,
    usage: { ...snapshot.usage, requests: metadataRequests, metadataRequests } }, { plan, target });
  const stage = { stage: 'metadata', outcome: 'failed', code: 'LIVE_VALIDATION_METADATA_NOT_FOUND',
    elapsedMs: 12, reserved: true };
  const legacy = { ...stage, code: 'LIVE_VALIDATION_MODEL_VALIDATION_FAILED' };
  delete legacy.reserved;
  const rejected = { ...stage, code: 'LIVE_VALIDATION_BUDGET_EXHAUSTED', elapsedMs: 0, reserved: false };
  assert.equal(summarize(undefined).modelValidation, undefined);
  assert.deepEqual(summarize([legacy]).modelValidation, [{ ...legacy, reserved: true }]);
  for (const code of ['LIVE_VALIDATION_METADATA_UNAUTHORIZED', 'LIVE_VALIDATION_METADATA_FORBIDDEN',
    'LIVE_VALIDATION_METADATA_RATE_LIMITED', 'LIVE_VALIDATION_METADATA_ACCESS_DENIED']) {
    const classified = { ...stage, code };
    assert.deepEqual(summarize([{ ...classified, rawBody: 'private upstream error' }]).modelValidation, [classified]);
    assert.equal(summarize([{ ...classified, reserved: false }], 0).modelValidation, undefined);
  }
  assert.deepEqual(summarize([{ ...stage, model: 'private model label', message: 'private provider message' },
    rejected, { stage: 'generation', outcome: 'failed', code: 'private content error' }]).modelValidation, [stage, rejected]);
  assert.deepEqual(summarize([rejected], 0).modelValidation, [rejected]);
  assert.equal(summarize([{ ...stage, reserved: false }], 0).modelValidation, undefined);
  for (const stages of [[{ ...stage, code: 'LIVE_VALIDATION_PRIVATE_PAYLOAD' }], [{ ...stage, elapsedMs: -1 }],
    [{ ...stage, reserved: 'private reservation marker' }], [{ ...stage, elapsedMs: target.limits.durationMs + 1 }],
    [stage, stage], [rejected, rejected], Array(target.limits.maxRequests + 2).fill(stage)]) {
    const usage = summarize(stages);
    assert.equal(usage.modelValidation, undefined);
    assert.equal(usage.metadataRequests, 1);
  }
});
