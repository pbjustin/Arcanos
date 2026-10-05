/** Exact-SHA transient Gaming runtime. No production launcher, management token or model key. */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertValidationRoleCredentials, materializeValidationTls, readValidationJson, requireValidation,
  startValidationHealth, validationHash, validationIdentity, validationJson, validationOpaqueEqual } from './live-validation-bootstrap.mjs';
import { createLiveValidationMtlsServer, createLiveValidationPrivateClient, listenLiveValidationMtlsServer } from './live-validation-transport.mjs';
import { validateLiveValidationTarget } from './live-validation-target.mjs';
import { createLiveValidationSourceGuard } from './live-validation-egress.mjs';
import { createLivePreviewProviderFetch, resolveLivePreviewModels } from './start-live-pr-preview.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_MODE, verifyLivePreviewEvidence } from './live-pr-preview-verifier.mjs';
import { sanitizeLivePreviewEvidence } from './live-pr-preview-e2e.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const peer = (target, role) => ({ role, dnsName: target.mtlsPeers[role].dns, fingerprintSha256: target.mtlsPeers[role].sha256 });
const sessionHeaders = (session, identity) => ({ authorization: 'Bearer ' + session.brokerBearer,
  'x-arcanos-source-commit': identity.sourceCommit, 'x-arcanos-deployment-id': identity.deploymentId,
  'x-arcanos-live-run-id': session.runId });

/** Reviewed profile assertions extend the existing audited-answer evidence contract. */
export function validationProfilePassed(profile, moduleResult, observation, providerDelta) {
  if (!observation || observation.outcome !== profile.expected.outcome
    || observation.semanticGap !== profile.expected.semanticGap) return false;
  if (profile.id === 'gaming-guide-positive') return moduleResult.accepted === true
    && moduleResult.audit?.assessmentStatus === 'completed' && moduleResult.audit.decision === 'accept'
    && moduleResult.audit.boundToFinalAnswer === true && observation.coverage.satisfied
    && observation.selectedEvidenceCount > 0 && providerDelta.generationCalls > 0 && providerDelta.auditCalls > 0
    && (!profile.expected.qualifiedUnknownPatch || observation.qualification.visible
      && !observation.qualification.claimsVerifiedCurrentness);
  return profile.id === 'gaming-guide-negative' && moduleResult.accepted === false
    && observation.candidates.some(candidate => candidate.decision === 'rejected'
      && candidate.reasonCodes.some(code => /(?:MISMATCH|CONFLICT)/u.test(code)))
    && providerDelta.generationCalls === 0 && providerDelta.auditCalls === 0 && providerDelta.providerCalls === 0;
}

export function createValidationRuntimeApplication({ target, identity, profiles, supervisorClient,
  createAdapter, runRequest = async (_options, work) => work(), now = Date.now }) {
  const profileHash = validationHash(profiles); let admitted; let active = false; let admitting = false;
  const completed = new Set();
  const authorizeRequest = ({ role, method, path, headers }) => {
    if (role !== 'verifier') return false;
    if (method === 'GET' && path === '/ready' || method === 'POST' && ['/handshake', '/admit'].includes(path)) return true;
    return method === 'POST' && path === '/acceptance' && Boolean(admitted && admitted.session.expiresAtMs > now()
      && validationOpaqueEqual(headers.authorization, 'Bearer ' + admitted.session.testBearer)
      && headers['x-arcanos-source-commit'] === identity.sourceCommit && headers['x-arcanos-deployment-id'] === identity.deploymentId
      && headers['x-arcanos-live-run-id'] === admitted.session.runId);
  };
  const handler = async (request, response) => {
    let ownsExecution = false; let ownsAdmission = false;
    let executionSettled = true; let responseSettled = false;
    const releaseExecution = () => { if (ownsExecution && executionSettled && responseSettled) active = false; };
    try {
      if (request.method === 'GET' && request.url === '/ready') return validationJson(response,
        { ...identity, readiness: { providerCallsEnabled: false, durableWritesEnabled: false } });
      if (request.method === 'POST' && request.url === '/handshake') {
        const body = await readValidationJson(request); requireValidation(/^[a-f0-9]{32}$/u.test(body.challenge ?? ''), 'PRIVATE_NETWORK_CHALLENGE_INVALID');
        const result = await supervisorClient.requestJSON('/handshake', { method: 'POST', body, timeoutMs: 5_000 });
        requireValidation(result.status === 200 && result.body?.challenge === body.challenge
          && result.body.identity.projectId === identity.projectId && result.body.identity.environmentId === identity.environmentId
          && result.body.identity.serviceId === target.supervisorServiceId
          && result.body.identity.sourceCommit === target.trustedSupervisorSha, 'PRIVATE_RUNTIME_SUPERVISOR_CHANNEL_BLOCKED');
        return validationJson(response, { challenge: body.challenge, runtime: identity, supervisor: result.body.identity,
          channel: 'mtls-private', verified: true });
      }
      if (request.method === 'POST' && request.url === '/admit') {
        requireValidation(!admitted && !active && !admitting, 'LIVE_VALIDATION_RUNTIME_ALREADY_ADMITTED');
        admitting = true; ownsAdmission = true;
        const { signedPlan, session } = await readValidationJson(request); const plan = signedPlan?.plan;
        requireValidation(plan?.profileHash === profileHash && plan.commitSha === identity.sourceCommit
          && plan.runtimeDeploymentId === identity.deploymentId && session?.runId === plan.runId
          && typeof session.brokerBearer === 'string' && /^[a-f0-9]{64}$/u.test(session.brokerBearer)
          && /^arcanos-live-validation-[a-f0-9]{64}$/u.test(session.testBearer ?? '') && session.expiresAtMs > now(),
        'LIVE_VALIDATION_RUNTIME_ADMISSION_MISMATCH');
        const remote = await supervisorClient.requestJSON('/runs/' + session.runId + '/session', {
          headers: sessionHeaders(session, identity), timeoutMs: 5_000 });
        requireValidation(remote.status === 200 && validationHash(remote.body?.plan) === validationHash(plan)
          && remote.body.expiresAtMs === session.expiresAtMs && validationHash(remote.body.models) === validationHash(target.models),
        'LIVE_VALIDATION_SUPERVISOR_ADMISSION_MISMATCH');
        requireValidation(session.expiresAtMs > now(), 'LIVE_VALIDATION_RUNTIME_ADMISSION_EXPIRED');
        const observation = { moduleId: 'gaming', stage: 'generation', generationCalls: 0, auditCalls: 0 };
        // No candidate module graph is imported before authenticated, signed supervisor admission.
        const adapter = await createAdapter({ target, plan, session, supervisorClient, observation: () => observation });
        admitted = { plan, session, adapter, observation };
        return validationJson(response, { admitted: true, runId: session.runId });
      }
      requireValidation(request.method === 'POST' && request.url === '/acceptance' && admitted,
        'LIVE_VALIDATION_ROUTE_DENIED');
      const body = await readValidationJson(request, 32_768);
      const profile = profiles.profiles.find(item => item.id === body.caseId);
      requireValidation(profile && body.runId === admitted.session.runId && !completed.has(profile.id)
        && !active && admitted.session.expiresAtMs > now() && validationHash(body.input) === validationHash(profile.input),
      'LIVE_VALIDATION_PROFILE_OR_REPLAY_DENIED');
      const parsed = admitted.adapter.validateInput(body.input); requireValidation(parsed.ok, 'LIVE_VALIDATION_PROFILE_INVALID');
      active = true; ownsExecution = true; completed.add(profile.id); admitted.observation.stage = 'generation';
      const brokerRead = async () => {
        const result = await supervisorClient.requestJSON('/runs/' + admitted.session.runId + '/usage', {
          headers: sessionHeaders(admitted.session, identity), timeoutMs: 5_000 });
        requireValidation(result.status === 200 && result.body.commitSha === identity.sourceCommit
          && result.body.runtimeDeploymentId === identity.deploymentId, 'LIVE_VALIDATION_USAGE_IDENTITY_MISMATCH');
        return result.body;
      };
      let moduleResult; const stages = { source_acquisition: 'not_run', source_validation: 'not_run' };
      const before = await brokerRead();
      moduleResult = await runRequest({ timeoutMs: Math.min(120_000, admitted.session.expiresAtMs - now()),
          abortMessage: 'Live validation request deadline exceeded.' }, () => {
          executionSettled = false;
          const execution = Promise.resolve().then(() => admitted.adapter.execute(parsed.input, {
          onSourceAcquisition: status => { stages.source_acquisition = status; },
          onSourceValidation: status => { stages.source_validation = status; },
          onAnswerAuditStart: () => { admitted.observation.stage = 'answer_audit'; }, onAudit: () => {}, onFailure: () => {},
          }));
          const settle = () => { executionSettled = true; releaseExecution(); };
          void execution.then(settle, settle);
          return execution;
        });
      const after = await brokerRead();
      const delta = Object.fromEntries(['providerCalls', 'generationCalls', 'auditCalls'].map(key => [key, after.usage[key] - before.usage[key]]));
      const observation = admitted.adapter.getLastObservation(); const constructionStarted = now();
      const semanticPass = validationProfilePassed(profile, moduleResult, observation, delta);
      const evidence = sanitizeLivePreviewEvidence(createLivePreviewEvidence({ sourceCommit: identity.sourceCommit,
        approvedSourceCommit: identity.sourceCommit, deploymentId: identity.deploymentId, moduleId: 'gaming', mode: LIVE_PREVIEW_MODE }, {
        caseId: profile.caseId, result: moduleResult.result, audit: moduleResult.audit, failureCode: moduleResult.failureCode,
        usage: { ...after.usage, ...delta, limits: after.limits }, stages: { authorization: 'passed', budget: after.closed ? 'rejected' : 'passed',
          ...stages, generation: delta.generationCalls > 0 ? 'passed' : 'not_run',
          answer_audit: observation?.stages.answer_audit.status === 'passed' ? 'passed'
            : observation?.stages.answer_audit.status === 'timed_out' ? 'timed_out' : delta.auditCalls > 0 ? 'failed' : 'not_run',
          delivery: semanticPass && moduleResult.accepted ? 'passed' : 'rejected' } }));
      const verification = verifyLivePreviewEvidence(evidence, { sourceCommit: identity.sourceCommit,
        approvedSourceCommit: identity.sourceCommit, deploymentId: identity.deploymentId, moduleId: 'gaming', mode: LIVE_PREVIEW_MODE });
      const profilePassed = semanticPass && verification.status === 'PASS';
      if (observation) observation.stages.response = { status: 'passed', elapsedMs: Math.max(0, now() - constructionStarted) };
      return validationJson(response, { identity, caseId: profile.id, evidence, observation, verification, profilePassed,
        providerDelta: delta, durableWrites: 0, productionChanged: false });
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code ?? '') ? error.code : 'LIVE_VALIDATION_REQUEST_FAILED';
      validationJson(response, { error: { code } }, 403);
    } finally {
      responseSettled = true; releaseExecution();
      if (ownsAdmission) admitting = false;
    }
  };
  return { authorizeRequest, handler };
}

async function realGamingAdapter({ target, session, supervisorClient, observation }) {
  const { APPLICATION_CONSTANTS } = await import('../dist/shared/constants.js');
  const authority = resolveLivePreviewModels(target.models, APPLICATION_CONSTANTS);
  const { writeRuntimeEnv } = await import('../dist/platform/runtime/env.js');
  for (const [name, value] of [['RUN_WORKERS', 'false'], ['ALLOW_MOCK_OPENAI', 'false'], ['AI_MODEL', authority],
    ['ARCANOS_GAMING_DISCOVERY_ENABLED', 'false'], ['LOG_LEVEL', 'error']]) writeRuntimeEnv(name, value);
  const { createOpenAIAdapter } = await import('../dist/core/adapters/openai.adapter.js');
  const { runGameplayPipeline } = await import('../dist/services/gamingPipeline.js');
  const { createLiveValidationGamingAdapter } = await import('../dist/liveValidationGamingAdapter.js');
  const { getRequestRemainingMs } = await import('@arcanos/runtime');
  const providerFetch = createLivePreviewProviderFetch({ brokerOrigin: target.privateOrigins.supervisor,
    session: { ...session, models: target.models, sourceCommit: process.env.RAILWAY_GIT_COMMIT_SHA,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID, moduleIds: ['gaming'] }, observation,
    getRemainingMs: getRequestRemainingMs, fetchImplementation: async (input, init) => {
      const headers = new Headers(init?.headers); headers.set('x-arcanos-live-run-id', session.runId);
      const response = await supervisorClient.fetch(input, { ...init, headers });
      if (!response.ok) {
        let code; try { code = (await response.clone().json())?.error?.code; } catch { /* Stable unavailable stage. */ }
        if (code === 'LIVE_VALIDATION_PROVIDER_TIMEOUT') observation().timeoutStage = observation().stage;
        if (code === 'LIVE_VALIDATION_BUDGET_EXHAUSTED') observation().budgetExhausted = true;
      }
      return response;
    } });
  const client = createOpenAIAdapter({ apiKey: session.brokerBearer, baseURL: target.privateOrigins.supervisor + '/v1',
    maxRetries: 0, timeout: 120_000, fetch: providerFetch }).getClient();
  const sourceGuard = createLiveValidationSourceGuard({ forbiddenHostnames: ['api.openai.com', 'acranos-production.up.railway.app',
    'arcanos-worker-production.up.railway.app'] });
  return createLiveValidationGamingAdapter((input, prepared, hooks) => runGameplayPipeline(input, prepared,
    { client, skipStoredRetrieval: true, ...hooks }), { sourceGuard });
}

export async function startValidationRuntime(environment = process.env) {
  assertValidationRoleCredentials('runtime', environment);
  requireValidation(readdirSync(process.cwd()).length === 0, 'LIVE_VALIDATION_EMPTY_RUNTIME_DIRECTORY_REQUIRED');
  const target = validateLiveValidationTarget(JSON.parse(environment.ARCANOS_LIVE_VALIDATION_TARGET_JSON ?? 'null'));
  const identity = validationIdentity({ target, role: 'runtime', environment,
    manifest: JSON.parse(readFileSync('/opt/validation/build.json', 'utf8')), repositoryRoot: ROOT });
  const tlsFiles = materializeValidationTls(environment, '/run/arcanos-live-validation', ROOT);
  const profiles = JSON.parse(readFileSync(new URL('../examples/live-validation/profiles.json', import.meta.url), 'utf8'));
  const supervisorClient = createLiveValidationPrivateClient({ origin: target.privateOrigins.supervisor,
    serverIdentity: peer(target, 'supervisor'), tlsFiles, repositoryRoot: ROOT });
  const { runWithRequestAbortTimeout } = await import('@arcanos/runtime');
  const application = createValidationRuntimeApplication({ target, identity, profiles, supervisorClient,
    createAdapter: realGamingAdapter, runRequest: runWithRequestAbortTimeout });
  const privateServer = createLiveValidationMtlsServer({ tlsFiles, peers: [peer(target, 'verifier')], ...application });
  const health = await startValidationHealth(environment.PORT ?? '8080', 'runtime');
  try { await listenLiveValidationMtlsServer(privateServer); }
  catch (error) { privateServer.closeAllConnections(); privateServer.close(); health.close(); throw error; }
  const close = () => { privateServer.closeAllConnections(); privateServer.close(); health.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { privateServer, health, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startValidationRuntime().catch(() => { console.error('LIVE_VALIDATION_RUNTIME_START_BLOCKED'); process.exitCode = 1; });
}
