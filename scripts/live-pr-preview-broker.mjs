import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assertLivePreviewAdmission, LivePreviewPolicyError } from './live-pr-preview-policy.mjs';

export const LIVE_PREVIEW_PROVIDER_URL = 'https://api.openai.com/v1/responses';
export const LIVE_PREVIEW_MODEL_URL_PREFIX = 'https://api.openai.com/v1/models/';
export const LIVE_PREVIEW_INPUT_TOKEN_OVERHEAD = 1_024;
const STAGES = new Set(['model_generation', 'answer_audit']);
const REQUEST_KEYS = new Set(['model', 'input', 'instructions', 'max_output_tokens', 'temperature', 'top_p',
  'reasoning', 'text', 'metadata', 'store', 'stream', 'truncation', 'service_tier', 'parallel_tool_calls']);

export class LivePreviewBrokerError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireBroker(condition, code) { if (!condition) throw new LivePreviewBrokerError(code); }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function opaqueEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function textContent(value) {
  return typeof value === 'string' || (Array.isArray(value) && value.length > 0 && value.length <= 128
    && value.every(item => item && typeof item === 'object' && Object.keys(item).length === 2
      && ['input_text', 'output_text'].includes(item.type) && typeof item.text === 'string'));
}
function textualInput(value) {
  return typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0 && value.length <= 128
    && value.every(item => item && typeof item === 'object'
      && Object.keys(item).every(key => ['role', 'content', 'type'].includes(key))
      && (item.type === undefined || item.type === 'message')
      && ['system', 'developer', 'user', 'assistant'].includes(item.role) && textContent(item.content));
}
function safeJson(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_024 && value.every(item => safeJson(item, depth + 1));
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length <= 1_024 && Object.entries(value).every(([key, item]) =>
      !['__proto__', 'prototype', 'constructor'].includes(key) && safeJson(item, depth + 1));
}

/** Byte upper bound includes prompt/schema/framing; exact tokenizer billing remains provider-owned. */
export function estimateLivePreviewInputTokens(body) {
  requireBroker(safeJson(body), 'LIVE_PREVIEW_REQUEST_INVALID');
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  requireBroker(bytes <= 4_000_000, 'LIVE_PREVIEW_REQUEST_TOO_LARGE');
  return bytes + LIVE_PREVIEW_INPUT_TOKEN_OVERHEAD;
}

function validateRequest(body, approval) {
  requireBroker(body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => REQUEST_KEYS.has(key)) && textualInput(body.input)
    && (body.instructions === undefined || typeof body.instructions === 'string')
    && (body.stream === undefined || body.stream === false)
    && (body.truncation === undefined || body.truncation === 'disabled')
    && (body.service_tier === undefined || body.service_tier === 'default')
    && (body.parallel_tool_calls === undefined || body.parallel_tool_calls === false)
    && (body.temperature === undefined || (typeof body.temperature === 'number' && Number.isFinite(body.temperature)
      && body.temperature >= 0 && body.temperature <= 2))
    && (body.top_p === undefined || (typeof body.top_p === 'number' && Number.isFinite(body.top_p)
      && body.top_p >= 0 && body.top_p <= 1)), 'LIVE_PREVIEW_REQUEST_INVALID');
  const model = approval.models.find(candidate => candidate.id === body.model);
  requireBroker(model, 'LIVE_PREVIEW_MODEL_UNAPPROVED');
  requireBroker(integer(body.max_output_tokens, 1)
    && body.max_output_tokens <= approval.limits.maxOutputTokensPerRequest, 'LIVE_PREVIEW_OUTPUT_LIMIT');
  const inputTokens = estimateLivePreviewInputTokens(body);
  requireBroker(inputTokens <= approval.limits.maxInputTokensPerRequest, 'LIVE_PREVIEW_INPUT_LIMIT');
  const outputTokens = body.max_output_tokens;
  const spendMicroUsd = Math.ceil(inputTokens * model.inputMicroUsdPerToken + outputTokens * model.outputMicroUsdPerToken);
  requireBroker(integer(spendMicroUsd, 1), 'LIVE_PREVIEW_PRICE_INVALID');
  // No response history, provider storage, caller metadata, tools or alternate endpoint.
  const { metadata: _metadata, ...requestBody } = body;
  return { model, inputTokens, outputTokens, spendMicroUsd,
    requestBody: { ...structuredClone(requestBody), store: false, stream: false, service_tier: 'default' } };
}

/** Trusted supervisor component. Neither provider credentials nor this object enter PR code. */
export function createLivePreviewBroker({ admission, claimRun, resolveCredential, invokeProvider,
  responseModelIdentity, now = Date.now } = {}) {
  assertLivePreviewAdmission(admission, now());
  requireBroker(responseModelIdentity === undefined || typeof responseModelIdentity === 'function', 'LIVE_PREVIEW_TRUSTED_ADAPTERS_REQUIRED');
  const approval = admission.approval;
  let session;
  let authorizationStarted = false;
  let credential;
  let active = false;
  let closed = false;
  let budgetExhausted = false;
  let rejectedBudgetRequests = 0;
  const usage = { requests: 0, metadataRequests: 0, reservedInputTokens: 0, reservedOutputTokens: 0, reservedTotalTokens: 0,
    reservedSpendMicroUsd: 0, observedInputTokens: 0, observedOutputTokens: 0, observedSpendMicroUsd: 0 };
  const outcomes = [];
  const rejections = [];
  let activeAbortController;

  function fresh() {
    requireBroker(!closed, 'LIVE_PREVIEW_RUN_CLOSED');
    assertLivePreviewAdmission(admission, now());
  }
  function requireModule(moduleId) {
    requireBroker(typeof moduleId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(moduleId)
      && approval.moduleIds.includes(moduleId), 'LIVE_PREVIEW_MODULE_UNAPPROVED');
  }
  function rejectBudget(stage, moduleId) {
    budgetExhausted = true;
    rejectedBudgetRequests += 1;
    if (rejections.length < 64) rejections.push({ moduleId, stage, code: 'LIVE_PREVIEW_BUDGET_EXHAUSTED' });
    throw new LivePreviewBrokerError('LIVE_PREVIEW_BUDGET_EXHAUSTED');
  }

  async function authorizeRun() {
    fresh();
    requireBroker(!authorizationStarted, 'LIVE_PREVIEW_RUN_ALREADY_CLAIMED');
    requireBroker(typeof claimRun === 'function' && typeof resolveCredential === 'function'
      && typeof invokeProvider === 'function', 'LIVE_PREVIEW_TRUSTED_ADAPTERS_REQUIRED');
    authorizationStarted = true;
    let claimed;
    try { claimed = await claimRun(approval.approvalId); } catch { closed = true; throw new LivePreviewBrokerError('LIVE_PREVIEW_REPLAY_GUARD_FAILED'); }
    requireBroker(claimed === true, 'LIVE_PREVIEW_APPROVAL_REPLAYED');
    fresh();
    try { credential = await resolveCredential(); } catch { closed = true; throw new LivePreviewBrokerError('LIVE_PREVIEW_CREDENTIAL_UNAVAILABLE'); }
    if (!(typeof credential === 'string' && credential.length >= 32 && credential.length <= 4_096
      && /^sk-[A-Za-z0-9_-]+$/u.test(credential)
      && !/^sk-(?:test|mock|example|placeholder|change[-_]?me|replace)(?:[-_]|$)/iu.test(credential))) {
      closed = true;
      credential = undefined;
      throw new LivePreviewBrokerError('LIVE_PREVIEW_CREDENTIAL_INVALID');
    }
    fresh();
    session = Object.freeze({ brokerBearer: randomBytes(32).toString('hex'), testBearer: 'arcanos-preview-' + randomBytes(32).toString('hex'),
      expiresAtMs: admission.expiresAtMs });
    return session;
  }

  async function invoke(body, bearer, { moduleId, signal, stage = 'model_generation', timeoutMs } = {}) {
    requireBroker(session && opaqueEqual(bearer, session.brokerBearer), 'LIVE_PREVIEW_IDENTITY_UNAUTHORIZED');
    requireModule(moduleId);
    fresh();
    requireBroker(STAGES.has(stage), 'LIVE_PREVIEW_STAGE_INVALID');
    requireBroker(!active, 'LIVE_PREVIEW_CONCURRENCY_LIMIT');
    requireBroker(!signal?.aborted, 'LIVE_PREVIEW_CANCELLED');
    const request = validateRequest(body, approval);
    const limits = approval.limits;
    if (budgetExhausted || usage.requests >= limits.maxRequests
      || usage.reservedTotalTokens + request.inputTokens + request.outputTokens > limits.maxTotalTokens
      || usage.reservedSpendMicroUsd + request.spendMicroUsd > limits.maxSpendMicroUsd) rejectBudget(stage, moduleId);
    const remainingMs = admission.expiresAtMs - now();
    requireBroker(timeoutMs === undefined || (integer(timeoutMs, 1) && timeoutMs <= remainingMs), 'LIVE_PREVIEW_DURATION_LIMIT');
    const requestTimeoutMs = timeoutMs ?? remainingMs;
    requireBroker(integer(requestTimeoutMs, 1), 'LIVE_PREVIEW_DURATION_LIMIT');
    // Never refund reservations: a disconnected or timed-out provider may still bill.
    usage.requests += 1;
    usage.reservedInputTokens += request.inputTokens;
    usage.reservedOutputTokens += request.outputTokens;
    usage.reservedTotalTokens += request.inputTokens + request.outputTokens;
    usage.reservedSpendMicroUsd += request.spendMicroUsd;
    active = true;
    const controller = new AbortController();
    activeAbortController = controller;
    let timer;
    let abortHandler;
    let outcome = 'failed';
    let failureCode;
    let actualModel;
    try {
      const interrupted = new Promise((_, reject) => {
        abortHandler = () => { controller.abort(); reject(new LivePreviewBrokerError('LIVE_PREVIEW_CANCELLED')); };
        signal?.addEventListener('abort', abortHandler, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new LivePreviewBrokerError('LIVE_PREVIEW_PROVIDER_TIMEOUT')); }, requestTimeoutMs);
      });
      const response = await Promise.race([Promise.resolve().then(() => invokeProvider({ url: LIVE_PREVIEW_PROVIDER_URL, method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: request.requestBody, signal: controller.signal })), interrupted]);
      fresh();
      requireBroker(response && response.status === 200 && response.body && typeof response.body === 'object', 'LIVE_PREVIEW_PROVIDER_FAILED');
      try {
        const validatedModel = responseModelIdentity
          ? responseModelIdentity(response.body, request.model.id)
          : response.body.model === request.model.id ? response.body.model : undefined;
        requireBroker(typeof validatedModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(validatedModel)
          && typeof response.body.model === 'string' && validatedModel === response.body.model.trim(),
        'LIVE_PREVIEW_PROVIDER_MODEL_MISMATCH');
        actualModel = validatedModel;
      } catch { throw new LivePreviewBrokerError('LIVE_PREVIEW_PROVIDER_MODEL_MISMATCH'); }
      const observed = response.body.usage;
      requireBroker(observed && integer(observed.input_tokens) && integer(observed.output_tokens)
        && integer(observed.total_tokens) && observed.total_tokens === observed.input_tokens + observed.output_tokens
        && observed.input_tokens <= request.inputTokens && observed.output_tokens <= request.outputTokens,
      'LIVE_PREVIEW_USAGE_INVALID');
      usage.observedInputTokens += observed.input_tokens;
      usage.observedOutputTokens += observed.output_tokens;
      usage.observedSpendMicroUsd += Math.ceil(observed.input_tokens * request.model.inputMicroUsdPerToken
        + observed.output_tokens * request.model.outputMicroUsdPerToken);
      outcome = 'completed';
      return response.body;
    } catch (error) {
      // Unknown failure, invalid usage and timeouts close the entire run. No retry.
      closed = true;
      failureCode = error instanceof LivePreviewBrokerError || error instanceof LivePreviewPolicyError
        ? error.code : 'LIVE_PREVIEW_PROVIDER_FAILED';
      throw new LivePreviewBrokerError(failureCode);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      active = false;
      activeAbortController = undefined;
      outcomes.push({ request: usage.requests, moduleId, stage, model: request.model.id, outcome,
        ...(actualModel ? { actualModel } : {}),
        ...(failureCode ? { code: failureCode } : {}), reservedInputTokens: request.inputTokens,
        reservedOutputTokens: request.outputTokens, reservedSpendMicroUsd: request.spendMicroUsd });
    }
  }

  /** Real authority-model validation shares the signed total-request and time cap. */
  async function retrieveModel(model, bearer, { moduleId, signal, timeoutMs } = {}) {
    requireBroker(session && opaqueEqual(bearer, session.brokerBearer), 'LIVE_PREVIEW_IDENTITY_UNAUTHORIZED');
    requireModule(moduleId);
    fresh();
    requireBroker(approval.models.some(candidate => candidate.id === model), 'LIVE_PREVIEW_MODEL_UNAPPROVED');
    requireBroker(!active, 'LIVE_PREVIEW_CONCURRENCY_LIMIT');
    requireBroker(!signal?.aborted, 'LIVE_PREVIEW_CANCELLED');
    if (budgetExhausted || usage.requests >= approval.limits.maxRequests) rejectBudget('provider_metadata', moduleId);
    const remainingMs = admission.expiresAtMs - now();
    requireBroker(timeoutMs === undefined || (integer(timeoutMs, 1) && timeoutMs <= remainingMs), 'LIVE_PREVIEW_DURATION_LIMIT');
    const requestTimeoutMs = timeoutMs ?? remainingMs;
    requireBroker(integer(requestTimeoutMs, 1), 'LIVE_PREVIEW_DURATION_LIMIT');
    usage.requests += 1;
    usage.metadataRequests += 1;
    const requestNumber = usage.requests;
    active = true;
    const controller = new AbortController();
    activeAbortController = controller;
    let timer;
    let abortHandler;
    let outcome = 'failed';
    let failureCode;
    try {
      const interrupted = new Promise((_, reject) => {
        abortHandler = () => { controller.abort(); reject(new LivePreviewBrokerError('LIVE_PREVIEW_CANCELLED')); };
        signal?.addEventListener('abort', abortHandler, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new LivePreviewBrokerError('LIVE_PREVIEW_PROVIDER_TIMEOUT')); }, requestTimeoutMs);
      });
      const response = await Promise.race([Promise.resolve().then(() => invokeProvider({
        url: LIVE_PREVIEW_MODEL_URL_PREFIX + encodeURIComponent(model), method: 'GET',
        headers: { authorization: `Bearer ${credential}` }, signal: controller.signal })), interrupted]);
      fresh();
      requireBroker(response && response.status === 200 && response.body?.id === model
        && response.body.object === 'model', 'LIVE_PREVIEW_MODEL_VALIDATION_FAILED');
      outcome = 'completed';
      return { id: model, object: 'model' };
    } catch (error) {
      closed = true;
      failureCode = error instanceof LivePreviewBrokerError || error instanceof LivePreviewPolicyError
        ? error.code : 'LIVE_PREVIEW_PROVIDER_FAILED';
      throw new LivePreviewBrokerError(failureCode);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      active = false;
      activeAbortController = undefined;
      outcomes.push({ request: requestNumber, moduleId, stage: 'provider_metadata', model, outcome,
        ...(failureCode ? { code: failureCode } : {}), reservedInputTokens: 0, reservedOutputTokens: 0, reservedSpendMicroUsd: 0 });
    }
  }

  function evidence() {
    return { mode: 'live-backend', approvalId: approval.approvalId, prNumber: approval.prNumber, commitSha: approval.commitSha,
      moduleIds: [...approval.moduleIds],
      deployment: { ...approval.deployment }, attestationSha256: approval.attestationSha256,
      expiresAtMs: admission.expiresAtMs, limits: { ...approval.limits, maxConcurrency: 1, maxRetries: 0 },
      usage: { ...usage, providerCalls: usage.requests - usage.metadataRequests,
        generationCalls: outcomes.filter(outcome => outcome.stage === 'model_generation').length,
        auditCalls: outcomes.filter(outcome => outcome.stage === 'answer_audit').length,
        elapsedMs: Math.max(0, now() - admission.admittedAtMs), rejectedBudgetRequests },
      stages: outcomes.map(outcome => ({ ...outcome })), rejections: rejections.map(rejection => ({ ...rejection })), budgetExhausted, closed,
      billing: 'Conservative reservations are never refunded; provider billing and tokenizer behavior are not independently exact.' };
  }
  function close() { closed = true; credential = undefined; activeAbortController?.abort(); }
  return Object.freeze({ authorizeRun, invoke, retrieveModel, evidence, close });
}
