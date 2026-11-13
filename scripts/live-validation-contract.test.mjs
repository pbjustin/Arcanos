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
    reason: positive ? null : 'GAME_MISMATCH', semanticGap: positive ? 'NONE' : 'CONFLICT',
    coverage: { satisfied: positive, assessmentStatus: 'assessed', missingCount: positive ? 0 : 1 },
    selectedCandidateCount: positive ? 1 : 0, selectedEvidenceCount: positive ? 1 : 0,
    candidates: positive ? [] : [{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }],
    qualification: { visible: false, patchCompatibility: positive ? 'not_required' : 'unverified', claimsVerifiedCurrentness: false },
    audit: positive ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true } : null,
    auditStartBudget: { runtimeRemainingMs: 120000, requestRemainingMs: 120000 },
    stages: Object.fromEntries(['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response']
      .map(stage => [stage, { status: positive || ['acquisition', 'selection', 'response'].includes(stage) ? 'passed' : 'not_run', elapsedMs: positive ? 10 : null }])) };
}

async function exerciseController(t, { metadataStatus = 200, auditStatus = 200, rejectAnswer = false } = {}) {
  const f = fixture(t); let token; let active = false; let stopped = false; let providerCalls = 0; let server; let origin;
  let application; const routes = []; const providerUrls = [];
  // Controlled adapter/provider fixtures exercise transport and retention only;
  // this prose is not an acquired publisher claim or a live model answer.
  const answer = '1. Follow the documented system-colonisation starting procedure [1].';
  const contextFingerprint = '9'.repeat(64); let expectedPrivateAnswer;
  const rejectedAudit = { assessmentStatus: 'completed', decision: 'reject', boundToFinalAnswer: false };
  const rejectionDiagnostics = { effectiveTimeoutMs: 12_000, blockingFindingCount: 8,
    findingCodes: ['MATERIAL_FACT_UNRESOLVED', 'PROFILE_FLOOR_NOT_MET', 'UNCLASSIFIED_AUDIT_FINDING'],
    findingCounts: { MATERIAL_FACT_UNRESOLVED: 2, PROFILE_FLOOR_NOT_MET: 1, UNCLASSIFIED_AUDIT_FINDING: 5 },
    unmappedFindingCount: 3 };
  assert.equal(profiles.profiles[0].input.query.game, 'Elite Dangerous');
  assert.equal(profiles.profiles[0].expected.semanticGap, 'NONE');
  assert.equal(profiles.profiles[0].input.clarificationReplies, undefined);
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
          providerCalls++; providerUrls.push(url);
          assert.match(init.headers.authorization, /^Bearer sk-/u); assert.equal(init.redirect, 'error');
          if (init.method === 'GET') return metadataStatus === 200
            ? Response.json({ id: target.models[1].id, object: 'model' })
            : Response.json({ error: { message: 'private upstream fixture body' } }, { status: metadataStatus });
          if (options.observation().stage === 'answer_audit' && auditStatus !== 200) {
            return Response.json({ error: { message: 'private upstream audit rejection' } }, { status: auditStatus });
          }
          const body = JSON.parse(init.body);
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
              try { await client.models.retrieve(target.models[1].id); }
              catch (error) {
                lastObservation = { ...lastObservation, outcome: 'unavailable', reason: 'GENERATION_UNAVAILABLE',
                  semanticGap: 'UNOBSERVED', audit: null, stages: { ...lastObservation.stages,
                    generation: { status: 'failed', elapsedMs: 10 }, intake: { status: 'not_run', elapsedMs: null },
                    reasoning: { status: 'not_run', elapsedMs: null }, final: { status: 'not_run', elapsedMs: null },
                    answer_audit: { status: 'not_run', elapsedMs: null } } };
                throw error;
              }
              await client.responses.create({ model: target.models[0].id, input: 'Offline grounded guide fixture.', max_output_tokens: 100 });
              hooks.onAnswerAuditStart(); assert.equal(getStage().stage, 'answer_audit');
              try {
                await client.responses.create({ model: target.models[1].id, input: 'Offline mandatory audit fixture.', max_output_tokens: 100 });
              } catch {
                const audit = { assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false };
                lastObservation = { ...lastObservation, outcome: 'unavailable', reason: 'GENERATION_UNAVAILABLE',
                  semanticGap: 'UNOBSERVED', audit: { ...audit, reasonCode: 'AUDIT_PROVIDER_ERROR', effectiveTimeoutMs: 12_000 },
                  stages: { ...lastObservation.stages, answer_audit: { status: 'failed', elapsedMs: 10 } } };
                return { accepted: false, audit };
              }
              const result = { ok: true, route: 'gaming', mode: 'guide', data: { response: answer,
                sources: [{ url: entry.input.candidateUrls[0], snippet: 'Offline acquired evidence fixture.' }],
                grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true, fetchedSuppliedSourceCount: 1, usableSourceCount: 1,
                  citableSourceCount: 1, selectedChunkCount: 1, suppliedEvidenceSourceCount: 1 } } };
              expectedPrivateAnswer = { version: 1, response: answer, subjectHash: validationHash(answer), contextFingerprint,
                sources: entry.input.candidateUrls.map((url, index) => ({ index: index + 1, url })) };
              if (rejectAnswer) {
                lastObservation = { ...lastObservation, outcome: 'unavailable', reason: 'GENERATION_UNAVAILABLE',
                  semanticGap: 'UNOBSERVED', audit: { ...rejectedAudit, ...rejectionDiagnostics } };
                result.data.response = 'Offline fallback without an audited guide.';
                result.data.fallbackReason = 'GAMING_ANSWER_REJECTED';
                return { accepted: false, audit: rejectedAudit, result, privateAnswer: expectedPrivateAnswer };
              }
              return { accepted: true, audit: { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true },
                privateAnswer: expectedPrivateAnswer, result };
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
  const modelUrl = 'https://api.openai.com/v1/models/' + f.target.models[1].id;
  if (metadataStatus === 404) {
    assert.equal(result.status, 'FAILED'); assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_FAILED');
    assert.equal(result.observedCases[0].observation.reason, 'GENERATION_UNAVAILABLE');
    assert.equal(result.observedCases[0].observation.coverage.satisfied, true);
    assert.deepEqual(providerUrls, [modelUrl]); assert.equal(providerCalls, 1);
    assert.equal(result.actualUsage.metadataRequests, 1);
    assert.equal(result.actualUsage.generationCalls, 0); assert.equal(result.actualUsage.auditCalls, 0);
    assert.equal(result.usageReadback, 'PASS'); assert.equal(result.cleanup.runClosed, true);
    const summaryText = readFileSync(path.join(f.directory, 'evidence', 'acceptance-summary.json'), 'utf8');
    const [{ elapsedMs, ...lookup }] = JSON.parse(summaryText).actualUsage.modelValidation;
    assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
    assert.deepEqual(lookup, { stage: 'metadata', outcome: 'failed', reserved: true, code: 'LIVE_VALIDATION_METADATA_NOT_FOUND' });
    for (const privateValue of [token, 'private upstream fixture body', modelUrl, 'sk-offline-test-synthetic-validation-credential']) {
      assert.equal(summaryText.includes(privateValue), false);
    }
    return;
  }
  if (auditStatus !== 200 || rejectAnswer) {
    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'LIVE_VALIDATION_PROFILE_FAILED');
    assert.equal(result.observedCases.length, 1);
    assert.equal(result.observedCases[0].caseId, 'gaming-guide-positive');
    assert.equal(result.actualUsage.workflows, 1);
    assert.equal(providerCalls, 3);
    assert.equal(result.actualUsage.generationCalls, 1);
    assert.equal(result.actualUsage.auditCalls, 1);
    assert.equal(result.cleanup.runClosed, true);
    const summaryText = readFileSync(path.join(f.directory, 'evidence', 'acceptance-summary.json'), 'utf8');
    const summary = JSON.parse(summaryText);
    const observed = summary.observedCases[0];
    assert.deepEqual(observed.observation.audit, rejectAnswer ? { ...rejectedAudit, ...rejectionDiagnostics } : {
      assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false,
      reasonCode: 'AUDIT_PROVIDER_ERROR', effectiveTimeoutMs: 12_000
    });
    if (rejectAnswer) {
      assert.equal(observed.observation.stages.answer_audit.status, 'passed');
      assert.equal(observed.evidence.stages.delivery, 'rejected');
      assert.equal(observed.evidence.result.acceptedAnswer, false);
      assert.equal(observed.evidence.result.citationsResolved, false);
    }
    const [{ elapsedMs, ...auditRequest }] = summary.actualUsage.answerAuditProvider;
    assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
    assert.deepEqual(auditRequest, rejectAnswer ? { outcome: 'completed' } : { outcome: 'failed', code: 'LIVE_VALIDATION_PROVIDER_FAILED' });
    for (const value of [token, answer, 'private upstream audit rejection', 'Offline acquired evidence fixture.',
      'sk-offline-test-synthetic-validation-credential']) {
      assert.equal(summaryText.includes(value), false);
    }
    assert.throws(() => readFileSync(path.join(f.directory, 'evidence', 'accepted-answer.private.json')), { code: 'ENOENT' });
    return;
  }
  assert.equal(result.status, 'PASS', result.code); assert.deepEqual(result.cases.map(item => item.status), ['PASS', 'PASS']);
  assert.equal(providerCalls, 3); assert.deepEqual(providerUrls, [modelUrl, 'https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
  assert.deepEqual(result.cases[1].actualUsage, { providerCalls: 0, generationCalls: 0, auditCalls: 0 });
  assert.equal(result.actualUsage.workflows, 2); assert.equal(result.actualUsage.metadataRequests, 1); assert.equal(result.actualUsage.observedTotalTokens, 6);
  assert.equal(stopped, true); assert.ok(routes.includes('/stop')); assert.equal(result.cleanup.runClosed, true);
  assert.equal(JSON.stringify(result).includes(token), false); assert.equal(JSON.stringify(result).includes('sk-offline-test-synthetic-validation-credential'), false);
  const retained = JSON.parse(readFileSync(path.join(f.directory, 'evidence', 'accepted-answer.private.json'), 'utf8'));
  assert.equal(retained.caseId, 'gaming-guide-positive'); assert.equal(retained.sourceCommit, sha);
  for (const key of ['version', 'response', 'subjectHash', 'contextFingerprint', 'sources']) assert.deepEqual(retained[key], expectedPrivateAnswer[key]);
  assert.equal(result.cases[0].answerArtifactSha256, validationHash(expectedPrivateAnswer));
  assert.equal(result.cases[1].answerArtifactSha256, undefined);
  assert.equal(result.cases[0].observation.semanticGap, 'NONE');
  assert.equal(result.cases[0].observation.clarification, undefined);
  assert.equal(result.cases[0].observation.qualification.visible, false);
  for (const prohibited of [answer, contextFingerprint, 'Offline acquired evidence fixture.', 'privateAnswer']) {
    assert.equal(JSON.stringify(result).includes(prohibited), false);
  }
  assert.equal(JSON.stringify(retained).includes('Offline acquired evidence fixture.'), false);
}

test('controller uses its real service client, runtime HTTP auth and direct SDK provider through both profiles and cleanup',
  t => exerciseController(t));
test('controller retains an intake lookup failure through runtime usage with zero generation or audit calls',
  t => exerciseController(t, { metadataStatus: 404 }));
test('controller retains a rejected audit and provider outcome without publishing the unaudited answer',
  t => exerciseController(t, { auditStatus: 400 }));
test('controller retains completed semantic rejection diagnostics without publishing an answer or running the negative profile',
  t => exerciseController(t, { rejectAnswer: true }));
