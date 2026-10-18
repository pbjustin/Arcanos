import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createSelfHealingInferenceClient } from '../src/services/selfImprove/selfHealingInferenceClient.js';

const originalEnvironment = process.env;
const authorityModel = 'ft:gpt-4.1:synthetic:self-healing-fixture';
const answer = '{"selectedCandidateIndex":0,"chooseNoAction":false,"reason":"A stalled fixture job needs diagnosis.","safeToExecute":false,"confidence":0.9}';
const forbiddenEffect = jest.fn(async () => { throw new Error('Offline self-healing fixture forbids external effects.'); });
jest.unstable_mockModule('@services/memoryAware.js', () => ({ getMemoryContext: forbiddenEffect, storePattern: forbiddenEffect }));
jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({ processJudgedResponseFeedback: forbiddenEffect }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: forbiddenEffect }));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({ recordJobEvent: forbiddenEffect }));
jest.unstable_mockModule('@core/db/repositories/workerBudgetRepository.js', () => ({
  reserveWorkerAiProviderAttempt: forbiddenEffect, WORKER_BUDGET_NON_JOB_SUBJECT_ID: 'synthetic-non-job'
}));
jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: forbiddenEffect, healWorkerRuntime: forbiddenEffect
}));
jest.unstable_mockModule('@services/systemState.js', () => ({ executeSystemStateRequest: forbiddenEffect }));

let core: typeof import('../src/services/arcanos-core.js');
let adapter: typeof import('../src/core/adapters/openai.adapter.js');
let credentials: typeof import('../src/services/openai/credentialProvider.js');
let execution: typeof import('../src/services/openai/aiExecutionContext.js');
let selfHealing: typeof import('../src/services/selfImprove/selfHealingV2.js');
let circuit: typeof import('../src/services/openai/resilience.js');
const mockFetch = jest.fn<typeof globalThis.fetch>();
let nativeFetchGuard: ReturnType<typeof jest.spyOn>;
let consoleLogSpy: ReturnType<typeof jest.spyOn>;
let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

beforeAll(async () => {
  const environment = { ...originalEnvironment };
  for (const key of [
    'OPENAI_API_KEY', 'RAILWAY_OPENAI_API_KEY', 'OPENAI_KEY', 'API_KEY', 'OPENAI_BASE_URL', 'RAILWAY_OPENAI_BASE_URL',
    'DATABASE_URL', 'RAILWAY_DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
    'REDIS_URL', 'REDIS_HOST', 'REDISHOST', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN',
    'FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'RAILWAY_FINE_TUNED_MODEL_ID',
    'AI_MODEL', 'RAILWAY_AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL', 'RAILWAY_RAILWAY_OPENAI_MODEL'
  ]) environment[key] = '';
  process.env = {
    ...environment, NODE_ENV: 'test', FINETUNED_MODEL_ID: authorityModel,
    OPENAI_API_KEY: 'sk-test-synthetic-self-healing-offline', OPENAI_BASE_URL: 'https://self-healing.invalid/v1',
    RUN_WORKERS: 'false', SELF_IMPROVE_ENABLED: 'false', TRINITY_JUDGED_FEEDBACK_ENABLED: 'false',
    ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS: 'false', ARCANOS_CONTEXT_MODE: 'disabled', AI_TRACE_LOGGING: 'false', LOG_LEVEL: 'error'
  };
  nativeFetchGuard = jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenEffect as typeof globalThis.fetch);
  const actualAuditSafe = await import('../src/services/auditSafe.js');
  jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...actualAuditSafe, logAITaskLineage: jest.fn() }));
  // Keep the real Core, writing facade, stage, resilience, model policy, adapter,
  // installed SDK and accounting. Only fetch and unrelated effects are mocked.
  core = await import('../src/services/arcanos-core.js');
  adapter = await import('../src/core/adapters/openai.adapter.js');
  credentials = await import('../src/services/openai/credentialProvider.js');
  execution = await import('../src/services/openai/aiExecutionContext.js');
  selfHealing = await import('../src/services/selfImprove/selfHealingV2.js');
  circuit = await import('../src/services/openai/resilience.js');
});

beforeEach(() => {
  mockFetch.mockReset();
  credentials.resetCredentialCache();
  adapter.resetOpenAIAdapter();
  selfHealing.resetTrinitySelfHealingStateForTests();
  adapter.getOpenAIAdapter({
    apiKey: 'sk-test-synthetic-self-healing-offline', baseURL: 'https://self-healing.invalid/v1',
    defaultModel: authorityModel, timeout: 2000, maxRetries: 3, fetch: mockFetch
  });
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  adapter.resetOpenAIAdapter();
  credentials.resetCredentialCache();
  selfHealing.resetTrinitySelfHealingStateForTests();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  expect(forbiddenEffect).not.toHaveBeenCalled();
  expect(nativeFetchGuard).not.toHaveBeenCalled();
});

afterAll(() => {
  nativeFetchGuard?.mockRestore();
  process.env = originalEnvironment;
});

function startDiagnosis() {
  const bounded = createSelfHealingInferenceClient(adapter.getOpenAIAdapter().getClient());
  const context = execution.createAiExecutionContext({ sourceType: 'background', sourceName: 'self-healing.offline-fixture' });
  const result = execution.runWithAiExecutionContext(context, () => core.runArcanosCoreQuery({
    client: bounded.client,
    prompt: 'Choose one safe repair recommendation for a stalled job from supplied fixture candidates. Return a JSON object.',
    sourceEndpoint: 'self_heal.predictive.diagnosis', allowTimeoutFallback: false,
    maxOutputTokens: 512,
    runOptions: {
      disableMemoryAccess: true, disableOptionalSideEffects: true,
      answerMode: 'direct', requestedVerbosity: 'minimal', maxWords: 100,
      strictUserVisibleOutput: true, debugPipeline: false,
      directAnswerTokenLimitOverride: 512, directAnswerTokenCapOverride: 512
    }
  }));
  return { bounded, context, result: Promise.resolve(result) };
}

describe('self-healing actual Core and SDK with mocked provider transport', () => {
  it('produces one bounded fine-tuned completion and preserves usage accounting', async () => {
    mockFetch.mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://self-healing.invalid/v1/responses');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: authorityModel, max_output_tokens: 512 });
      expect(body.tools).toBeUndefined();
      return new Response(JSON.stringify({
        id: 'resp_fixture', object: 'response', created_at: 1, model: authorityModel, status: 'completed',
        incomplete_details: null, output_text: answer,
        output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: answer, annotations: [] }] }],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { bounded, context, result } = startDiagnosis();
    const response = await result;
    expect(response.activeModel).toBe(authorityModel);
    expect(response.result).toContain('selectedCandidateIndex');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bounded.getFailure()).toBe(null);
    expect(execution.summarizeAiExecutionContext(context)?.totals).toEqual({
      calls: 1, promptTokens: 11, completionTokens: 7, totalTokens: 18
    });
  });

  it.each([401, 503])('captures HTTP %s through Core without SDK retries or fallback calls', async status => {
    const failuresBefore = circuit.getCircuitBreakerSnapshot().failureCount;
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Synthetic provider rejection.', type: status === 401 ? 'authentication_error' : 'server_error',
        code: status === 401 ? 'invalid_api_key' : 'server_error' }
    }), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'true' } }));
    const { bounded, context, result } = startDiagnosis();
    // Core may preserve a provider rejection or materialize a static fallback;
    // admission completion must consult captured transport failure in either case.
    await result.catch(() => undefined);
    expect(bounded.getFailure()).toMatchObject({ status });
    expect(bounded.isPending()).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(execution.summarizeAiExecutionContext(context)?.totals.calls).toBe(1);
    expect(circuit.getCircuitBreakerSnapshot().failureCount).toBeGreaterThan(failuresBefore);
  });

  it('retains a socket-reset transport failure after a potentially accepted request without retrying', async () => {
    mockFetch.mockImplementation(async () => {
      // A lost response cannot establish whether the provider accepted or billed
      // the request. The SDK wraps this as an APIConnectionError without status.
      throw new TypeError('fetch failed', { cause: new Error('socket reset after request accepted') });
    });
    const { bounded, context, result } = startDiagnosis();
    await result.catch(() => undefined);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bounded.wasRequested()).toBe(true);
    expect(bounded.isPending()).toBe(false);
    expect(bounded.getFailure()).toMatchObject({ name: 'Error', message: 'Connection error.' });
    expect(bounded.getFailure()).not.toHaveProperty('status', expect.any(Number));
    expect(execution.summarizeAiExecutionContext(context)?.totals.calls).toBe(1);
  });
});
