import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as runtime from '@arcanos/runtime';
import { normalizeOpenAIResponseSemantics } from '@arcanos/openai/responses';
import { createOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { runStructuredReasoning } from '../src/services/openai/structuredReasoning.js';
import { createSingleChatCompletion } from '../src/services/openai/chatFallbacks.js';
import { createAiExecutionContext, runWithAiExecutionContext } from '../src/services/openai/aiExecutionContext.js';
import { getTokenParameter } from '../src/shared/tokenParameterHelper.js';
import { normalizeOpenAIModelReasoningEffort, resolveOpenAIModelCapabilities } from '../src/shared/gpt/trinityReasoningPolicy.js';
import { COMPARISON_LIMITS, parseComparisonArguments, runModelLaneComparison } from '../scripts/compare-trinity-model-lanes.mjs';

const structured = { reasoning_steps: ['Add the supplied counts'], assumptions: [], constraints: [], tradeoffs: [],
  alternatives_considered: [], chosen_path_justification: 'The counts are supplied by the fixture.', response_mode: 'answer',
  achievable_subtasks: ['count'], blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: '19 tokens.' };
const executeOptions = { execute: true, confirmNonProduction: true, evaluationTarget: 'https://api.openai.com/v1' };
const createRuntime = (fetch: typeof globalThis.fetch) => ({ ...runtime, createOpenAIAdapter, runStructuredReasoning,
  createSingleChatCompletion, createAiExecutionContext, runWithAiExecutionContext, getTokenParameter,
  normalizeOpenAIResponseSemantics, normalizeOpenAIModelReasoningEffort, resolveOpenAIModelCapabilities, fetch,
  getEnv: (key: string) => ({ NODE_ENV: 'test', OPENAI_API_KEY: 'mock-synthetic-evaluation-key', DISABLE_EXTERNAL_CALLS: 'false' }[key]) });
const providerResponse = (payload: { model: string }, body = structured, incomplete = false) => new Response(JSON.stringify({
  id: 'synthetic-comparison', model: payload.model, status: incomplete ? 'incomplete' : 'completed',
  ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text:
    payload.model === 'gpt-5.6-terra' || payload.model === 'gpt-6.1-sol' ? JSON.stringify(body) : 'Synthetic task/answer.' }] }],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('bounded synthetic model-lane comparison preparation', () => {
  afterEach(() => jest.useRealTimers());

  it('defaults to a zero-call dry plan with unmeasured metrics and only hashes/counts for inputs', async () => {
    const create = jest.fn(() => { throw new Error('Provider creation is forbidden in dry mode'); });
    const report = await runModelLaneComparison({ runtime: { createOpenAIAdapter: create } });
    expect(create).not.toHaveBeenCalled();
    expect(report).toMatchObject({ execution: 'dry_run', syntheticOnly: true, summary: { attempted: 0, schemaValidRate: null, timeoutRate: null } });
    expect(report.results).toHaveLength(6);
    expect(report.results.every(result => result.status === 'not_run' && result.latencyMs === null && result.clearOutcome === null)).toBe(true);
    expect(report.results.every(result => /^[a-f0-9]{64}$/.test(result.fixtureHash))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('fictional crate');
  });

  it('rejects arbitrary inputs and conflicting execution arguments', () => {
    expect(parseComparisonArguments([])).toEqual({});
    expect(() => parseComparisonArguments(['--input', 'private-data.json'])).toThrow('UNSUPPORTED_ARGUMENT');
    expect(() => parseComparisonArguments(['--execute', '--dry-run'])).toThrow('CONFLICTING_EXECUTION_MODE');
    expect(parseComparisonArguments(['--execute', '--confirm-non-production', '--evaluation-target', executeOptions.evaluationTarget]))
      .toEqual(executeOptions);
  });

  it('requires explicit non-production confirmation and the exact evaluation target before runtime loading', async () => {
    await expect(runModelLaneComparison({ execute: true })).rejects.toThrow('EXPLICIT_NON_PRODUCTION_TARGET_REQUIRED');
    await expect(runModelLaneComparison({ ...executeOptions, evaluationTarget: 'https://private.example.com/v1' }))
      .rejects.toThrow('EXPLICIT_NON_PRODUCTION_TARGET_REQUIRED');
  });

  it.each(['NODE_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_ID', 'DISABLE_EXTERNAL_CALLS'])
    ('rejects forbidden execution context %s before creating an adapter', async key => {
      const create = jest.fn();
      const value = key === 'RAILWAY_ENVIRONMENT_ID' ? 'synthetic-environment-id' : key === 'DISABLE_EXTERNAL_CALLS' ? 'true' : 'production';
      await expect(runModelLaneComparison({ ...executeOptions, runtime: {
        getEnv: (candidate: string) => candidate === key ? value : undefined, createOpenAIAdapter: create
      } })).rejects.toThrow('EVALUATION_ENVIRONMENT_NOT_APPROVED');
      expect(create).not.toHaveBeenCalled();
    });

  it('runs exactly six synthetic attempts through the real adapter and structured validator with safe metrics', async () => {
    const fetch = jest.fn(async (_url, init?: RequestInit) => providerResponse(JSON.parse(String(init?.body))));
    const report = await runModelLaneComparison({ ...executeOptions, runtime: createRuntime(fetch) });
    expect(fetch).toHaveBeenCalledTimes(COMPARISON_LIMITS.maxCalls);
    expect(report.summary).toMatchObject({ attempted: 6, completed: 6, failed: 0, schemaValidRate: 1, timeoutRate: 0,
      incompleteRate: 0, truncatedRate: 0, fallbackRate: null, clearAcceptanceRate: null });
    expect(report.results.every(result => result.promptTokens === 100 && result.outputTokens === 50 && result.totalTokens === 150)).toBe(true);
    const payloads = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(payloads.map(payload => payload.model)).toEqual(['gpt-5.6-terra', 'gpt-6.1-sol', 'gpt-4.1-mini', 'gpt-6-luna', 'gpt-4.1', 'gpt-6-luna']);
    expect(payloads.map(payload => payload.max_output_tokens)).toEqual([2_048, 2_048, 500, 500, 1_024, 1_024]);
    expect(payloads.every(payload => payload.store === false && payload.tools === undefined)).toBe(true);
    expect(payloads.slice(0, 2).every(payload => payload.text.format.type === 'json_schema')).toBe(true);
    expect(payloads[3].reasoning).toEqual({ effort: 'none' });
    expect(payloads[5].reasoning).toEqual({ effort: 'none' });
    expect(JSON.stringify(report)).not.toMatch(/mock-synthetic-evaluation-key|Synthetic task\/answer|Add the supplied counts/);
  });

  it('records schema-invalid and incomplete fixture outcomes without retry, fallback or repair', async () => {
    let calls = 0;
    const fetch = jest.fn(async (_url, init?: RequestInit) => {
      calls += 1;
      return providerResponse(JSON.parse(String(init?.body)), calls <= 2 ? { final_answer: 'missing required fields' } as never : structured, calls === 3);
    });
    const report = await runModelLaneComparison({ ...executeOptions, runtime: createRuntime(fetch) });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(report.summary).toMatchObject({ attempted: 6, completed: 3, failed: 3, schemaValidRate: 0, incompleteRate: 1 / 6, truncatedRate: 1 / 6 });
    expect(report.results.slice(0, 2).every(result => result.schemaValid === false && result.status === 'failed')).toBe(true);
    expect(report.results[2]).toMatchObject({ status: 'failed', incomplete: true, truncated: true, failure: 'INCOMPLETE_OUTPUT' });
  });

  it('aborts a pending fixture at the four-second attempt budget and continues without retrying it', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetch = jest.fn((_url, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(providerResponse(JSON.parse(String(init?.body))));
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('synthetic cancellation'), { name: 'AbortError' }));
      }, { once: true }));
    });
    const pending = runModelLaneComparison({ ...executeOptions, runtime: createRuntime(fetch) });
    await jest.advanceTimersByTimeAsync(4_001);
    const report = await pending;
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(report.results[0]).toMatchObject({ status: 'failed', timeout: true, failure: 'TIMEOUT', latencyMs: 4_000 });
    expect(report.summary.timeoutRate).toBe(1 / 6);
  });

  it('stops new attempts when the aggregate runtime budget is exhausted', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('synthetic cancellation'),
        { name: 'AbortError' })), { once: true });
    }));
    const pending = runModelLaneComparison({ ...executeOptions, runtime: { ...createRuntime(fetch),
      createRuntimeBudgetWithLimit: () => runtime.createRuntimeBudgetWithLimit(1_500, 0)
    } });
    await jest.advanceTimersByTimeAsync(1_501);
    const report = await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ aggregateBudgetExhausted: true, summary: { attempted: 1, failed: 1 } });
    expect(report.results.slice(1).every(result => result.status === 'budget_exhausted' && !result.attempted)).toBe(true);
  });
});
