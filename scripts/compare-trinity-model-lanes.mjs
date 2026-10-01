import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPARISON_LIMITS = Object.freeze({ maxCalls: 6, maxAttemptsPerModelCase: 1,
  maxRetries: 0, maxRepairs: 0, timeoutMs: 4_000, totalTimeoutMs: 30_000 });
const EVALUATION_TARGET = 'https://api.openai.com/v1';
// Fixed invented input only. No file, HTTP, stdin or caller-supplied prompt is accepted.
const facts = 'A fictional crate contains 12 red tokens and 7 blue tokens. Count the tokens; use only these supplied facts.';
const cases = Object.freeze([
  { lane: 'reasoning', models: ['gpt-5.6-terra', 'gpt-6.1-sol'], maxOutputTokens: 2_048,
    prompt: `${facts} Produce the structured Trinity reasoning result with an answer and no external verification claims.` },
  { lane: 'intake', models: ['gpt-4.1-mini', 'gpt-6-luna'], maxOutputTokens: 500,
    prompt: `${facts} Frame a concise task card, at most 60 words, without answering the arithmetic question.` },
  { lane: 'final', models: ['gpt-4.1', 'gpt-6-luna'], maxOutputTokens: 1_024,
    prompt: `${facts} Answer the arithmetic question in one concise sentence.` }
]);
const hash = value => createHash('sha256').update(value).digest('hex');
const emptyMetrics = () => ({ schemaValid: null, timeout: null, fallback: null, latencyMs: null,
  promptTokens: null, outputTokens: null, totalTokens: null, incomplete: null, truncated: null, clearOutcome: null });

async function loadRuntime() {
  const modules = await Promise.all([
    import('../dist/core/adapters/openai.adapter.js'), import('../dist/services/openai/structuredReasoning.js'),
    import('../dist/services/openai/chatFallbacks.js'), import('../dist/services/openai/aiExecutionContext.js'),
    import('../dist/platform/runtime/env.js'), import('@arcanos/runtime'),
    import('@arcanos/openai/responses'), import('../dist/shared/tokenParameterHelper.js'),
    import('../dist/shared/gpt/trinityReasoningPolicy.js')
  ]);
  return Object.assign({}, ...modules);
}

function summarize(results) {
  const attempted = results.filter(result => result.attempted);
  const structured = attempted.filter(result => result.lane === 'reasoning');
  const count = field => attempted.filter(result => result[field] === true).length;
  return { attempted: attempted.length, completed: attempted.filter(result => result.status === 'completed').length,
    failed: attempted.filter(result => result.status === 'failed').length,
    schemaValidRate: structured.length ? structured.filter(result => result.schemaValid === true).length / structured.length : null,
    timeoutRate: attempted.length ? count('timeout') / attempted.length : null,
    incompleteRate: attempted.length ? count('incomplete') / attempted.length : null,
    truncatedRate: attempted.length ? count('truncated') / attempted.length : null,
    fallbackRate: null, clearAcceptanceRate: null,
    latencyMs: attempted.length ? attempted.reduce((sum, result) => sum + result.latencyMs, 0) / attempted.length : null };
}

/** Default is an offline plan. The injected runtime exists for synthetic adapter tests only. */
export async function runModelLaneComparison({ execute = false, confirmNonProduction = false,
  evaluationTarget, runtime } = {}) {
  // Historical baselines include retired helper/final models. They are retained
  // only as an offline plan; execution must not partly dispatch before policy rejects them.
  if (execute) throw new Error('HISTORICAL_MODEL_COMPARISON_DISABLED');
  const results = cases.flatMap(fixture => fixture.models.map(model => ({ lane: fixture.lane, model,
    fixtureHash: hash(fixture.prompt), promptChars: fixture.prompt.length, maxOutputTokens: fixture.maxOutputTokens,
    attempted: false, status: 'not_run', ...emptyMetrics() })));
  const report = { schemaVersion: 'trinity-model-lane-comparison/v1', syntheticOnly: true,
    execution: 'dry_run', historicalOnly: true, limits: COMPARISON_LIMITS, aggregateBudgetExhausted: false,
    measurementScope: 'Single bounded lane requests; full-pipeline fallback and CLEAR judgment are not assessed.',
    results, summary: summarize(results) };
  if (!execute) return report;
  if (!confirmNonProduction || evaluationTarget !== EVALUATION_TARGET) throw new Error('EXPLICIT_NON_PRODUCTION_TARGET_REQUIRED');
  const api = runtime ?? await loadRuntime();
  if (api.getEnv('NODE_ENV') === 'production' || api.getEnv('RAILWAY_ENVIRONMENT') === 'production'
    || api.getEnv('RAILWAY_ENVIRONMENT_ID') || api.getEnv('DISABLE_EXTERNAL_CALLS') === 'true') {
    throw new Error('EVALUATION_ENVIRONMENT_NOT_APPROVED');
  }
  const apiKey = api.getEnv('OPENAI_API_KEY');
  if (!apiKey) throw new Error('EVALUATION_CREDENTIAL_REQUIRED');
  const adapter = api.createOpenAIAdapter({ apiKey, baseURL: evaluationTarget,
    timeout: COMPARISON_LIMITS.timeoutMs, maxRetries: 0, ...(api.fetch ? { fetch: api.fetch } : {}) });
  let observed;
  const originalCreate = adapter.responses.create;
  const observeCreate = async (...args) => {
    const response = await originalCreate({ ...args[0], store: false }, args[1]);
    const semantics = api.normalizeOpenAIResponseSemantics(response);
    // Only provider status and numeric accounting leave this wrapper; no output text is retained in the report.
    observed = { promptTokens: semantics.usage.promptTokens, outputTokens: semantics.usage.completionTokens,
      totalTokens: semantics.usage.totalTokens, incomplete: semantics.incomplete, truncated: semantics.truncated };
    return response;
  };
  adapter.responses.create = observeCreate;
  adapter.getClient().responses.create = observeCreate;
  const budget = api.createRuntimeBudgetWithLimit(COMPARISON_LIMITS.totalTimeoutMs, 0);
  const context = api.createAiExecutionContext({ sourceType: 'background', sourceName: 'synthetic-model-lane-comparison',
    budget: { maxCalls: COMPARISON_LIMITS.maxCalls } });
  let currentStartedAt;
  try {
    await api.runWithRequestAbortTimeout({ timeoutMs: COMPARISON_LIMITS.totalTimeoutMs },
    () => api.runWithAiExecutionContext(context, async () => {
      for (const result of results) {
        const remainingMs = Math.min(api.getSafeRemainingMs(budget), api.getRequestRemainingMs() ?? COMPARISON_LIMITS.totalTimeoutMs);
        if (remainingMs <= 0) { report.aggregateBudgetExhausted = true; result.status = 'budget_exhausted'; continue; }
        const fixture = cases.find(item => item.lane === result.lane);
        const startedAt = Date.now();
        currentStartedAt = startedAt;
        result.attempted = true;
        observed = undefined;
        try {
          if (result.lane === 'reasoning') {
            await api.runStructuredReasoning(adapter.getClient(), result.model, fixture.prompt, budget,
              Math.min(remainingMs, COMPARISON_LIMITS.timeoutMs), { schemaVariant: 'full', reasoningEffort: 'low',
                maxOutputTokens: result.maxOutputTokens });
            result.schemaValid = true;
          } else {
            const reasoningEffort = api.resolveOpenAIModelCapabilities(result.model).normalizeReasoningRequests
              ? api.normalizeOpenAIModelReasoningEffort(result.model, 'none') : undefined;
            await api.createSingleChatCompletion(adapter, { model: result.model,
              ...api.getTokenParameter(result.model, result.maxOutputTokens),
              ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
              messages: [{ role: 'user', content: fixture.prompt }],
              timeoutMs: Math.min(remainingMs, COMPARISON_LIMITS.timeoutMs), maxRetries: 0, redactErrorDetails: true });
          }
          result.status = 'completed';
          result.timeout = false;
        } catch (error) {
          result.status = 'failed';
          result.timeout = api.isAbortError(error);
          if (result.lane === 'reasoning' && !result.timeout && observed) result.schemaValid = false;
          // Never publish provider error messages, raw output or credentials.
          result.failure = result.timeout ? 'TIMEOUT' : observed?.incomplete ? 'INCOMPLETE_OUTPUT' : 'VALIDATION_OR_PROVIDER_FAILURE';
        }
        Object.assign(result, observed ?? {}, { latencyMs: Date.now() - startedAt });
      }
    }));
  } catch (error) {
    if (!api.isAbortError(error)) throw error;
    report.aggregateBudgetExhausted = true;
    for (const result of results.filter(item => item.status === 'not_run')) {
      if (!result.attempted) result.status = 'budget_exhausted';
      else Object.assign(result, observed ?? {}, { status: 'failed', timeout: true, failure: 'TIMEOUT',
        latencyMs: Date.now() - currentStartedAt });
    }
  }
  report.summary = summarize(results);
  return report;
}

export function parseComparisonArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--execute') options.execute = true;
    else if (args[index] === '--confirm-non-production') options.confirmNonProduction = true;
    else if (args[index] === '--evaluation-target' && args[index + 1]) options.evaluationTarget = args[++index];
    else if (args[index] !== '--dry-run') throw new Error('UNSUPPORTED_ARGUMENT');
  }
  if (args.includes('--dry-run') && options.execute) throw new Error('CONFLICTING_EXECUTION_MODE');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runModelLaneComparison(parseComparisonArguments(process.argv.slice(2))).then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch(() => {
    process.stderr.write('MODEL_LANE_COMPARISON_BLOCKED: no provider or credential details are logged.\n');
    process.exitCode = 1;
  });
}
