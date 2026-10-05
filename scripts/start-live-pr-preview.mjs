/** Separate private preview entry. The canonical production/sealed launchers never import this file. */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { KNOWN_PRODUCTION_ENVIRONMENT_ID, KNOWN_PRODUCTION_PROJECT_ID } from './live-pr-preview-policy.mjs';

const ENV_NAMES = new Set(['NODE_ENV', 'PORT', 'TZ', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_GIT_COMMIT_SHA']);
export function resolveLivePreviewChildConfig(args, env, session) {
  if (args.length !== 4 || args[0] !== '--session-file' || args[2] !== '--broker-origin'
    || Object.keys(env).some(name => !ENV_NAMES.has(name))
    || env.NODE_ENV !== 'production' || env.TZ !== 'UTC'
    || !/^[1-9]\d{0,4}$/u.test(env.PORT ?? '') || Number(env.PORT) > 65535
    || session.mode !== 'live-backend-v1'
    || !/^[0-9a-f]{40}$/u.test(session.sourceCommit ?? '')
    || session.sourceCommit !== session.approvedSourceCommit
    || !Number.isSafeInteger(session.prNumber) || session.prNumber < 1
    || session.environmentName !== `live-pr-${session.prNumber}`
    || session.environmentId === KNOWN_PRODUCTION_ENVIRONMENT_ID
    || session.projectId === KNOWN_PRODUCTION_PROJECT_ID
    || !Array.isArray(session.moduleIds) || session.moduleIds.length === 0
    || session.moduleIds.length > 16 || new Set(session.moduleIds).size !== session.moduleIds.length
    || session.moduleIds.some(id => !/^[a-z][a-z0-9_-]{0,63}$/u.test(id))
    || env.RAILWAY_ENVIRONMENT_NAME !== session.environmentName
    || env.RAILWAY_GIT_COMMIT_SHA !== session.sourceCommit
    || env.RAILWAY_PROJECT_ID !== session.projectId
    || env.RAILWAY_ENVIRONMENT_ID !== session.environmentId
    || env.RAILWAY_SERVICE_ID !== session.serviceId
    || env.RAILWAY_DEPLOYMENT_ID !== session.deploymentId
    || !Number.isSafeInteger(session.expiresAtMs) || session.expiresAtMs <= Date.now()
    || !/^arcanos-preview-[0-9a-f]{64}$/u.test(session.testBearer ?? '')
    || typeof session.brokerBearer !== 'string' || session.brokerBearer.length < 32) {
    throw new Error('LIVE_PREVIEW_CHILD_ADMISSION_DENIED');
  }
  let broker;
  try { broker = new URL(args[3]); } catch { throw new Error('LIVE_PREVIEW_BROKER_ORIGIN_INVALID'); }
  if (broker.protocol !== 'https:' || broker.username || broker.password || broker.search || broker.hash
    || broker.pathname !== '/' || !broker.hostname || broker.hostname === 'api.openai.com'
    || broker.origin !== session.brokerOrigin) {
    throw new Error('LIVE_PREVIEW_BROKER_ORIGIN_INVALID');
  }
  return { port: Number(env.PORT), brokerOrigin: broker.origin };
}

/** One approved fine-tune remains the final authority; helper roles retain the backend policy. */
export function resolveLivePreviewModels(models, constants) {
  if (!Array.isArray(models)) throw new Error('LIVE_PREVIEW_MODELS_INVALID');
  const ids = models.map(model => model?.id);
  const authorities = ids.filter(id => typeof id === 'string' && /^ft:[^\s]+$/u.test(id));
  if (authorities.length !== 1 || !ids.includes(constants.MODEL_GPT_6_LUNA)
    || !ids.includes(constants.MODEL_GPT_6_1_SOL)) throw new Error('LIVE_PREVIEW_MODELS_INVALID');
  return authorities[0];
}

/** Restricted transport carries only the ephemeral broker credential and exact deployment identity. */
export function createLivePreviewProviderFetch({ brokerOrigin, session, observation,
  fetchImplementation = globalThis.fetch, getRemainingMs = () => null, now = Date.now }) {
  const headers = { authorization: `Bearer ${session.brokerBearer}`,
    'x-arcanos-source-commit': session.sourceCommit, 'x-arcanos-deployment-id': session.deploymentId };
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const metadataModel = method === 'GET' && session.models.find(model => /^[A-Za-z0-9_.:-]+$/u.test(model.id)
      && (url.pathname === '/v1/models/' + encodeURIComponent(model.id) || url.pathname === '/v1/models/' + model.id));
    const metadata = Boolean(metadataModel);
    if (url.origin !== brokerOrigin || url.username || url.password || url.search || url.hash
      || !(metadata || method === 'POST' && url.pathname === '/v1/responses')) {
      throw new Error('LIVE_PREVIEW_PROVIDER_ROUTE_DENIED');
    }
    const active = observation();
    if (!session.moduleIds.includes(active.moduleId) || !['generation', 'answer_audit'].includes(active.stage)) {
      throw new Error('LIVE_PREVIEW_PROVIDER_MODULE_DENIED');
    }
    const stage = active.stage;
    const nativeHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawNativeTimeout = nativeHeaders.get('x-stainless-timeout');
    const nativeTimeoutMs = rawNativeTimeout && /^[1-9][0-9]*$/u.test(rawNativeTimeout)
      ? Number(rawNativeTimeout) * 1_000 : 8_000;
    const timeoutMs = Math.floor(Math.min(nativeTimeoutMs - 500,
      metadata ? 3_500 : stage === 'answer_audit' ? 2_500 : Number.POSITIVE_INFINITY,
      session.expiresAtMs - now() - 1_000, (getRemainingMs() ?? Number.POSITIVE_INFINITY) - 1_000));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('LIVE_PREVIEW_DURATION_LIMIT');
    try {
      const providerInput = metadata ? brokerOrigin + '/v1/models/' + encodeURIComponent(metadataModel.id) : input;
      const response = await fetchImplementation(providerInput, { ...init, method, redirect: 'error',
        headers: { ...headers, 'x-arcanos-live-module': active.moduleId,
          'x-arcanos-request-timeout-ms': String(timeoutMs),
          ...(!metadata ? { 'content-type': 'application/json', 'x-arcanos-live-stage': stage } : {}) } });
      if (!response.ok) {
        const body = await response.clone().text();
        if (Buffer.byteLength(body) > 32_768) throw new Error('LIVE_PREVIEW_BROKER_RESPONSE_INVALID');
        let code;
        try { code = JSON.parse(body)?.error?.code; } catch { /* Unknown faults remain failed observations. */ }
        if (code === 'LIVE_PREVIEW_BUDGET_EXHAUSTED') observation().budgetExhausted = true;
        if (code === 'LIVE_PREVIEW_PROVIDER_TIMEOUT' && !metadata) observation().timeoutStage = stage;
      }
      return response;
    } catch {
      throw new Error('LIVE_PREVIEW_PROVIDER_FAILED');
    }
  };
}

/** Fixed code-reviewed factories bootstrap only modules in the signed session. No dynamic dispatcher/import. */
export async function createLivePreviewModuleAdapters(moduleIds, factories, context) {
  if (!Array.isArray(moduleIds) || moduleIds.length < 1 || moduleIds.length > 16
    || new Set(moduleIds).size !== moduleIds.length
    || moduleIds.some(id => !/^[a-z][a-z0-9_-]{0,63}$/u.test(id)
      || !Object.hasOwn(factories, id) || typeof factories[id] !== 'function')) {
    throw new Error('LIVE_PREVIEW_MODULE_UNSUPPORTED');
  }
  const adapters = [];
  for (const moduleId of moduleIds) {
    const adapter = await factories[moduleId](context);
    if (adapter?.moduleId !== moduleId || typeof adapter.validateInput !== 'function'
      || typeof adapter.execute !== 'function') throw new Error('LIVE_PREVIEW_ADAPTER_INVALID');
    adapters.push(adapter);
  }
  return adapters;
}

function defaultModuleFactories() {
  return Object.freeze({ gaming: async ({ config, handoff, admitted, observation, fetchImplementation }) => {
    // Gaming's existing authority policy belongs to this adapter, not the repository-wide harness.
    const { APPLICATION_CONSTANTS } = await import('../dist/shared/constants.js');
    const authorityModel = resolveLivePreviewModels(admitted.models, APPLICATION_CONSTANTS);
    const { writeRuntimeEnv } = await import('../dist/platform/runtime/env.js');
    writeRuntimeEnv('RUN_WORKERS', 'false');
    writeRuntimeEnv('ALLOW_MOCK_OPENAI', 'false');
    writeRuntimeEnv('AI_MODEL', authorityModel);
    writeRuntimeEnv('ARCANOS_GAMING_DISCOVERY_ENABLED', 'false');
    writeRuntimeEnv('LOG_LEVEL', 'error');
    const { createOpenAIAdapter } = await import('../dist/core/adapters/openai.adapter.js');
    const { runGameplayPipeline } = await import('../dist/services/gamingPipeline.js');
    const { createLivePrPreviewGamingAdapter } = await import('../dist/livePrPreviewGamingAdapter.js');
    const { getRequestRemainingMs } = await import('@arcanos/runtime');
    const brokerFetch = createLivePreviewProviderFetch({ brokerOrigin: config.brokerOrigin,
      session: { ...handoff, models: admitted.models }, observation, getRemainingMs: getRequestRemainingMs, fetchImplementation });
    const client = createOpenAIAdapter({ apiKey: handoff.brokerBearer, baseURL: config.brokerOrigin + '/v1',
      maxRetries: 0, timeout: Math.min(admitted.limits.durationMs, 120_000), fetch: brokerFetch }).getClient();
    return createLivePrPreviewGamingAdapter((input, hooks) =>
      runGameplayPipeline(input, undefined, { client, skipStoredRetrieval: true, ...hooks }));
  } });
}

export async function startLivePreview(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  // Empty working directory prevents dotenv or local memory/audit imports from loading production files.
  if ((await (dependencies.readRuntimeDirectory ?? readdir)(process.cwd())).length) throw new Error('LIVE_PREVIEW_EMPTY_RUNTIME_DIRECTORY_REQUIRED');
  const handoff = JSON.parse(await (dependencies.readSessionFile ?? readFile)(args[1], 'utf8'));
  const config = resolveLivePreviewChildConfig(args, env, handoff);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const brokerRead = async path => {
    const response = await fetchImplementation(config.brokerOrigin + path, { redirect: 'error',
      headers: { authorization: `Bearer ${handoff.brokerBearer}`,
        'x-arcanos-source-commit': handoff.sourceCommit, 'x-arcanos-deployment-id': handoff.deploymentId },
      signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('LIVE_PREVIEW_BROKER_ADMISSION_DENIED');
    const text = await response.text();
    if (Buffer.byteLength(text) > 32_768) throw new Error('LIVE_PREVIEW_BROKER_RESPONSE_INVALID');
    return JSON.parse(text);
  };
  const admitted = await brokerRead('/session');
  for (const field of ['sourceCommit', 'approvedSourceCommit', 'deploymentId', 'projectId', 'environmentId',
    'environmentName', 'serviceId', 'prNumber', 'expiresAtMs', 'testBearer', 'brokerOrigin', 'backendOrigin']) {
    if (admitted[field] !== handoff[field]) throw new Error('LIVE_PREVIEW_BROKER_IDENTITY_MISMATCH');
  }
  if (JSON.stringify(admitted.moduleIds) !== JSON.stringify(handoff.moduleIds)) throw new Error('LIVE_PREVIEW_BROKER_IDENTITY_MISMATCH');
  // Unsupported scopes fail before any module factory imports the normal backend graph.
  let observation = { moduleId: '', stage: 'generation', generationCalls: 0, auditCalls: 0 };
  const adapters = await createLivePreviewModuleAdapters(admitted.moduleIds, dependencies.moduleFactories ?? defaultModuleFactories(),
    { config, handoff, admitted, observation: () => observation, fetchImplementation });
  const createLivePrPreviewApplication = dependencies.createApplication
    ?? (await import('../dist/livePrPreviewApplication.js')).createLivePrPreviewApplication;
  let stageOffset = 0;
  const usage = async () => {
    const evidence = await brokerRead('/usage');
    // Broker owns cumulative resource accounting; stage observations belong to this single backend request.
    const stages = evidence.stages.slice(stageOffset);
    if (stages.some(stage => stage.moduleId !== observation.moduleId)) throw new Error('LIVE_PREVIEW_BROKER_MODULE_MISMATCH');
    observation.generationCalls = stages.filter(stage => stage.stage === 'model_generation').length;
    observation.auditCalls = stages.filter(stage => stage.stage === 'answer_audit').length;
    return { ...evidence.usage, generationCalls: observation.generationCalls, auditCalls: observation.auditCalls,
      providerCalls: observation.generationCalls + observation.auditCalls,
      limits: evidence.limits };
  };
  const app = createLivePrPreviewApplication({ ...admitted,
    maxRequests: admitted.limits.maxRequests, requestTimeoutMs: Math.min(admitted.limits.durationMs, 120_000) }, {
    adapters: adapters.map(adapter => ({ ...adapter, execute: async (input, observer) => {
      observation = { moduleId: adapter.moduleId, stage: 'generation', generationCalls: 0, auditCalls: 0 };
      stageOffset = (await brokerRead('/usage')).stages.length;
      return adapter.execute(input, { ...observer, onAnswerAuditStart: () => {
        observation.stage = 'answer_audit'; observer.onAnswerAuditStart();
      } });
    } })), observation: () => observation, usage,
  });
  const server = createServer(app);
  // Must be reached through a separately isolated private gateway; never a public listener.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  const expiry = setTimeout(() => { server.closeAllConnections(); server.close(); }, admitted.expiresAtMs - Date.now());
  const stop = () => { clearTimeout(expiry); server.closeAllConnections(); server.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  server.once('close', () => { clearTimeout(expiry); process.off('SIGTERM', stop); process.off('SIGINT', stop); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLivePreview().catch(() => { console.error('LIVE_PREVIEW_START_FAILED'); process.exitCode = 1; });
}
