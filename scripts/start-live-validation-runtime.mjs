/** One exact-SHA validation service. Production launchers never import this entry point. */
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertValidationRoleCredentials, readValidationJson, requireValidation,
  validationHash, validationIdentity, validationJson, validationOpaqueEqual } from './live-validation-bootstrap.mjs';
import { validateLiveValidationTarget } from './live-validation-target.mjs';
import { createLiveValidationSourceGuard } from './live-validation-egress.mjs';
import { createLiveValidationProvider } from './live-validation-provider.mjs';
import { LIVE_VALIDATION_TOKEN_LIMITS } from './live-validation-budget.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_MODE, verifyLivePreviewEvidence } from './live-pr-preview-verifier.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const LIVE_VALIDATION_ACCEPTANCE_WORK_TIMEOUT_MS = 300_000;
export const LIVE_VALIDATION_ACCEPTANCE_RESPONSE_GRACE_MS = 10_000;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/u;
const credentialBound = value => typeof value === 'string' && /^sk-[A-Za-z0-9_-]{29,4093}$/u.test(value)
  && !/^sk-(?:test|mock|example|placeholder|change[-_]?me|replace)(?:[-_]|$)/iu.test(value);

/** One exact authority fine-tune and the normal helper roles remain the Gaming model policy. */
export function resolveLiveValidationModels(models, constants) {
  const ids = Array.isArray(models) ? models.map(model => model?.id) : [];
  const authorities = ids.filter(id => typeof id === 'string' && /^ft:[^\s]+$/u.test(id));
  requireValidation(authorities.length === 1 && ids.includes(constants.MODEL_GPT_6_LUNA)
    && ids.includes(constants.MODEL_GPT_6_1_SOL), 'LIVE_VALIDATION_MODELS_INVALID');
  return authorities[0];
}

/** Profile assertions extend the existing audited-answer evidence contract. */
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

/** Authenticated readiness precedes one bounded paid run; no request can reset its budget. */
export function createValidationRuntimeApplication({ target, identity, profiles, buildManifest, testToken, apiKey,
  createProvider = createLiveValidationProvider, createAdapter = realGamingAdapter,
  resolveResponseModelIdentity = async () => (await import('../dist/shared/gpt/generativeModelPolicyCore.js')).assertGenerativeModelResponseIdentity,
  runRequest = async (_options, work) => work(), getRemainingMs = () => null, now = Date.now }) {
  requireValidation(TOKEN.test(testToken ?? ''), 'LIVE_VALIDATION_TEST_TOKEN_REQUIRED');
  const profileHash = validationHash(profiles);
  let readinessObserved = false; let runClaimed = false; let admitting = false; let active = false; let admitted;
  const completed = new Set();
  const authorizeRequest = ({ method, path, headers, rawHeaders }) => {
    if (method === 'GET' && path === '/healthz') return true;
    if (Array.isArray(rawHeaders) && rawHeaders.filter((value, index) => index % 2 === 0
      && value.toLowerCase() === 'authorization').length !== 1) return false;
    if (!validationOpaqueEqual(headers.authorization, 'Bearer ' + testToken)) return false;
    if (method === 'GET' && path === '/ready') return true;
    return headers['x-arcanos-source-commit'] === identity.sourceCommit
      && headers['x-arcanos-deployment-id'] === identity.deploymentId
      && (method === 'POST' && ['/runs', '/acceptance', '/stop'].includes(path)
        || method === 'GET' && path === '/usage');
  };
  const handler = async (request, response) => {
    let ownsExecution = false; let ownsAdmission = false;
    let executionSettled = true; let responseSettled = false; let controller;
    const releaseExecution = () => { if (ownsExecution && executionSettled && responseSettled) active = false; };
    const disconnect = () => { if (!response.writableEnded) controller?.abort(); };
    try {
      if (!authorizeRequest({ method: request.method, path: request.url, headers: request.headers, rawHeaders: request.rawHeaders })) {
        return validationJson(response, { error: { code: 'LIVE_VALIDATION_IDENTITY_UNAUTHORIZED' } }, 401);
      }
      if (request.method === 'GET' && request.url === '/healthz') return validationJson(response,
        { ok: true, role: 'runtime', providerCallsEnabled: false });
      if (request.method === 'GET' && request.url === '/ready') {
        readinessObserved = true;
        return validationJson(response, { ...identity, buildManifest, readiness: { modelCredentialBound: credentialBound(apiKey),
          providerCallsEnabled: false, durableWritesEnabled: false } });
      }
      if (request.method === 'POST' && request.url === '/runs') {
        requireValidation(readinessObserved && !runClaimed && !admitting, 'LIVE_VALIDATION_RUN_ALREADY_CLAIMED_OR_NOT_READY');
        admitting = true; ownsAdmission = true;
        const body = await readValidationJson(request, 8_192);
        requireValidation(body && !Array.isArray(body)
          && Object.keys(body).length === 7 && ['runId', 'prNumber', 'commitSha', 'runtimeDeploymentId', 'profileHash',
            'expiresAtMs', 'paidAuthorized'].every(key => Object.hasOwn(body, key))
          && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(body.runId ?? '')
          && Number.isSafeInteger(body.prNumber) && body.prNumber > 0 && body.prNumber <= 1_000_000_000
          && body.commitSha === identity.sourceCommit
          && body.runtimeDeploymentId === identity.deploymentId && body.profileHash === profileHash
          && body.paidAuthorized === true && Number.isSafeInteger(body.expiresAtMs)
          && body.expiresAtMs > now() && body.expiresAtMs <= now() + target.limits.durationMs,
        'LIVE_VALIDATION_RUN_IDENTITY_MISMATCH');
        requireValidation(credentialBound(apiKey), 'LIVE_VALIDATION_OPENAI_KEY_REQUIRED');
        // Claim before importing the app or creating any provider transport. Failures consume the run.
        runClaimed = true;
        const observation = { moduleId: 'gaming', stage: 'generation', generationCalls: 0, auditCalls: 0 };
        const responseModelIdentity = await resolveResponseModelIdentity();
        requireValidation(body.expiresAtMs > now(), 'LIVE_VALIDATION_RUN_EXPIRED');
        const provider = createProvider({ target, identity, apiKey, now, expiresAtMs: body.expiresAtMs,
          observation: () => observation, getRemainingMs, responseModelIdentity });
        admitted = { ...body, provider, observation };
        try {
          admitted.adapter = await createAdapter({ target, identity, provider, observation: () => observation });
          requireValidation(body.expiresAtMs > now(), 'LIVE_VALIDATION_RUN_EXPIRED');
        } catch (error) { provider.close(); throw error; }
        return validationJson(response, { admitted: true, runId: body.runId, expiresAtMs: body.expiresAtMs, identity });
      }
      requireValidation(admitted?.adapter, 'LIVE_VALIDATION_RUN_REQUIRED');
      if (request.method === 'POST' && request.url === '/stop') {
        admitted.provider.close(); return validationJson(response, { stopped: true, runId: admitted.runId });
      }
      if (request.method === 'GET' && request.url === '/usage') {
        const snapshot = admitted.provider.snapshot();
        return validationJson(response, { identity, runId: admitted.runId, commitSha: admitted.commitSha,
          prNumber: admitted.prNumber, runtimeDeploymentId: admitted.runtimeDeploymentId, profileHash: admitted.profileHash,
          status: snapshot.closed ? 'stopped' : 'active', ...snapshot });
      }
      requireValidation(request.method === 'POST' && request.url === '/acceptance', 'LIVE_VALIDATION_ROUTE_DENIED');
      requireValidation(!active, 'LIVE_VALIDATION_CONCURRENCY_LIMIT');
      const body = await readValidationJson(request, 32_768);
      const profile = profiles.profiles.find(item => item.id === body?.caseId);
      requireValidation(profile && body.runId === admitted.runId && Object.keys(body).length === 3
        && !completed.has(profile.id) && !active && admitted.expiresAtMs > now()
        && validationHash(body.input) === validationHash(profile.input), 'LIVE_VALIDATION_PROFILE_OR_REPLAY_DENIED');
      const parsed = admitted.adapter.validateInput(body.input); requireValidation(parsed.ok, 'LIVE_VALIDATION_PROFILE_INVALID');
      const acceptanceDeadline = Math.min(now() + LIVE_VALIDATION_ACCEPTANCE_WORK_TIMEOUT_MS,
        admitted.expiresAtMs - LIVE_VALIDATION_ACCEPTANCE_RESPONSE_GRACE_MS);
      requireValidation(acceptanceDeadline > now(), 'LIVE_VALIDATION_ACCEPTANCE_DEADLINE_EXCEEDED');
      active = true; ownsExecution = true; completed.add(profile.id);
      admitted.observation.stage = 'generation';
      delete admitted.observation.timeoutStage; delete admitted.observation.budgetExhausted;
      admitted.provider.beginWorkflow(profile.id);
      const before = admitted.provider.snapshot();
      const stages = { source_acquisition: 'not_run', source_validation: 'not_run' };
      let moduleResult = { accepted: false }; let failed = false; let auditStarted = false;
      controller = new AbortController(); response.once?.('close', disconnect);
      try {
        moduleResult = await runRequest({ timeoutMs: acceptanceDeadline - now(), parentSignal: controller.signal,
          abortMessage: 'Live validation request deadline exceeded.' }, () => {
          executionSettled = false;
          const execution = Promise.resolve().then(() => admitted.adapter.execute(parsed.input, {
            onSourceAcquisition: status => { stages.source_acquisition = status; },
            onSourceValidation: status => { stages.source_validation = status; },
            onAnswerAuditStart: () => { auditStarted = true; admitted.observation.stage = 'answer_audit'; },
            onAudit: () => {}, onFailure: () => {},
          }));
          const settle = () => { executionSettled = true; releaseExecution(); };
          void execution.then(settle, settle); return execution;
        });
        admitted.provider.endWorkflow();
      } catch { failed = true; admitted.provider.close(); }
      const after = admitted.provider.snapshot();
      const delta = Object.fromEntries(['providerCalls', 'generationCalls', 'auditCalls'].map(key => [key, after.usage[key] - before.usage[key]]));
      const observation = admitted.adapter.getLastObservation(); const constructionStarted = now();
      const failureCode = admitted.observation.budgetExhausted ? 'BUDGET_EXHAUSTED'
        : admitted.observation.timeoutStage === 'answer_audit' ? 'AUDIT_TIMEOUT'
          : admitted.observation.timeoutStage === 'generation' ? 'MODEL_TIMEOUT' : moduleResult.failureCode;
      const semanticPass = !failed && !after.closed && validationProfilePassed(profile, moduleResult, observation, delta);
      // Evidence is a closed projection: raw provider bodies, source passages and answers never enter it.
      const evidence = createLivePreviewEvidence({ sourceCommit: identity.sourceCommit,
        approvedSourceCommit: identity.sourceCommit, deploymentId: identity.deploymentId, moduleId: 'gaming', mode: LIVE_PREVIEW_MODE }, {
        caseId: profile.caseId, result: moduleResult.result, audit: moduleResult.audit, failureCode,
        usage: { ...after.usage, ...delta, limits: after.limits }, stages: {
          authorization: 'passed', budget: admitted.observation.budgetExhausted ? 'exhausted' : 'passed', ...stages,
          generation: failureCode === 'MODEL_TIMEOUT' ? 'timed_out'
            : auditStarted || observation?.stages.generation.status === 'passed' ? 'passed' : delta.generationCalls > 0 ? 'failed' : 'not_run',
          answer_audit: observation?.stages.answer_audit.status === 'passed' ? 'passed'
            : failureCode === 'AUDIT_TIMEOUT' || observation?.stages.answer_audit.status === 'timed_out' ? 'timed_out'
              : delta.auditCalls > 0 ? 'failed' : 'not_run', delivery: semanticPass && moduleResult.accepted ? 'passed' : 'rejected' } });
      const verification = verifyLivePreviewEvidence(evidence, { sourceCommit: identity.sourceCommit,
        approvedSourceCommit: identity.sourceCommit, deploymentId: identity.deploymentId, moduleId: 'gaming', mode: LIVE_PREVIEW_MODE });
      if (observation) observation.stages.response = { status: 'passed', elapsedMs: Math.max(0, now() - constructionStarted) };
      const value = { identity, caseId: profile.id, evidence, observation, verification,
        profilePassed: semanticPass && verification.status === 'PASS', providerDelta: delta,
        durableWrites: 0, playerPersistence: 0, productionChanged: false };
      const serialized = JSON.stringify(value);
      requireValidation(!serialized.includes(testToken) && (!apiKey || !serialized.includes(apiKey)), 'LIVE_VALIDATION_SECRET_IN_EVIDENCE');
      return validationJson(response, value);
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code ?? '') ? error.code : 'LIVE_VALIDATION_REQUEST_FAILED';
      validationJson(response, { error: { code } }, code === 'LIVE_VALIDATION_CONCURRENCY_LIMIT' ? 429 : 403);
    } finally {
      response.off?.('close', disconnect); responseSettled = true; releaseExecution();
      if (ownsAdmission) admitting = false;
    }
  };
  return { authorizeRequest, handler, close: () => admitted?.provider.close() };
}

/** Match the real Trinity allocation to the paid guard before importing its consumers. */
export function configureLiveValidationModelRuntime(authority, writeRuntimeEnv) {
  writeRuntimeEnv('AI_MODEL', authority);
  writeRuntimeEnv('TRINITY_REASONING_MAX_OUTPUT_TOKENS', String(LIVE_VALIDATION_TOKEN_LIMITS.maxOutputTokensPerRequest));
}

async function realGamingAdapter({ target, provider, observation }) {
  const { APPLICATION_CONSTANTS } = await import('../dist/shared/constants.js');
  const authority = resolveLiveValidationModels(target.models, APPLICATION_CONSTANTS);
  const { writeRuntimeEnv } = await import('../dist/platform/runtime/env.js');
  configureLiveValidationModelRuntime(authority, writeRuntimeEnv);
  for (const [name, value] of [['RUN_WORKERS', 'false'], ['ALLOW_MOCK_OPENAI', 'false'],
    ['ARCANOS_GAMING_DISCOVERY_ENABLED', 'false'], ['LOG_LEVEL', 'error']]) writeRuntimeEnv(name, value);
  const { createOpenAIAdapter } = await import('../dist/core/adapters/openai.adapter.js');
  const { runGameplayPipeline } = await import('../dist/services/gamingPipeline.js');
  const { createLiveValidationGamingAdapter } = await import('../dist/liveValidationGamingAdapter.js');
  // A noncredential placeholder keeps only the direct guard responsible for the validation key.
  const client = createOpenAIAdapter({ apiKey: 'validation-provider-placeholder', maxRetries: 0, timeout: 120_000,
    fetch: provider.fetch }).getClient();
  const sourceGuard = createLiveValidationSourceGuard({ forbiddenOrigins: [target.publicOrigin],
    forbiddenHostnames: ['acranos-production.up.railway.app', 'arcanos-worker-production.up.railway.app'] });
  return createLiveValidationGamingAdapter((input, prepared, hooks) => runGameplayPipeline(input, prepared,
    { client, skipStoredRetrieval: true, ...hooks, onAnswerAuditStart: () => {
      observation().stage = 'answer_audit'; hooks.onAnswerAuditStart?.();
    } }), { sourceGuard });
}

export async function startValidationRuntime(environment = process.env) {
  assertValidationRoleCredentials('runtime', environment);
  requireValidation(readdirSync(process.cwd()).length === 0, 'LIVE_VALIDATION_EMPTY_RUNTIME_DIRECTORY_REQUIRED');
  const target = validateLiveValidationTarget(JSON.parse(environment.ARCANOS_LIVE_VALIDATION_TARGET_JSON ?? 'null'));
  const buildManifest = JSON.parse(readFileSync('/opt/validation/build.json', 'utf8'));
  const identity = validationIdentity({ target, role: 'runtime', environment, manifest: buildManifest, repositoryRoot: ROOT });
  const profiles = JSON.parse(readFileSync(new URL('../examples/live-validation/profiles.json', import.meta.url), 'utf8'));
  const { runWithRequestAbortTimeout, getRequestRemainingMs } = await import('@arcanos/runtime');
  const application = createValidationRuntimeApplication({ target, identity, profiles, buildManifest,
    testToken: environment.ARCANOS_LIVE_VALIDATION_TEST_TOKEN, apiKey: environment.ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY,
    runRequest: runWithRequestAbortTimeout, getRemainingMs: getRequestRemainingMs });
  const port = environment.PORT ?? '8080';
  requireValidation(/^[1-9][0-9]{0,4}$/u.test(String(port)) && Number(port) <= 65_535, 'LIVE_VALIDATION_PORT_INVALID');
  const server = createServer(application.handler);
  server.requestTimeout = 330_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), '::', resolve); });
  const close = () => { application.close(); server.closeAllConnections(); server.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startValidationRuntime().catch(() => { console.error('LIVE_VALIDATION_RUNTIME_START_BLOCKED'); process.exitCode = 1; });
}
