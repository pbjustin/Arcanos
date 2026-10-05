import { randomBytes, timingSafeEqual } from 'node:crypto';
import { estimateLivePreviewInputTokens } from './live-pr-preview-broker.mjs';
import { LIVE_VALIDATION_MODEL_URL_PREFIX, LIVE_VALIDATION_RESPONSES_URL, validateSupervisorEgressRequest } from './live-validation-egress.mjs';
import { assertLiveValidationAdmission } from './live-validation-policy.mjs';

const POSITIVE = 'gaming-guide-positive';
const NEGATIVE = 'gaming-guide-negative';
const STAGES = new Set(['generation', 'answer_audit']);
const TOKEN_LIMITS = Object.freeze({ maxInputTokensPerRequest: 128_000, maxOutputTokensPerRequest: 4_096, maxTotalTokens: 400_000 });
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export class LiveValidationBrokerError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationBrokerError'; this.code = code; }
}
function requireBroker(condition, code) { if (!condition) throw new LiveValidationBrokerError(code); }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function opaqueEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^LIVE_VALIDATION_[A-Z_]+$/u.test(error.code)
    ? error.code : 'LIVE_VALIDATION_PROVIDER_FAILED';
}

/** Trusted supervisor broker; neither provider credentials nor durable accounting enter candidate code. */
export function createLiveValidationBroker({ admission, budget, resolveCredential, invokeProvider,
  responseModelIdentity, now = Date.now } = {}) {
  requireBroker(typeof now === 'function', 'LIVE_VALIDATION_TRUSTED_ADAPTERS_REQUIRED');
  assertLiveValidationAdmission(admission, now());
  requireBroker(budget && ['register', 'claimWorkflow', 'reserve', 'settle', 'stop', 'inspect']
    .every(key => typeof budget[key] === 'function') && typeof resolveCredential === 'function'
    && typeof invokeProvider === 'function' && (responseModelIdentity === undefined || typeof responseModelIdentity === 'function'),
  'LIVE_VALIDATION_TRUSTED_ADAPTERS_REQUIRED');
  const { plan, target } = admission;
  const limits = Object.freeze({ ...TOKEN_LIMITS, maxRequests: target.limits.maxRequests,
    maxSpendMicroUsd: target.limits.maxSpendMicroUsd, durationMs: target.limits.durationMs });
  let authorizationStarted = false; let registered = false; let session; let credential;
  let closed = false; let active = false; let activeAbortController; let expiryTimer;
  let abortCode = 'LIVE_VALIDATION_CANCELLED';
  let workflow;
  const stages = []; const workflows = [];

  function stopMemory(code = 'LIVE_VALIDATION_CANCELLED') {
    closed = true; credential = undefined; clearTimeout(expiryTimer); abortCode = code; activeAbortController?.abort();
  }
  function close() {
    stopMemory();
    if (registered) budget.stop(plan.runId);
  }
  function terminalStop() {
    stopMemory();
    if (registered) { try { budget.stop(plan.runId); } catch { /* An unreadable ledger remains closed in memory and on restart. */ } }
  }
  function fresh() {
    requireBroker(!closed, 'LIVE_VALIDATION_RUN_CLOSED');
    try {
      assertLiveValidationAdmission(admission, now());
      if (registered) requireBroker(budget.inspect(plan.runId).status === 'active', 'LIVE_VALIDATION_RUN_CLOSED');
    } catch (error) { terminalStop(); throw new LiveValidationBrokerError(safeCode(error)); }
  }
  function requireIdentity(bearer, options) {
    requireBroker(session && opaqueEqual(bearer, session.brokerBearer), 'LIVE_VALIDATION_IDENTITY_UNAUTHORIZED');
    requireBroker(options.moduleId === 'gaming' && options.sourceCommit === plan.commitSha
      && options.deploymentId === plan.runtimeDeploymentId, 'LIVE_VALIDATION_DEPLOYMENT_MISMATCH');
    fresh();
  }
  function requireProviderWorkflow() {
    if (workflow?.caseId === NEGATIVE) {
      terminalStop(); throw new LiveValidationBrokerError('LIVE_VALIDATION_NEGATIVE_PROVIDER_FORBIDDEN');
    }
  }

  async function authorizeRun() {
    requireBroker(!authorizationStarted, 'LIVE_VALIDATION_RUN_REPLAY');
    fresh(); authorizationStarted = true;
    try {
      const state = budget.register({ runId: plan.runId, commitSha: plan.commitSha, prNumber: plan.prNumber,
        runtimeDeploymentId: plan.runtimeDeploymentId, profileHash: plan.profileHash, expiresAtMs: admission.expiresAtMs,
        limits: { ...limits }, models: structuredClone(target.models) });
      registered = true;
      credential = await resolveCredential();
      requireBroker(typeof credential === 'string' && credential.length >= 16 && /^sk-[A-Za-z0-9_-]+$/u.test(credential)
        && !/^sk-(?:test|mock|example|placeholder|change[-_]?me|replace)(?:[-_]|$)/iu.test(credential),
      'LIVE_VALIDATION_CREDENTIAL_INVALID');
      fresh();
      session = Object.freeze({ runId: plan.runId, brokerBearer: randomBytes(32).toString('hex'),
        testBearer: 'arcanos-live-validation-' + randomBytes(32).toString('hex'), expiresAtMs: state.expiresAtMs });
      expiryTimer = setTimeout(() => {
        stopMemory('LIVE_VALIDATION_PLAN_EXPIRED');
        try { budget.stop(plan.runId); } catch { /* Durable state remains fail closed. */ }
      }, Math.max(1, state.expiresAtMs - now()));
      expiryTimer.unref();
      return session;
    } catch (error) { terminalStop(); throw new LiveValidationBrokerError(safeCode(error)); }
  }

  function beginWorkflow(caseId) {
    requireBroker(session, 'LIVE_VALIDATION_IDENTITY_UNAUTHORIZED'); fresh();
    requireBroker(caseId === POSITIVE || caseId === NEGATIVE, 'LIVE_VALIDATION_CASE_FORBIDDEN');
    requireBroker(!workflow && !active, 'LIVE_VALIDATION_CONCURRENCY_LIMIT');
    requireBroker(budget.inspect(plan.runId).counts.workflows < target.limits.maxWorkflows, 'LIVE_VALIDATION_WORKFLOW_LIMIT');
    budget.claimWorkflow(plan.runId, caseId);
    workflow = { caseId, startedAtMs: now(), generationCalls: 0, auditCalls: 0, metadataRequests: 0, lastContentStage: null };
    return { caseId };
  }
  function endWorkflow() {
    requireBroker(workflow && !active, 'LIVE_VALIDATION_WORKFLOW_INVALID'); fresh();
    if (workflow.caseId === POSITIVE && !(workflow.generationCalls > 0 && workflow.auditCalls > 0
      && workflow.lastContentStage === 'answer_audit')) {
      terminalStop(); throw new LiveValidationBrokerError('LIVE_VALIDATION_AUDIT_REQUIRED');
    }
    const finished = { ...workflow, endedAtMs: now() };
    workflows.push(finished); workflow = undefined;
    return { caseId: finished.caseId, generationCalls: finished.generationCalls, auditCalls: finished.auditCalls };
  }

  function validateBody(body) {
    validateSupervisorEgressRequest({ url: LIVE_VALIDATION_RESPONSES_URL, method: 'POST', body }, { approvedModels: target.models });
    requireBroker((body.instructions === undefined || typeof body.instructions === 'string')
      && integer(body.max_output_tokens, 1) && body.max_output_tokens <= limits.maxOutputTokensPerRequest
      && (body.temperature === undefined || (typeof body.temperature === 'number' && Number.isFinite(body.temperature)
        && body.temperature >= 0 && body.temperature <= 2))
      && (body.top_p === undefined || (typeof body.top_p === 'number' && Number.isFinite(body.top_p) && body.top_p >= 0 && body.top_p <= 1))
      && (body.truncation === undefined || body.truncation === 'disabled')
      && (body.service_tier === undefined || body.service_tier === 'default'), 'LIVE_VALIDATION_REQUEST_INVALID');
    const inputTokens = estimateLivePreviewInputTokens(body);
    requireBroker(inputTokens <= limits.maxInputTokensPerRequest, 'LIVE_VALIDATION_INPUT_LIMIT');
    const { metadata: _metadata, ...requestBody } = body;
    return { inputTokens, outputTokens: body.max_output_tokens, model: body.model,
      body: { ...structuredClone(requestBody), store: false, stream: false, service_tier: 'default' } };
  }

  async function execute(request, options, validateResponse) {
    requireBroker(!active, 'LIVE_VALIDATION_CONCURRENCY_LIMIT');
    requireBroker(!options.signal?.aborted, 'LIVE_VALIDATION_CANCELLED');
    const state = budget.inspect(plan.runId);
    const remaining = Math.min(admission.expiresAtMs, state.expiresAtMs) - now();
    const requestedTimeout = options.timeoutMs ?? 120_000;
    requireBroker(integer(requestedTimeout, 1) && requestedTimeout <= 120_000 && integer(remaining, 1),
      'LIVE_VALIDATION_DURATION_LIMIT');
    let reservationId;
    try { reservationId = budget.reserve(plan.runId, { model: request.model, inputTokens: request.inputTokens,
      outputTokens: request.outputTokens, stage: request.stage }); }
    catch (error) { terminalStop(); throw new LiveValidationBrokerError(safeCode(error)); }
    active = true;
    const controller = new AbortController(); activeAbortController = controller;
    const startedAtMs = now(); let timer; let onAbort; let onCallerAbort;
    let outcome = 'failed'; let failureCode; let actualModel;
    let timeout = false;
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(new LiveValidationBrokerError(timeout ? 'LIVE_VALIDATION_PROVIDER_TIMEOUT' : abortCode));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        onCallerAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onCallerAbort, { once: true });
        timer = setTimeout(() => { timeout = true; controller.abort(); }, Math.min(requestedTimeout, remaining));
      });
      const response = await Promise.race([Promise.resolve().then(() => {
        requireBroker(!controller.signal.aborted, 'LIVE_VALIDATION_CANCELLED');
        return invokeProvider({ url: request.url, method: request.method,
          headers: { authorization: 'Bearer ' + credential, ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          ...(request.body === undefined ? {} : { body: request.body }), signal: controller.signal });
      }), interrupted]);
      fresh();
      requireBroker(response?.status === 200 && response.body && typeof response.body === 'object', 'LIVE_VALIDATION_PROVIDER_FAILED');
      const observed = validateResponse(response.body);
      actualModel = observed.actualModel;
      budget.settle(plan.runId, reservationId, { model: request.model, inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens, status: 'completed' });
      outcome = 'completed';
      if (workflow) {
        if (request.stage === 'generation') workflow.generationCalls++;
        else if (request.stage === 'answer_audit') workflow.auditCalls++;
        else workflow.metadataRequests++;
        if (request.stage !== 'metadata') workflow.lastContentStage = request.stage;
      }
      return observed.body;
    } catch (error) {
      failureCode = safeCode(error);
      try { budget.settle(plan.runId, reservationId, { model: request.model, inputTokens: 0, outputTokens: 0,
        status: timeout ? 'timed_out' : 'failed' }); } catch { /* stop/restart preserves the full conservative reservation. */ }
      terminalStop();
      throw new LiveValidationBrokerError(failureCode);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', onAbort);
      active = false; activeAbortController = undefined;
      stages.push({ caseId: workflow?.caseId ?? null, stage: request.stage, model: request.model, outcome,
        startedAtMs, elapsedMs: Math.max(0, now() - startedAtMs),
        ...(actualModel ? { actualModel } : {}), ...(failureCode ? { code: failureCode } : {}) });
    }
  }

  async function invoke(body, bearer, options = {}) {
    requireIdentity(bearer, options); requireProviderWorkflow();
    requireBroker(workflow?.caseId === POSITIVE, 'LIVE_VALIDATION_WORKFLOW_REQUIRED');
    requireBroker(STAGES.has(options.stage), 'LIVE_VALIDATION_STAGE_INVALID');
    if (options.stage === 'generation' && workflow.auditCalls > 0) {
      terminalStop(); throw new LiveValidationBrokerError('LIVE_VALIDATION_REGENERATION_FORBIDDEN');
    }
    requireBroker(options.stage !== 'answer_audit' || workflow.generationCalls > 0, 'LIVE_VALIDATION_AUDIT_ORDER_INVALID');
    const request = validateBody(body);
    return execute({ ...request, stage: options.stage, method: 'POST', url: LIVE_VALIDATION_RESPONSES_URL }, options, response => {
      let model;
      try { model = responseModelIdentity ? responseModelIdentity(response, request.model)
        : response.model === request.model ? response.model : undefined; }
      catch { throw new LiveValidationBrokerError('LIVE_VALIDATION_PROVIDER_MODEL_MISMATCH'); }
      requireBroker(typeof model === 'string' && MODEL.test(model) && typeof response.model === 'string'
        && model === response.model.trim(), 'LIVE_VALIDATION_PROVIDER_MODEL_MISMATCH');
      const usage = response.usage;
      requireBroker(usage && integer(usage.input_tokens) && integer(usage.output_tokens) && integer(usage.total_tokens)
        && usage.total_tokens === usage.input_tokens + usage.output_tokens && usage.input_tokens <= request.inputTokens
        && usage.output_tokens <= request.outputTokens, 'LIVE_VALIDATION_USAGE_INVALID');
      return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, actualModel: model, body: response };
    });
  }

  async function retrieveModel(model, bearer, options = {}) {
    requireIdentity(bearer, options); requireProviderWorkflow();
    requireBroker(target.models.some(candidate => candidate.id === model), 'LIVE_VALIDATION_MODEL_UNAPPROVED');
    return execute({ model, inputTokens: 0, outputTokens: 0, stage: 'metadata', method: 'GET',
      url: LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(model) }, options, body => {
      requireBroker(body.id === model && body.object === 'model', 'LIVE_VALIDATION_MODEL_VALIDATION_FAILED');
      return { inputTokens: 0, outputTokens: 0, actualModel: model, body: { id: model, object: 'model' } };
    });
  }
  function evidence() {
    const state = registered ? budget.inspect(plan.runId) : undefined;
    return { mode: 'persistent-live-validation', runId: plan.runId, prNumber: plan.prNumber, commitSha: plan.commitSha,
      runtimeDeploymentId: plan.runtimeDeploymentId, targetHash: plan.targetHash, profileHash: plan.profileHash,
      expiresAtMs: session?.expiresAtMs ?? admission.expiresAtMs,
      limits: { ...limits, maxWorkflows: target.limits.maxWorkflows, maxConcurrency: 1, maxRetries: 0 },
      closed: closed || state?.status === 'stopped', status: state?.status ?? 'unregistered', stopReason: state?.stopReason ?? null,
      counts: state?.counts ?? { workflows: 0, requests: 0, metadataRequests: 0, pendingRequests: 0 },
      usage: { ...(state?.usage ?? {}), providerCalls: (state?.usage.requests ?? 0) - (state?.usage.metadataRequests ?? 0),
        generationCalls: stages.filter(item => item.stage === 'generation').length,
        auditCalls: stages.filter(item => item.stage === 'answer_audit').length,
        elapsedMs: Math.max(0, now() - admission.admittedAtMs) },
      stages: structuredClone(stages), workflows: structuredClone(workflows),
      billing: 'Conservative reservations are never refunded; exact provider billing is not independently verified.' };
  }
  return Object.freeze({ authorizeRun, beginWorkflow, endWorkflow, invoke, retrieveModel, evidence, close });
}
