import { createLiveValidationBudget } from './live-validation-budget.mjs';
import { createLiveValidationProviderTransport, LIVE_VALIDATION_MODEL_URL_PREFIX,
  LIVE_VALIDATION_RESPONSES_URL, validateLiveValidationProviderRequest } from './live-validation-egress.mjs';

const INPUT_TOKEN_OVERHEAD = 1_024;
const REQUEST_LIMIT = 4_000_000;
const STAGES = new Set(['generation', 'answer_audit']);
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
export class LiveValidationProviderError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationProviderError'; this.code = code; }
}
function requireProvider(condition, code) { if (!condition) throw new LiveValidationProviderError(code); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function safeCode(error) {
  return /^LIVE_VALIDATION_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'LIVE_VALIDATION_PROVIDER_FAILED';
}

/** Direct SDK fetch with one non-resettable paid budget, ordinary public TLS, and no broker. */
export function createLiveValidationProvider({ target, identity, apiKey, now = Date.now,
  fetchImplementation = globalThis.fetch, getRemainingMs = () => null, observation = () => ({ moduleId: 'gaming', stage: 'generation' }),
  expiresAtMs, responseModelIdentity } = {}) {
  requireProvider(typeof apiKey === 'string' && apiKey.length >= 32 && apiKey.length <= 4_096
    && /^sk-[A-Za-z0-9_-]+$/u.test(apiKey)
    && !/^sk-(?:test|mock|example|placeholder|change[-_]?me|replace)(?:[-_]|$)/iu.test(apiKey),
  'LIVE_VALIDATION_CREDENTIAL_INVALID');
  requireProvider(typeof getRemainingMs === 'function' && typeof observation === 'function'
    && (responseModelIdentity === undefined || typeof responseModelIdentity === 'function')
    && /^[0-9a-f]{40}$/u.test(identity?.sourceCommit ?? '')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(identity?.deploymentId ?? ''),
  'LIVE_VALIDATION_DEPLOYMENT_MISMATCH');
  const budget = createLiveValidationBudget({ limits: target?.limits, models: target?.models, now, expiresAtMs });
  const models = structuredClone(target.models);
  const transport = createLiveValidationProviderTransport({ approvedModels: models, fetchImplementation });
  let credential = apiKey; let workflow; let active = false; let activeAbort; let closed = false;
  const stages = [];
  let expiryTimer = setTimeout(() => close(), budget.remainingMs()); expiryTimer.unref();
  function close() {
    closed = true; credential = undefined; clearTimeout(expiryTimer); expiryTimer = undefined;
    budget.close(); activeAbort?.abort();
  }
  function snapshot() {
    const state = budget.snapshot();
    if (state.closed && !closed) close(); return { ...state, stages: structuredClone(stages) };
  }
  function beginWorkflow(caseId) {
    budget.beginWorkflow(caseId);
    workflow = { caseId, generationCompleted: 0, auditCompleted: 0, lastContentStage: null };
  }
  function endWorkflow() {
    if (workflow?.caseId === 'gaming-guide-positive' && !(workflow.generationCompleted > 0
      && workflow.auditCompleted > 0 && workflow.lastContentStage === 'answer_audit')) {
      close(); throw new LiveValidationProviderError('LIVE_VALIDATION_AUDIT_REQUIRED');
    }
    budget.endWorkflow(); workflow = undefined;
  }
  function parseRequest(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    requireProvider(!headers.has('x-stainless-retry-count') || headers.get('x-stainless-retry-count') === '0',
      'LIVE_VALIDATION_RETRIES_FORBIDDEN');
    let body; let model; let canonicalUrl = url;
    if (method === 'GET') {
      // The SDK may use an unescaped fine-tune ID; the actual request always uses the canonical URL.
      model = models.find(candidate => url === LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(candidate.id)
        || url === LIVE_VALIDATION_MODEL_URL_PREFIX + candidate.id)?.id;
      requireProvider(model && init?.body === undefined, 'LIVE_VALIDATION_PROVIDER_URL_FORBIDDEN');
      canonicalUrl = LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(model);
    } else {
      requireProvider(typeof init?.body === 'string' && Buffer.byteLength(init.body, 'utf8') <= REQUEST_LIMIT,
        'LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN');
      try { body = JSON.parse(init.body); } catch { throw new LiveValidationProviderError('LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN'); }
      model = body?.model;
    }
    validateLiveValidationProviderRequest({ url: canonicalUrl, method, body }, { approvedModels: models });
    const rawTimeout = headers.get('x-stainless-timeout');
    const nativeTimeoutMs = rawTimeout === null ? 120_000
      : /^[0-9]+(?:\.[0-9]+)?$/u.test(rawTimeout) ? Math.floor(Number(rawTimeout) * 1_000) : 0;
    requireProvider(integer(nativeTimeoutMs, 1), 'LIVE_VALIDATION_DURATION_LIMIT');
    return { url: canonicalUrl, method, body, model, nativeTimeoutMs,
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) };
  }
  function contentRequest(body) {
    const limits = budget.snapshot().limits;
    requireProvider((body.instructions === undefined || typeof body.instructions === 'string')
      && integer(body.max_output_tokens, 1) && body.max_output_tokens <= limits.maxOutputTokensPerRequest
      && (body.temperature === undefined || typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2)
      && (body.top_p === undefined || typeof body.top_p === 'number' && body.top_p >= 0 && body.top_p <= 1)
      && (body.truncation === undefined || body.truncation === 'disabled')
      && (body.service_tier === undefined || body.service_tier === 'default'), 'LIVE_VALIDATION_REQUEST_INVALID');
    // One byte per token plus framing is a conservative upper bound, including JSON schemas.
    const inputTokens = Buffer.byteLength(JSON.stringify(body), 'utf8') + INPUT_TOKEN_OVERHEAD;
    requireProvider(inputTokens <= limits.maxInputTokensPerRequest, 'LIVE_VALIDATION_INPUT_LIMIT');
    const { metadata: _metadata, ...requestBody } = body;
    return { inputTokens, outputTokens: body.max_output_tokens,
      body: { ...requestBody, store: false, stream: false, service_tier: 'default' } };
  }
  async function guardedFetch(input, init) {
    let stage; let timedOut = false; let callerAborted = false; let timer; let onCallerAbort;
    let reservation; let request; let controller; let onAbort;
    let startedAtMs; let actualModel; let failureCode;
    try {
      requireProvider(!closed, 'LIVE_VALIDATION_RUN_CLOSED');
      requireProvider(!active, 'LIVE_VALIDATION_CONCURRENCY_LIMIT');
      request = parseRequest(input, init);
      requireProvider(!request.signal?.aborted, 'LIVE_VALIDATION_PROVIDER_CANCELLED');
      requireProvider(workflow?.caseId !== 'gaming-guide-negative', 'LIVE_VALIDATION_NEGATIVE_PROVIDER_FORBIDDEN');
      const observed = observation();
      stage = request.method === 'GET' ? 'metadata' : observed?.stage;
      requireProvider(stage === 'metadata' || observed?.moduleId === 'gaming' && STAGES.has(stage), 'LIVE_VALIDATION_STAGE_INVALID');
      if (stage !== 'metadata') {
        requireProvider(workflow?.caseId === 'gaming-guide-positive' || workflow?.caseId === 'gaming-guide-negative',
          'LIVE_VALIDATION_WORKFLOW_REQUIRED');
        requireProvider(stage !== 'generation' || workflow.lastContentStage !== 'answer_audit', 'LIVE_VALIDATION_REGENERATION_FORBIDDEN');
        requireProvider(stage !== 'answer_audit' || workflow.generationCompleted > 0, 'LIVE_VALIDATION_AUDIT_ORDER_INVALID');
      }
      const content = stage === 'metadata' ? { inputTokens: 0, outputTokens: 0 } : contentRequest(request.body);
      const remaining = getRemainingMs();
      requireProvider(remaining === null || remaining === undefined || typeof remaining === 'number' && Number.isFinite(remaining),
        'LIVE_VALIDATION_DURATION_LIMIT');
      const timeoutMs = Math.floor(Math.min(request.nativeTimeoutMs, budget.remainingMs(), remaining ?? Number.POSITIVE_INFINITY));
      requireProvider(integer(timeoutMs, 1), 'LIVE_VALIDATION_DURATION_LIMIT');
      reservation = budget.reserve({ model: request.model, inputTokens: content.inputTokens, outputTokens: content.outputTokens, stage });
      startedAtMs = now();
      active = true; controller = new AbortController(); activeAbort = controller;
      if (stage !== 'metadata') workflow.lastContentStage = stage;
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(new LiveValidationProviderError(timedOut ? 'LIVE_VALIDATION_PROVIDER_TIMEOUT'
          : callerAborted ? 'LIVE_VALIDATION_PROVIDER_CANCELLED' : 'LIVE_VALIDATION_RUN_CLOSED'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        onCallerAbort = () => { callerAborted = true; controller.abort(); };
        request.signal?.addEventListener('abort', onCallerAbort, { once: true });
        if (request.signal?.aborted) onCallerAbort();
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => {
        requireProvider(!controller.signal.aborted, 'LIVE_VALIDATION_PROVIDER_CANCELLED');
        return transport({ url: request.url, method: request.method, body: content.body,
          headers: { authorization: 'Bearer ' + credential }, signal: controller.signal });
      }), interrupted]);
      const body = result.body;
      requireProvider(result.status === 200 && body && typeof body === 'object', 'LIVE_VALIDATION_PROVIDER_FAILED');
      let inputTokens = 0; let outputTokens = 0;
      if (stage === 'metadata') {
        requireProvider(body.id === request.model && body.object === 'model', 'LIVE_VALIDATION_MODEL_VALIDATION_FAILED');
        actualModel = request.model;
      } else {
        try { actualModel = responseModelIdentity ? responseModelIdentity(body, request.model)
          : body.model === request.model ? body.model : undefined; }
        catch { throw new LiveValidationProviderError('LIVE_VALIDATION_PROVIDER_MODEL_MISMATCH'); }
        requireProvider(typeof actualModel === 'string' && MODEL.test(actualModel) && typeof body.model === 'string'
          && actualModel === body.model.trim(), 'LIVE_VALIDATION_PROVIDER_MODEL_MISMATCH');
        requireProvider(body.usage && integer(body.usage.input_tokens) && integer(body.usage.output_tokens)
          && integer(body.usage.total_tokens) && body.usage.total_tokens === body.usage.input_tokens + body.usage.output_tokens,
        'LIVE_VALIDATION_USAGE_INVALID');
        inputTokens = body.usage.input_tokens; outputTokens = body.usage.output_tokens;
      }
      budget.settle(reservation, { model: request.model, inputTokens, outputTokens });
      if (stage === 'generation') workflow.generationCompleted++;
      if (stage === 'answer_audit') workflow.auditCompleted++;
      return Response.json(stage === 'metadata' ? { id: request.model, object: 'model' } : body);
    } catch (error) {
      const code = timedOut ? 'LIVE_VALIDATION_PROVIDER_TIMEOUT' : safeCode(error);
      failureCode = code;
      const observed = observation();
      if (code === 'LIVE_VALIDATION_PROVIDER_TIMEOUT' && stage !== 'metadata' && observed) observed.timeoutStage = stage;
      if (code === 'LIVE_VALIDATION_BUDGET_EXHAUSTED' && observed) observed.budgetExhausted = true;
      close(); throw new LiveValidationProviderError(code);
    } finally {
      clearTimeout(timer); request?.signal?.removeEventListener('abort', onCallerAbort);
      controller?.signal.removeEventListener('abort', onAbort);
      if (reservation !== undefined) {
        stages.push({ caseId: workflow?.caseId ?? null, stage, model: request.model,
          ...(actualModel ? { actualModel } : {}), outcome: failureCode ? 'failed' : 'completed',
          elapsedMs: Math.max(0, now() - startedAtMs), ...(failureCode ? { code: failureCode } : {}) });
        active = false; activeAbort = undefined;
      }
    }
  }
  return Object.freeze({ fetch: guardedFetch, beginWorkflow, endWorkflow, snapshot, close });
}
