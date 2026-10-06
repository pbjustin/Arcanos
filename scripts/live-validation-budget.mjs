/** One process, one admitted deployment run. Reservations are never refunded or reset. */
export const LIVE_VALIDATION_BUDGET_CAPS = Object.freeze({ maxSpendMicroUsd: 2_000_000,
  maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 });
export const LIVE_VALIDATION_TOKEN_LIMITS = Object.freeze({ maxInputTokensPerRequest: 128_000,
  maxOutputTokensPerRequest: 4_096, maxTotalTokens: 400_000 });
const CASES = new Set(['gaming-guide-positive', 'gaming-guide-negative']);
const STAGES = new Set(['generation', 'answer_audit', 'metadata']);
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export class LiveValidationBudgetError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationBudgetError'; this.code = code; }
}
function requireBudget(condition, code) { if (!condition) throw new LiveValidationBudgetError(code); }
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function plain(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && Object.hasOwn(item, 'value'));
}
function price(model, inputTokens, outputTokens) {
  const amount = Math.ceil(inputTokens * model.inputMicroUsdPerToken + outputTokens * model.outputMicroUsdPerToken);
  requireBudget(integer(amount), 'LIVE_VALIDATION_BUDGET_PRICE_INVALID'); return amount;
}

/** The Railway service is single replica; process restart requires a new explicitly authorized run. */
export function createLiveValidationBudget({ limits: configured = LIVE_VALIDATION_BUDGET_CAPS, models,
  now = Date.now, expiresAtMs } = {}) {
  requireBudget(typeof now === 'function', 'LIVE_VALIDATION_BUDGET_CLOCK_INVALID');
  requireBudget(plain(configured, Object.keys(LIVE_VALIDATION_BUDGET_CAPS))
    && Object.entries(LIVE_VALIDATION_BUDGET_CAPS).every(([key, maximum]) => integer(configured[key], 1, maximum)),
  'LIVE_VALIDATION_BUDGET_LIMITS_INVALID');
  requireBudget(Array.isArray(models) && models.length > 0 && models.length <= 8
    && models.every(model => plain(model, ['id', 'inputMicroUsdPerToken', 'outputMicroUsdPerToken'])
      && typeof model.id === 'string' && MODEL.test(model.id)
      && [model.inputMicroUsdPerToken, model.outputMicroUsdPerToken].every(rate =>
        typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 100_000))
    && new Set(models.map(model => model.id)).size === models.length, 'LIVE_VALIDATION_BUDGET_MODELS_INVALID');
  const approvedModels = structuredClone(models);
  const limits = Object.freeze({ ...LIVE_VALIDATION_TOKEN_LIMITS, ...configured, maxConcurrency: 1, maxRetries: 0 });
  const startedAtMs = now(); let lastSeenAtMs = startedAtMs;
  requireBudget(integer(startedAtMs), 'LIVE_VALIDATION_BUDGET_CLOCK_INVALID');
  const deadline = expiresAtMs === undefined ? startedAtMs + limits.durationMs : expiresAtMs;
  requireBudget(integer(deadline, startedAtMs + 1, startedAtMs + limits.durationMs), 'LIVE_VALIDATION_BUDGET_EXPIRED');
  const usage = Object.fromEntries(['requests', 'providerCalls', 'generationCalls', 'auditCalls',
    'reservedInputTokens', 'reservedOutputTokens', 'reservedTotalTokens', 'reservedSpendMicroUsd',
    'observedInputTokens', 'observedOutputTokens', 'observedSpendMicroUsd'].map(key => [key, 0]));
  const workflows = new Set(); let workflow; let pending; let closed = false;
  function close() { closed = true; }
  function current() {
    const value = now();
    if (!integer(value, lastSeenAtMs)) { close(); throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_CLOCK_INVALID'); }
    lastSeenAtMs = value;
    if (value >= deadline) { close(); throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_EXPIRED'); }
    requireBudget(!closed, 'LIVE_VALIDATION_RUN_CLOSED'); return value;
  }
  function snapshot() {
    // Inspection remains available after timeout/failure so the result retains consumed reservations.
    const value = now();
    if (!integer(value, lastSeenAtMs)) close();
    else { lastSeenAtMs = value; if (value >= deadline) close(); }
    return { usage: { ...usage, metadataRequests: usage.requests - usage.providerCalls,
      observedTotalTokens: usage.observedInputTokens + usage.observedOutputTokens,
      elapsedMs: Math.max(0, lastSeenAtMs - startedAtMs) }, limits: { ...limits },
      counts: { workflows: workflows.size, pendingRequests: pending ? 1 : 0 }, closed };
  }
  return Object.freeze({
    beginWorkflow(caseId) {
      current(); requireBudget(CASES.has(caseId), 'LIVE_VALIDATION_CASE_FORBIDDEN');
      requireBudget(!workflow && !pending, 'LIVE_VALIDATION_CONCURRENCY_LIMIT');
      requireBudget(!workflows.has(caseId), 'LIVE_VALIDATION_WORKFLOW_REPLAY');
      requireBudget(workflows.size < limits.maxWorkflows, 'LIVE_VALIDATION_WORKFLOW_LIMIT');
      workflows.add(caseId); workflow = caseId;
    },
    endWorkflow() {
      current(); requireBudget(workflow && !pending, 'LIVE_VALIDATION_WORKFLOW_INVALID'); workflow = undefined;
    },
    reserve(request) {
      current(); requireBudget(!pending, 'LIVE_VALIDATION_CONCURRENCY_LIMIT');
      requireBudget(plain(request, ['model', 'inputTokens', 'outputTokens', 'stage']) && STAGES.has(request.stage),
        'LIVE_VALIDATION_BUDGET_RESERVATION_INVALID');
      if (workflow === 'gaming-guide-negative') { close(); throw new LiveValidationBudgetError('LIVE_VALIDATION_NEGATIVE_PROVIDER_FORBIDDEN'); }
      requireBudget(request.stage === 'metadata' || workflow === 'gaming-guide-positive', 'LIVE_VALIDATION_WORKFLOW_REQUIRED');
      const model = approvedModels.find(candidate => candidate.id === request.model);
      requireBudget(model, 'LIVE_VALIDATION_MODEL_UNAPPROVED');
      requireBudget(integer(request.inputTokens, 0, limits.maxInputTokensPerRequest)
        && integer(request.outputTokens, 0, limits.maxOutputTokensPerRequest)
        && (request.stage === 'metadata' ? request.inputTokens === 0 && request.outputTokens === 0
          : request.inputTokens > 0 && request.outputTokens > 0), 'LIVE_VALIDATION_BUDGET_RESERVATION_INVALID');
      const reservedSpendMicroUsd = price(model, request.inputTokens, request.outputTokens);
      if (usage.requests + 1 > limits.maxRequests
        || usage.reservedTotalTokens + request.inputTokens + request.outputTokens > limits.maxTotalTokens
        || usage.reservedSpendMicroUsd + reservedSpendMicroUsd > limits.maxSpendMicroUsd) {
        close(); throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_EXHAUSTED');
      }
      usage.requests++;
      usage.providerCalls += Number(request.stage !== 'metadata');
      usage.generationCalls += Number(request.stage === 'generation');
      usage.auditCalls += Number(request.stage === 'answer_audit');
      usage.reservedInputTokens += request.inputTokens; usage.reservedOutputTokens += request.outputTokens;
      usage.reservedTotalTokens += request.inputTokens + request.outputTokens;
      usage.reservedSpendMicroUsd += reservedSpendMicroUsd;
      pending = { ...request, id: usage.requests, modelPrice: model }; return pending.id;
    },
    settle(id, observed) {
      current();
      if (!(pending?.id === id && plain(observed, ['model', 'inputTokens', 'outputTokens'])
        && observed.model === pending.model && integer(observed.inputTokens, 0, pending.inputTokens)
        && integer(observed.outputTokens, 0, pending.outputTokens))) {
        close(); throw new LiveValidationBudgetError('LIVE_VALIDATION_USAGE_INVALID');
      }
      usage.observedInputTokens += observed.inputTokens; usage.observedOutputTokens += observed.outputTokens;
      usage.observedSpendMicroUsd += price(pending.modelPrice, observed.inputTokens, observed.outputTokens);
      pending = undefined;
    },
    remainingMs() { return deadline - current(); }, snapshot, close
  });
}
