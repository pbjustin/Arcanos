import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { startGenerativeModelPolicyProvider } from './fixtures/generative-model-policy-provider.js';

const originalEnvironment = process.env;
const authorityModel = 'ft:gpt-4.1:synthetic:trinity-http-authority';
const authorityEnvironmentNames = [
  'FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID',
  'RAILWAY_FINE_TUNED_MODEL_ID', 'AI_MODEL', 'RAILWAY_AI_MODEL',
  'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL', 'RAILWAY_RAILWAY_OPENAI_MODEL'
];
const simplePrompt = 'Assess the supplied launch outline and its stated limitations.';
const complexPrompt = 'Explain the architecture of the supplied launch outline.';
const answer = 'The supplied outline describes a staged release.';
const reasoningDraft = 'Synthetic internal reasoning draft.';
const scores = { clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 };
const stageUsage = [
  { inputTokens: 3, outputTokens: 4 },
  { inputTokens: 11, outputTokens: 13 },
  { inputTokens: 5, outputTokens: 7 },
  { inputTokens: 17, outputTokens: 19 }
];

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...originalEnvironment };
  // Prevent dotenv from backfilling any authority, credential or service target.
  for (const name of [
    ...authorityEnvironmentNames,
    'OPENAI_API_KEY', 'RAILWAY_OPENAI_API_KEY', 'OPENAI_KEY', 'API_KEY',
    'OPENAI_BASE_URL', 'RAILWAY_OPENAI_BASE_URL',
    'DATABASE_URL', 'RAILWAY_DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
    'REDIS_URL', 'REDIS_HOST', 'REDISHOST', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN',
    'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID'
  ]) environment[name] = '';
  return {
    ...environment,
    NODE_ENV: 'test',
    FINETUNED_MODEL_ID: authorityModel,
    RUN_WORKERS: 'false',
    SELF_IMPROVE_ENABLED: 'false',
    TRINITY_JUDGED_FEEDBACK_ENABLED: 'false',
    ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS: 'false',
    ARCANOS_CONTEXT_MODE: 'disabled',
    AI_TRACE_LOGGING: 'false',
    LOG_LEVEL: 'error',
    // Historical module selectors deliberately conflict with the central policy.
    TRINITY_INTAKE_MODEL: 'gpt-4.1-mini',
    TRINITY_REASONING_MODEL: 'gpt-5.1',
    TRINITY_FINAL_MODEL: 'gpt-6-luna',
    TRINITY_FINAL_ESCALATION_MODEL: 'gpt-6.1-sol',
    CLEAR_AUDIT_MODEL: 'gpt-4.1-mini'
  };
}

const getMemoryContext = jest.fn(() => {
  throw new Error('The isolated pipeline must not read backend memory.');
});
const storePattern = jest.fn(() => {
  throw new Error('The isolated pipeline must not persist memory patterns.');
});
const processJudgedResponseFeedback = jest.fn(async () => {
  throw new Error('The isolated pipeline must not persist judged feedback.');
});
const runSelfImproveCycle = jest.fn(async () => {
  throw new Error('The isolated pipeline must not start background self-improvement.');
});
const recordJobEvent = jest.fn(async () => {
  throw new Error('The isolated request must not write job events.');
});
const reserveWorkerAiProviderAttempt = jest.fn(async () => {
  throw new Error('The isolated request must not contact worker budget storage.');
});
const logAITaskLineage = jest.fn();

// Only unrelated persistence, background work and the on-disk audit sink are
// replaced. The facade, role policy, stage runners, guards, audit/schema
// validation, adapter, installed SDK and native HTTP transport remain real.
jest.unstable_mockModule('@services/memoryAware.js', () => ({ getMemoryContext, storePattern }));
jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({ processJudgedResponseFeedback }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle }));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({ recordJobEvent }));
jest.unstable_mockModule('@core/db/repositories/workerBudgetRepository.js', () => ({
  reserveWorkerAiProviderAttempt,
  WORKER_BUDGET_NON_JOB_SUBJECT_ID: 'synthetic-non-job'
}));

let pipeline: typeof import('../src/core/logic/trinityWritingPipeline.js');
let runtimeBudget: typeof import('../src/platform/resilience/runtimeBudget.js');
let adapter: typeof import('../src/core/adapters/openai.adapter.js');
let credentials: typeof import('../src/services/openai/credentialProvider.js');
let execution: typeof import('../src/services/openai/aiExecutionContext.js');
let attemptTokens: typeof import('../src/services/openai/attemptTokenUsage.js');
let selfHealing: typeof import('../src/services/selfImprove/selfHealingV2.js');
let fixture: Awaited<ReturnType<typeof startGenerativeModelPolicyProvider>>;
let consoleLogSpy: ReturnType<typeof jest.spyOn>;
let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

beforeAll(async () => {
  process.env = isolatedEnvironment();
  const actualAuditSafe = await import('../src/services/auditSafe.js');
  jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...actualAuditSafe, logAITaskLineage }));
  // These imports share one ESM graph; link it once before loading its helpers.
  pipeline = await import('../src/core/logic/trinityWritingPipeline.js');
  runtimeBudget = await import('../src/platform/resilience/runtimeBudget.js');
  adapter = await import('../src/core/adapters/openai.adapter.js');
  credentials = await import('../src/services/openai/credentialProvider.js');
  execution = await import('../src/services/openai/aiExecutionContext.js');
  attemptTokens = await import('../src/services/openai/attemptTokenUsage.js');
  selfHealing = await import('../src/services/selfImprove/selfHealingV2.js');
});

beforeEach(async () => {
  process.env = isolatedEnvironment();
  fixture = await startGenerativeModelPolicyProvider({ authorityModel, maxRequests: 16 });
  process.env.OPENAI_API_KEY = fixture.apiKey;
  process.env.OPENAI_BASE_URL = fixture.baseURL;
  credentials.resetCredentialCache();
  adapter.resetOpenAIAdapter();
  selfHealing.resetTrinitySelfHealingStateForTests();
  adapter.getOpenAIAdapter({
    apiKey: fixture.apiKey,
    baseURL: fixture.baseURL,
    defaultModel: authorityModel,
    timeout: 2_000,
    maxRetries: 0,
    fetch: fixture.fetch
  });
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  adapter?.resetOpenAIAdapter();
  credentials?.resetCredentialCache();
  selfHealing?.resetTrinitySelfHealingStateForTests();
  await fixture?.close();
  consoleLogSpy?.mockRestore();
  consoleErrorSpy?.mockRestore();
  expect(getMemoryContext).not.toHaveBeenCalled();
  expect(storePattern).not.toHaveBeenCalled();
  expect(processJudgedResponseFeedback).not.toHaveBeenCalled();
  expect(runSelfImproveCycle).not.toHaveBeenCalled();
  expect(recordJobEvent).not.toHaveBeenCalled();
  expect(reserveWorkerAiProviderAttempt).not.toHaveBeenCalled();
});

afterAll(() => {
  process.env = originalEnvironment;
});

function structuredReasoning(tier: 'simple' | 'complex' | 'critical') {
  return JSON.stringify({
    response_mode: 'answer', achievable_subtasks: ['Assess the supplied outline'],
    blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: reasoningDraft,
    ...(tier === 'simple' ? {} : {
      reasoning_steps: ['Consider only the supplied outline.'], assumptions: [], constraints: [],
      tradeoffs: [], alternatives_considered: [],
      chosen_path_justification: 'The outline is sufficient for a bounded assessment.'
    })
  });
}

function enqueuePipeline(tier: 'simple' | 'complex' | 'critical', auditScores = scores, includeFinal = true) {
  fixture.enqueue(
    { kind: 'completion', text: 'Assess only the supplied launch outline.', usage: stageUsage[0] },
    { kind: 'completion', text: structuredReasoning(tier), usage: stageUsage[1] },
    { kind: 'completion', text: JSON.stringify(auditScores), usage: stageUsage[2] }
  );
  if (tier === 'critical') fixture.enqueue({ kind: 'completion', text: 'Keep the assessment limited to supplied facts.' });
  if (includeFinal) fixture.enqueue({ kind: 'completion', text: answer, usage: stageUsage[3] });
}

function responseRequests() {
  return fixture.requests.filter(request => request.method === 'POST' && request.path === '/v1/responses');
}

function startRun(prompt = simplePrompt, options: Parameters<typeof pipeline.runTrinityWritingPipeline>[0]['context']['runOptions'] = {}) {
  const context = execution.createAiExecutionContext({ sourceType: 'route', sourceName: 'trinity-model-policy.fixture' });
  const usage = attemptTokens.createAttemptTokenUsage();
  const result = execution.runWithAiExecutionContext(context, () =>
    attemptTokens.runWithAttemptTokenUsage(usage, () => pipeline.runTrinityWritingPipeline({
      input: {
        prompt, moduleId: 'ARCANOS:CORE', sourceEndpoint: 'trinity-model-policy.fixture',
        requestedAction: 'query', body: { prompt }, executionMode: 'request'
      },
      context: {
        client: adapter.getOpenAIAdapter().getClient(),
        runtimeBudget: runtimeBudget.createRuntimeBudgetWithLimit(20_000, 0),
        runOptions: {
          disableMemoryAccess: true, disableOptionalSideEffects: true,
          strictUserVisibleOutput: true, debugPipeline: true, ...options
        }
      }
    }))
  );
  return { result, usage, context };
}

async function run(prompt = simplePrompt, options: Parameters<typeof pipeline.runTrinityWritingPipeline>[0]['context']['runOptions'] = {}) {
  const pending = startRun(prompt, options);
  const result = await pending.result;
  return { result, usage: pending.usage, summary: execution.summarizeAiExecutionContext(pending.context) };
}

describe('Trinity model policy through the real SDK and loopback HTTP', () => {
  it.each([
    ['simple', simplePrompt], ['complex', complexPrompt]
  ] as const)('completes the actual %s writing facade with central lanes and provider provenance', async (tier, prompt) => {
    enqueuePipeline(tier);
    const { result, usage, summary } = await run(prompt);
    const requests = responseRequests();

    expect(requests.map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel]);
    expect(fixture.requests.every(request => request.authorizationAccepted)).toBe(true);
    expect(requests[0].body).toMatchObject({ reasoning: { effort: 'none' }, max_output_tokens: 500 });
    expect(requests[1].body).toMatchObject({
      reasoning: { effort: 'low' }, max_output_tokens: 8_000,
      text: { format: { type: 'json_schema', strict: true } }
    });
    expect(requests[2].body).toMatchObject({ reasoning: { effort: 'none' } });
    expect(requests[3].body).not.toHaveProperty('reasoning');
    expect(requests[3].body).toMatchObject({ max_output_tokens: 1_000 });
    expect(requests.every(request => Number(request.body?.max_output_tokens) > 0
      && Number(request.body?.max_output_tokens) <= 8_000)).toBe(true);
    expect(requests.every(request => !Object.hasOwn(request.body ?? {}, 'tools'))).toBe(true);

    expect(result.result).toContain(answer);
    expect(result.result).not.toContain(reasoningDraft);
    expect(result).toMatchObject({
      activeModel: authorityModel, module: authorityModel, gpt5Model: 'gpt-6.1-sol', fallbackFlag: false,
      routingStages: ['ARCANOS-INTAKE:gpt-6-luna', 'GPT5-REASONING', 'ARCANOS-FINAL'],
      tierInfo: { tier, escalated: false },
      clearAudit: scores,
      meta: {
        pipeline: 'trinity', bypass: false, classification: 'writing',
        tokens: { prompt_tokens: 17, completion_tokens: 19, total_tokens: 36 },
        provider: { responseStatus: 'completed', finishReason: 'stop', incomplete: false, truncated: false }
      },
      pipelineDebug: {
        intakeOutput: { activeModel: 'gpt-6-luna' },
        reasoningOutput: { model: 'gpt-6.1-sol' }
      }
    });
    expect(summary?.totals).toMatchObject({ promptTokens: 36, completionTokens: 43, totalTokens: 79 });
    expect(summary?.models[authorityModel]).toBe(1);
    expect(summary?.models['gpt-6.1-sol']).toBe(1);
    expect(summary?.operationCounts.responses_create).toBe(4);
    expect(summary?.operationCounts.responses_parse).toBeUndefined();
    expect(usage.totalTokens).toBe(79);
  });

  it('keeps low-CLEAR escalation to one hop with Sol reasoning and the same final authority', async () => {
    const lowScores = { clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0, overall: 0 };
    enqueuePipeline('complex', lowScores, false);
    enqueuePipeline('critical');
    const { result } = await run(complexPrompt);
    const requests = responseRequests();

    expect(requests.map(request => request.model)).toEqual([
      'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna',
      'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.1-sol', authorityModel
    ]);
    expect(requests.filter(request => (request.body?.text as any)?.format?.type === 'json_schema')
      .map(request => (request.body?.reasoning as any)?.effort)).toEqual(['low', 'medium']);
    expect(result.tierInfo).toMatchObject({
      tier: 'critical', originalTier: 'complex', escalated: true, escalationReason: 'low_clear_score'
    });
    expect(result.activeModel).toBe(authorityModel);
    expect(result.fallbackFlag).toBe(false);
    expect(result.result).toContain(answer);
    expect(requests.filter(request => request.model === authorityModel)).toHaveLength(1);
  });

  it('rejects a conflicting final override before intake validation or any native HTTP request', async () => {
    await expect(run(simplePrompt, { directAnswerModelOverride: 'gpt-6.1-sol' }))
      .rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
    expect(fixture.requests).toEqual([]);
  });

  it.each(['', 'gpt-6.1-sol'])('rejects unavailable final authority %j before helper transport', async authority => {
    for (const name of authorityEnvironmentNames) process.env[name] = '';
    process.env.FINETUNED_MODEL_ID = authority;
    await expect(run()).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
    expect(fixture.requests).toEqual([]);
  });

  it.each(['incomplete', 'invalid_schema'] as const)('withholds final generation after native HTTP %s reasoning output', async failure => {
    fixture.enqueue(
      { kind: 'completion', text: 'Assess only the supplied launch outline.' },
      { kind: 'completion', text: failure === 'invalid_schema' ? '{"final_answer":"unvalidated draft"}' : structuredReasoning('simple'),
        status: failure === 'incomplete' ? 'incomplete' : 'completed' }
    );
    await expect(run()).rejects.toThrow(failure === 'incomplete' ? 'incomplete structured output' : 'failed validation');
    expect(responseRequests().map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol']);
  });

  it.each(['gpt-6-luna', null])('rejects structured reasoning whose provider model identity is %s', async model => {
    fixture.enqueue(
      { kind: 'completion', text: 'Assess only the supplied launch outline.', usage: stageUsage[0] },
      { kind: 'completion', model, text: structuredReasoning('simple'), usage: stageUsage[1] },
      { kind: 'completion', text: JSON.stringify(scores) },
      { kind: 'completion', text: answer }
    );
    const pending = startRun();
    await expect(pending.result).rejects.toThrow(/model/);
    expect(responseRequests().map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol']);
    expect(pending.usage.totalTokens).toBe(31);
    const summary = execution.summarizeAiExecutionContext(pending.context);
    expect(summary?.totals).toMatchObject({ promptTokens: 14, completionTokens: 17, totalTokens: 31 });
    expect(summary?.operationCounts.responses_create).toBe(2);
    expect(logAITaskLineage).not.toHaveBeenCalled();
  });

  it('accepts a correctly identified Sol family snapshot through structured reasoning', async () => {
    fixture.enqueue(
      { kind: 'completion', text: 'Assess only the supplied launch outline.', usage: stageUsage[0] },
      { kind: 'completion', model: 'gpt-6.1-sol-2026-10-01', text: structuredReasoning('simple'), usage: stageUsage[1] },
      { kind: 'completion', text: JSON.stringify(scores), usage: stageUsage[2] },
      { kind: 'completion', text: answer, usage: stageUsage[3] }
    );
    const { result, usage } = await run();
    expect(responseRequests().map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel]);
    expect(result.result).toContain(answer);
    expect(result).toMatchObject({ activeModel: authorityModel, gpt5Model: 'gpt-6.1-sol', fallbackFlag: false });
    expect(usage.totalTokens).toBe(79);
  });

  it.each(['gpt-6.1-sol', 'ft:gpt-4.1:synthetic:other-authority', null])(
    'withholds provider output whose final model identity is %s', async model => {
      enqueuePipeline('simple', scores, false);
      fixture.enqueue({ kind: 'completion', model, text: 'Unauthorized final output.' });
      await expect(run()).rejects.toThrow(/model/);
      expect(responseRequests().map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel]);
      expect(logAITaskLineage).not.toHaveBeenCalled();
    }
  );

  it('preserves provider denial at the configured final authority without helper substitution', async () => {
    enqueuePipeline('simple', scores, false);
    fixture.enqueue({ kind: 'error', status: 400, errorCode: 'synthetic_authority_unavailable' });
    await expect(run()).rejects.toThrow(/synthetic/i);
    expect(responseRequests().map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel]);
    expect(logAITaskLineage).not.toHaveBeenCalled();
  });
});
