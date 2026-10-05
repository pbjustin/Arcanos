/** Fixed trusted supervisor. This launcher never imports or executes candidate application code. */
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicKey } from 'node:crypto';
import { assertValidationRoleCredentials, materializeValidationTls, readValidationJson, requireValidation,
  startValidationHealth, validationHash, validationIdentity, validationJson, validationOpaqueEqual } from './live-validation-bootstrap.mjs';
import { createLiveValidationMtlsServer, listenLiveValidationMtlsServer } from './live-validation-transport.mjs';
import { LIVE_VALIDATION_QUOTA_LEDGER_MOUNT, validateLiveValidationTarget } from './live-validation-target.mjs';
import { validateLiveValidationPlan } from './live-validation-policy.mjs';
import { createLiveValidationBudget } from './live-validation-budget.mjs';
import { createLiveValidationBroker } from './live-validation-broker.mjs';
import { createLiveValidationProviderTransport } from './live-validation-egress.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUN_ROUTE = /^\/runs\/([0-9a-f]{32})\/(session|usage|stop|workflows\/(gaming-guide-positive|gaming-guide-negative)\/(begin|end))$/u;
const peer = (target, role) => ({ role, dnsName: target.mtlsPeers[role].dns, fingerprintSha256: target.mtlsPeers[role].sha256 });

export function createValidationSupervisorApplication({ target, identity, trustedPublicKey, profiles,
  budget, resolveCredential, invokeProvider, responseModelIdentity, now = Date.now, createBroker = createLiveValidationBroker }) {
  const profileHash = validationHash(profiles); const runs = new Map(); let activeRunId;
  const ready = () => ({ ...identity, readiness: { modelCredentialBound: Boolean(resolveCredential({ probe: true })), providerCallsEnabled: false } });
  const runtimeAuthorized = headers => {
    const run = runs.get(headers['x-arcanos-live-run-id']);
    return Boolean(run?.session && run.session.expiresAtMs > now()
      && validationOpaqueEqual(headers.authorization, 'Bearer ' + run.session.brokerBearer)
      && headers['x-arcanos-source-commit'] === run.plan.commitSha
      && headers['x-arcanos-deployment-id'] === run.plan.runtimeDeploymentId);
  };
  const authorizeRequest = ({ role, method, path, headers }) => {
    if (role === 'verifier') return method === 'GET' && (path === '/ready' || RUN_ROUTE.test(path))
      || method === 'POST' && (path === '/runs' || path === '/handshake' || RUN_ROUTE.test(path));
    if (role !== 'runtime') return false;
    if (method === 'POST' && path === '/handshake') return true;
    return runtimeAuthorized(headers) && (method === 'GET' && (path.endsWith('/session') || path.endsWith('/usage') || path.startsWith('/v1/models/'))
      || method === 'POST' && path === '/v1/responses');
  };
  const handler = async (request, response, authenticatedPeer) => {
    let registeringRunId;
    try {
      if (request.method === 'GET' && request.url === '/ready') return validationJson(response, ready());
      if (request.method === 'POST' && request.url === '/handshake') {
        const body = await readValidationJson(request); requireValidation(/^[a-f0-9]{32}$/u.test(body.challenge ?? ''), 'PRIVATE_NETWORK_CHALLENGE_INVALID');
        return validationJson(response, { challenge: body.challenge, identity });
      }
      if (request.method === 'POST' && request.url === '/runs') {
        requireValidation(authenticatedPeer.role === 'verifier' && !activeRunId, 'LIVE_VALIDATION_RUN_ALREADY_ACTIVE');
        const signedPlan = await readValidationJson(request);
        const plan = signedPlan.plan;
        const runtimeIdentity = { role: 'runtime', sourceCommit: plan?.commitSha, projectId: plan?.projectId,
          environmentId: plan?.environmentId, serviceId: plan?.runtimeServiceId, deploymentId: plan?.runtimeDeploymentId,
          buildManifestSha256: plan?.runtimeBuildManifestSha256 };
        const admission = validateLiveValidationPlan({ signedPlan, target, trustedPublicKey, trustedProfileHash: profileHash,
          runtimeIdentity, supervisorIdentity: identity, nowMs: now() });
        const broker = createBroker({ admission, budget, resolveCredential, invokeProvider, responseModelIdentity, now });
        activeRunId = plan.runId; registeringRunId = plan.runId;
        const session = await broker.authorizeRun();
        const expiry = setTimeout(() => {
          broker.close(); const record = runs.get(plan.runId); if (record) record.session = undefined;
          if (activeRunId === plan.runId) activeRunId = undefined;
        }, session.expiresAtMs - now()); expiry.unref();
        runs.set(plan.runId, { broker, session, plan: admission.plan, expiry }); activeRunId = plan.runId;
        registeringRunId = undefined;
        return validationJson(response, session);
      }
      const match = RUN_ROUTE.exec(request.url ?? '');
      if (match) {
        const [, runId, route, caseId, action] = match; const run = runs.get(runId);
        requireValidation(run, 'LIVE_VALIDATION_RUN_UNKNOWN');
        if (route === 'session' && request.method === 'GET') {
          requireValidation(authenticatedPeer.role === 'runtime' && runtimeAuthorized(request.headers)
            && request.headers['x-arcanos-live-run-id'] === runId, 'LIVE_VALIDATION_SESSION_UNAUTHORIZED');
          return validationJson(response, { plan: run.plan, expiresAtMs: run.session.expiresAtMs, models: target.models });
        }
        if (route === 'usage' && request.method === 'GET') {
          requireValidation(authenticatedPeer.role === 'verifier' || runtimeAuthorized(request.headers)
            && request.headers['x-arcanos-live-run-id'] === runId, 'LIVE_VALIDATION_SESSION_UNAUTHORIZED');
          return validationJson(response, run.broker.evidence());
        }
        requireValidation(authenticatedPeer.role === 'verifier', 'LIVE_VALIDATION_ADMIN_UNAUTHORIZED');
        if (route === 'stop' && request.method === 'POST') {
          run.broker.close(); clearTimeout(run.expiry); run.session = undefined;
          if (activeRunId === runId) activeRunId = undefined;
          return validationJson(response, { runId, stopped: true, productionChanged: false });
        }
        if (caseId && request.method === 'POST') {
          if (action === 'begin') run.broker.beginWorkflow(caseId); else run.broker.endWorkflow();
          return validationJson(response, { runId, caseId, action, ok: true });
        }
      }
      requireValidation(authenticatedPeer.role === 'runtime' && runtimeAuthorized(request.headers), 'LIVE_VALIDATION_SESSION_UNAUTHORIZED');
      const run = runs.get(request.headers['x-arcanos-live-run-id']);
      const options = { moduleId: request.headers['x-arcanos-live-module'], sourceCommit: request.headers['x-arcanos-source-commit'],
        deploymentId: request.headers['x-arcanos-deployment-id'], timeoutMs: Number(request.headers['x-arcanos-request-timeout-ms']) };
      const bearer = request.headers.authorization.slice('Bearer '.length);
      if (request.method === 'POST' && request.url === '/v1/responses') {
        const body = await readValidationJson(request);
        return validationJson(response, await run.broker.invoke(body, bearer, { ...options, stage: request.headers['x-arcanos-live-stage'] }));
      }
      if (request.method === 'GET' && request.url.startsWith('/v1/models/')) {
        let model; try { model = decodeURIComponent(request.url.slice('/v1/models/'.length)); } catch { /* Closed model lookup below. */ }
        requireValidation(target.models.some(item => item.id === model)
          && request.url === '/v1/models/' + encodeURIComponent(model), 'LIVE_VALIDATION_MODEL_UNAPPROVED');
        return validationJson(response, await run.broker.retrieveModel(model, bearer, options));
      }
      validationJson(response, { error: { code: 'LIVE_VALIDATION_ROUTE_DENIED' } }, 404);
    } catch (error) {
      if (registeringRunId && activeRunId === registeringRunId) activeRunId = undefined;
      const code = /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code ?? '') ? error.code : 'LIVE_VALIDATION_REQUEST_FAILED';
      validationJson(response, { error: { code } }, 403);
    }
  };
  return { authorizeRequest, handler, close: () => {
    for (const run of runs.values()) { clearTimeout(run.expiry); run.broker.close(); run.session = undefined; }
  } };
}

/** Fresh Railway volume ownership is initialized before dropping privileges or reading credentials. */
export function prepareValidationLedger(environment, directory = LIVE_VALIDATION_QUOTA_LEDGER_MOUNT) {
  requireValidation(environment.RAILWAY_VOLUME_MOUNT_PATH === directory, 'LIVE_VALIDATION_DURABLE_LEDGER_BINDING_REQUIRED');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireValidation(!lstatSync(directory).isSymbolicLink(), 'LIVE_VALIDATION_DURABLE_LEDGER_PATH_UNSAFE');
  if (process.getuid() === 0) {
    chmodSync(directory, 0o700); chownSync(directory, 1000, 1000);
    process.setgid(1000); process.setuid(1000);
  }
}

export async function startValidationSupervisor(environment = process.env) {
  assertValidationRoleCredentials('supervisor', environment);
  const target = validateLiveValidationTarget(JSON.parse(environment.ARCANOS_LIVE_VALIDATION_TARGET_JSON ?? 'null'));
  const identity = validationIdentity({ target, role: 'supervisor', environment,
    manifest: JSON.parse(readFileSync('/opt/validation/build.json', 'utf8')), repositoryRoot: ROOT });
  prepareValidationLedger(environment);
  const tlsFiles = materializeValidationTls(environment, '/run/arcanos-live-validation', ROOT);
  const profiles = JSON.parse(readFileSync(new URL('../examples/live-validation/profiles.json', import.meta.url), 'utf8'));
  const trustedPublicKey = createPublicKey(environment.ARCANOS_LIVE_VALIDATION_CONTROLLER_PUBLIC_KEY_PEM);
  const budget = createLiveValidationBudget({ directory: LIVE_VALIDATION_QUOTA_LEDGER_MOUNT, repositoryRoot: ROOT });
  const { assertGenerativeModelResponseIdentity } = await import('../dist/shared/gpt/generativeModelPolicyCore.js');
  const application = createValidationSupervisorApplication({ target, identity, profiles, trustedPublicKey, budget,
    resolveCredential: ({ probe } = {}) => probe ? Boolean(environment.ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY)
      : environment.ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY,
    invokeProvider: createLiveValidationProviderTransport({ approvedModels: target.models }),
    responseModelIdentity: assertGenerativeModelResponseIdentity });
  const privateServer = createLiveValidationMtlsServer({ tlsFiles, peers: ['runtime', 'verifier'].map(role => peer(target, role)), ...application });
  const health = await startValidationHealth(environment.PORT ?? '8080', 'supervisor');
  try { await listenLiveValidationMtlsServer(privateServer); }
  catch (error) { application.close(); privateServer.closeAllConnections(); privateServer.close(); health.close(); throw error; }
  const close = () => { application.close(); privateServer.closeAllConnections(); privateServer.close(); health.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { privateServer, health, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startValidationSupervisor().catch(() => { console.error('LIVE_VALIDATION_SUPERVISOR_START_BLOCKED'); process.exitCode = 1; });
}
