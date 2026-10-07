import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLiveValidationController } from './live-validation-controller.mjs';
import { createValidationRuntimeApplication } from './start-live-validation-runtime.mjs';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { LIVE_VALIDATION_PROJECT_ID, LIVE_VALIDATION_HARD_LIMITS, LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID } from './live-validation-target.mjs';
import { canonicalLiveValidationJson, validationHash } from './live-validation-bootstrap.mjs';
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
    status: 'SUCCESS', deploymentStopped: stopped, meta: { repo: target.repository, commitHash: sha,
      serviceManifest: { deploy: { restartPolicyType: 'NEVER', numReplicas: 1, multiRegionConfig: { 'us-west2': { numReplicas: 1 } } } } } };
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
function observation(positive) {
  return { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: positive ? 'accepted' : 'need_new_source',
    reason: positive ? null : 'GAME_MISMATCH', semanticGap: positive ? 'NONCRITICAL_GAP' : 'CONFLICT',
    coverage: { satisfied: positive, assessmentStatus: 'assessed', missingCount: positive ? 0 : 1 },
    selectedCandidateCount: positive ? 1 : 0, selectedEvidenceCount: positive ? 1 : 0,
    candidates: positive ? [] : [{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }],
    qualification: { visible: positive, patchCompatibility: 'unverified', claimsVerifiedCurrentness: false },
    audit: positive ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true } : null,
    ...(positive ? { clarification: { version: 1, submittedCount: 4, completedCount: 4, postAcquisitionCount: 3,
      sameWorkflow: true, revisionsAdvanced: true, retainedEvidence: true, budgetsPreserved: true, acquisitionCount: 1 } } : {}),
    auditStartBudget: { runtimeRemainingMs: 120000, requestRemainingMs: 120000 },
    stages: Object.fromEntries(['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response']
      .map(stage => [stage, { status: positive || ['acquisition', 'selection', 'response'].includes(stage) ? 'passed' : 'not_run', elapsedMs: positive ? 10 : null }])) };
}

test('controller uses its real service client, runtime HTTP auth and direct SDK provider through both profiles and cleanup', async t => {
  const f = fixture(t); let token; let active = false; let stopped = false; let providerCalls = 0; let server; let origin;
  let application; const routes = []; const providerUrls = [];
  const railway = {
    async inventory() { return inventory(f.target, active, stopped); },
    async bindTestToken(target, value) { assert.equal(target.runtimeServiceId, runtimeId); token = value; },
    async deploy(target, role, commitSha) {
      assert.equal(commitSha, sha); assert.equal(role, 'runtime'); active = true;
      let lastObservation;
      application = createValidationRuntimeApplication({ target, identity: identity(target), profiles,
        buildManifest: identity(target).buildManifest, testToken: token, apiKey: 'sk-offline-test-synthetic-validation-credential',
        resolveResponseModelIdentity: async () => (response, expected) => response.model === expected ? expected : undefined,
        createProvider: options => createLiveValidationProvider({ ...options, fetchImplementation: async (url, init) => {
          providerCalls++; providerUrls.push(url); const body = JSON.parse(init.body);
          assert.match(init.headers.authorization, /^Bearer sk-/u); assert.equal(init.redirect, 'error');
          return new Response(JSON.stringify({ id: 'offline-response', object: 'response', model: body.model, status: 'completed', output: [],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
        } }),
        createAdapter: async ({ provider, observation: getStage }) => {
          const client = new OpenAI({ apiKey: 'validation-provider-placeholder', baseURL: 'https://api.openai.com/v1', maxRetries: 0, fetch: provider.fetch });
          return { validateInput: input => ({ ok: true, input }), getLastObservation: () => structuredClone(lastObservation),
            execute: async (input, hooks) => {
              const entry = profiles.profiles.find(item => item.input.query.idempotencyKey === input.query.idempotencyKey);
              const positive = entry.id === 'gaming-guide-positive'; hooks.onSourceAcquisition('passed');
              hooks.onSourceValidation(positive ? 'passed' : 'rejected'); lastObservation = observation(positive);
              if (!positive) return { accepted: false, failureCode: 'INCOMPATIBLE_SOURCE' };
              assert.equal(getStage().stage, 'generation');
              await client.responses.create({ model: target.models[0].id, input: 'Offline grounded guide fixture.', max_output_tokens: 100 });
              hooks.onAnswerAuditStart(); assert.equal(getStage().stage, 'answer_audit');
              await client.responses.create({ model: target.models[1].id, input: 'Offline mandatory audit fixture.', max_output_tokens: 100 });
              return { accepted: true, audit: { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true },
                result: { ok: true, route: 'gaming', mode: 'guide', data: { response: 'Use the documented early blade path [1].',
                  sources: [{ url: entry.input.candidateUrls[0], snippet: 'Offline acquired evidence fixture.' }],
                  grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true, fetchedSuppliedSourceCount: 1, usableSourceCount: 1,
                    citableSourceCount: 1, selectedChunkCount: 1, suppliedEvidenceSourceCount: 1 } } } };
            } };
        } });
      server = createServer((request, response) => { routes.push(request.url); void application.handler(request, response); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
      return runtimeDeploymentId;
    },
    async deployment() { return deployment(f.target, stopped); },
    async stop(id) { assert.equal(id, runtimeDeploymentId); stopped = true; }
  };
  t.after(async () => { application?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const result = await runLiveValidationController([...f.argv, '--execute', '--allow-paid-provider'], {
    environment: f.environment, readGitState: () => git, createGitHubApi: () => ghFixture(f), createRailwayApi: () => railway,
    // This controlled boundary maps only the already verified Railway origin to a real loopback HTTP server.
    fetchImplementation: (url, init) => {
      const requested = new URL(url); assert.equal(requested.origin, f.target.publicOrigin);
      return fetch(origin + requested.pathname, init);
    }
  });
  assert.equal(result.status, 'PASS', result.code); assert.deepEqual(result.cases.map(item => item.status), ['PASS', 'PASS']);
  assert.equal(providerCalls, 2); assert.deepEqual(providerUrls, ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
  assert.deepEqual(result.cases[1].actualUsage, { providerCalls: 0, generationCalls: 0, auditCalls: 0 });
  assert.equal(result.actualUsage.workflows, 2); assert.equal(result.actualUsage.metadataRequests, 0); assert.equal(result.actualUsage.observedTotalTokens, 6);
  assert.equal(stopped, true); assert.ok(routes.includes('/stop')); assert.equal(result.cleanup.runClosed, true);
  assert.equal(JSON.stringify(result).includes(token), false); assert.equal(JSON.stringify(result).includes('sk-offline-test-synthetic-validation-credential'), false);
});
