import { describe, expect, it, jest } from '@jest/globals';

import { dagAgentManager } from '../src/agents/agentManager.js';
import { createOpenAIAdapter, instrumentOpenAIOperation } from '../src/core/adapters/openai.adapter.js';
import { deriveTrinityCapabilityFlags } from '../src/core/logic/trinityHonesty.js';
import { runFinalStage, runIntakeStage, runReasoningStage } from '../src/core/logic/trinityStages.js';
import { createRuntimeBudget } from '../src/platform/resilience/runtimeBudget.js';
import { createAiExecutionContext, runWithAiExecutionContext } from '../src/services/openai/aiExecutionContext.js';
import { createAttemptTokenUsage, runWithAttemptTokenUsage } from '../src/services/openai/attemptTokenUsage.js';
import { runDagNodeJob } from '../src/workers/taskRunners.js';
import type { DagNodeJobInput } from '../src/jobs/jobSchema.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
let nextNode = 0;

async function runAttempt(callback: () => Promise<unknown>) {
  const nodeId = `provider-usage-${++nextNode}`;
  dagAgentManager.registerAgent(nodeId, callback);
  const input: DagNodeJobInput = {
    dagId: nodeId,
    node: { id: nodeId, type: 'agent', dependencies: [], executionKey: nodeId },
    payload: {}, dependencyResults: {}, sharedState: {}, depth: 0, attempt: 0,
    maxRetries: 0, waitingTimeoutMs: 60_000
  };
  return runDagNodeJob(input, {
    runPrompt: async () => { throw new Error('No live provider calls.'); },
    logger,
    artifactStore: {
      writeArtifact: async () => 'usage-fixture-artifact',
      readArtifact: async () => { throw new Error('No dependency artifacts.'); }
    }
  });
}

function providerResponse(usage: unknown, text = 'Synthetic provider response.') {
  return {
    id: 'response-usage-fixture', object: 'response', created_at: 1,
    model: 'gpt-4.1-mini', status: 'completed', usage,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }]
  };
}

function syntheticAdapter(responses: unknown[]) {
  const fetch = jest.fn(async () => new Response(JSON.stringify(responses.shift()), {
    status: 200, headers: { 'content-type': 'application/json' }
  }));
  return { adapter: createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 0, fetch }), fetch };
}

async function observeUsage(usage: unknown) {
  return instrumentOpenAIOperation({
    operation: 'responses_create', model: 'gpt-4.1-mini',
    callback: async () => ({ usage })
  });
}

describe('DAG attempt usage at the production provider boundary', () => {
  it('aggregates real intake, structured reasoning, and final stages without redefining public usage', async () => {
    const structured = JSON.stringify({
      response_mode: 'answer', achievable_subtasks: [], blocked_subtasks: [],
      user_visible_caveats: [], claim_tags: [], final_answer: 'A structured answer.'
    });
    const { adapter, fetch } = syntheticAdapter([
      providerResponse({ input_tokens: 8, output_tokens: 3, total_tokens: 11 }),
      providerResponse({ input_tokens: 80, output_tokens: 9, total_tokens: 89, output_tokens_details: { reasoning_tokens: 4 } }, structured),
      providerResponse({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
    ]);
    const outputControls = {
      requestedVerbosity: 'normal' as const, maxWords: null, answerMode: 'direct' as const,
      debugPipeline: false, strictUserVisibleOutput: true
    };
    const flags = deriveTrinityCapabilityFlags();
    const result = await runAttempt(async () => {
      const client = adapter.getClient();
      const budget = createRuntimeBudget();
      const intake = await runIntakeStage(client, 'gpt-4.1-mini', 'A synthetic request.', '', flags, outputControls, undefined, undefined, budget);
      const reasoning = await runReasoningStage(client, intake.framedRequest, flags, outputControls, 'simple', { effort: 'none' }, budget);
      const final = await runFinalStage(client, '', 'A synthetic request.', reasoning.output, flags, outputControls, reasoning.reasoningHonesty, undefined, undefined, budget);
      expect([intake.usage?.total_tokens, reasoning.usage?.total_tokens, final.usage?.total_tokens]).toEqual([11, 89, 7]);
      return { result: final.output, meta: { tokens: final.usage } };
    });
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBe(107);
    expect(result.output).toMatchObject({ meta: { tokens: { total_tokens: 7 } } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retains raw usage when structured parsing fails after the provider response', async () => {
    const { adapter } = syntheticAdapter([providerResponse({ input_tokens: 80, output_tokens: 9, total_tokens: 89 }, '{bad json')]);
    const result = await runAttempt(async () => adapter.responses.parse({ model: 'gpt-4.1-mini', input: 'Synthetic structured request.' }));
    expect(result.status).toBe('failed');
    expect(result.metrics?.attemptTokenUsage).toBe(89);
  });

  it('counts a successful parsed response once while preserving operation metrics', async () => {
    const { adapter } = syntheticAdapter([providerResponse({ input_tokens: 11, output_tokens: 7, total_tokens: 18 }, '{}')]);
    const context = createAiExecutionContext({ sourceName: 'parsed-usage-fixture' });
    const result = await runWithAiExecutionContext(context, () => runAttempt(async () =>
      adapter.responses.parse({ model: 'gpt-4.1-mini', input: 'Synthetic structured request.' })
    ));
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBe(18);
    expect(context.totals).toEqual({ calls: 1, promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(context.operationCounts).toEqual({ responses_parse: 1 });
  });

  it('retains incomplete-stage consumption when a later fallback succeeds', async () => {
    const { adapter } = syntheticAdapter([
      { ...providerResponse({ input_tokens: 80, output_tokens: 9, total_tokens: 89 }), status: 'incomplete' },
      providerResponse({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
    ]);
    const result = await runAttempt(async () => {
      await adapter.responses.parse({ model: 'gpt-4.1-mini', input: 'Synthetic incomplete request.' }).catch(() => undefined);
      const fallback = await adapter.responses.create({ model: 'gpt-4.1-mini', input: 'Synthetic fallback.' });
      return { result: 'Recovered', meta: { tokens: { total_tokens: fallback.usage?.total_tokens } } };
    });
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBe(96);
  });

  it.each(['usage', 'response', 'error'])('preserves known usage on a structured provider rejection (%s)', async field => {
    const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
    const error = Object.assign(new Error('Synthetic provider rejection.'), {
      ...(field === 'usage' ? { usage } : { [field]: { usage } })
    });
    const result = await runAttempt(async () => instrumentOpenAIOperation({
      operation: 'responses_create', callback: async () => { throw error; }
    }));
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe(error.message);
    expect(result.metrics?.attemptTokenUsage).toBe(18);
  });

  it('retains usage from the SDK rejection inside responses.parse', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({
      error: { message: 'Synthetic upstream error.', type: 'api_error', usage: { total_tokens: 18 } }
    }), { status: 500, headers: { 'content-type': 'application/json' } }));
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 0, fetch });
    const result = await runAttempt(async () => adapter.responses.parse({ model: 'gpt-4.1-mini', input: 'Synthetic request.' }));
    expect(result.status).toBe('failed');
    expect(result.metrics?.attemptTokenUsage).toBe(18);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('includes known error-response consumption discarded by an internal SDK retry', async () => {
    let calls = 0;
    const fetch = jest.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: 'Synthetic retry.', type: 'api_error', usage: { total_tokens: 18 } } }), {
            status: 500, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' }
          })
        : new Response(JSON.stringify(providerResponse({ total_tokens: 7 })), {
            status: 200, headers: { 'content-type': 'application/json' }
          });
    });
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 1, fetch });
    const result = await runAttempt(async () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'Synthetic retry request.' }));
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBe(25);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('charges two failed SDK transports once each, including the final error', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({
      error: { message: 'Synthetic retry.', type: 'api_error', usage: { total_tokens: 18 } }
    }), { status: 500, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } }));
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 1, fetch });
    const result = await runAttempt(async () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'Synthetic retry request.' }));
    expect(result.status).toBe('failed');
    expect(result.metrics?.attemptTokenUsage).toBe(36);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps simultaneous SDK operation error observations independent inside one attempt', async () => {
    const fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: string };
      const tokens = request.input === 'first' ? 18 : 27;
      return new Response(JSON.stringify({ error: { message: 'Synthetic parallel error.', type: 'api_error', usage: { total_tokens: tokens } } }), {
        status: 500, headers: { 'content-type': 'application/json' }
      });
    });
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 0, fetch });
    const result = await runAttempt(async () => {
      await Promise.allSettled([
        adapter.responses.create({ model: 'gpt-4.1-mini', input: 'first' }),
        adapter.responses.create({ model: 'gpt-4.1-mini', input: 'second' })
      ]);
      return {};
    });
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBe(45);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'oversized', 'declared-oversized'])('keeps unavailable intermediate SDK error usage unknown (%s)', async kind => {
    let calls = 0;
    const fetch = jest.fn(async () => {
      if (++calls > 1) {
        return new Response(JSON.stringify(providerResponse({ total_tokens: 7 })), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = JSON.stringify({
        error: { message: 'Synthetic retry.', type: 'api_error', ...(kind === 'missing' ? {} : { usage: { total_tokens: 18 } }) },
        ...(kind === 'missing' ? {} : { padding: 'x'.repeat(70 * 1024) })
      });
      return new Response(body, { status: 500, headers: {
        'content-type': 'application/json', 'retry-after-ms': '1',
        ...(kind === 'declared-oversized' ? { 'content-length': String(body.length) } : {})
      } });
    });
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 1, fetch });
    const result = await runAttempt(async () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'Synthetic retry request.' }));
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled SDK error-body observation and continues the existing retry', async () => {
    jest.useFakeTimers();
    try {
      const cancel = jest.fn();
      let calls = 0;
      const fetch = jest.fn(async () => ++calls === 1
        ? new Response(new ReadableStream({ cancel }), { status: 500, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } })
        : new Response(JSON.stringify(providerResponse({ total_tokens: 7 })), { status: 200, headers: { 'content-type': 'application/json' } }));
      const adapter = createOpenAIAdapter({ apiKey: 'test-key', maxRetries: 1, fetch });
      const pending = runAttempt(async () => adapter.responses.create({ model: 'gpt-4.1-mini', input: 'Synthetic retry request.' }));
      await jest.advanceTimersByTimeAsync(251);
      const result = await pending;
      expect(result.status).toBe('success');
      expect(result.metrics?.attemptTokenUsage).toBe(7);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps late provider completions from changing a terminal attempt or the next attempt', async () => {
    let complete!: () => void;
    let late!: Promise<unknown>;
    const firstUsage = createAttemptTokenUsage();
    await expect(runWithAttemptTokenUsage(firstUsage, async () => {
      await observeUsage({ total_tokens: 11 });
      late = instrumentOpenAIOperation({ operation: 'responses_create', callback: async () => {
        await new Promise<void>(resolve => { complete = resolve; });
        return { usage: { total_tokens: 18 } };
      } });
      throw new Error('Synthetic terminal abort.');
    })).rejects.toThrow('Synthetic terminal abort.');
    const next = await runAttempt(async () => {
      complete();
      await late;
      await observeUsage({ total_tokens: 7 });
      return {};
    });
    expect(firstUsage.totalTokens).toBe(11);
    expect(firstUsage.closed).toBe(true);
    expect(next.metrics?.attemptTokenUsage).toBe(7);
  });

  it('does not invent consumption on a provider rejection without usage', async () => {
    const result = await runAttempt(async () => instrumentOpenAIOperation({
      operation: 'responses_create', callback: async () => { throw new Error('Synthetic transport failure.'); }
    }));
    expect(result.status).toBe('failed');
    expect(result.metrics?.attemptTokenUsage).toBeUndefined();
  });

  it('does not count multiple serialized copies of one rejected response as separate calls', async () => {
    const error = Object.assign(new Error('Synthetic provider rejection.'), {
      usage: { total_tokens: 18 }, response: { usage: { total_tokens: 18 } }, error: { usage: { total_tokens: 18 } }
    });
    const result = await runAttempt(async () => instrumentOpenAIOperation({
      operation: 'responses_create', callback: async () => { throw error; }
    }));
    expect(result.metrics?.attemptTokenUsage).toBe(18);
  });

  it('keeps overlapping attempts isolated from each other and cumulative job totals', async () => {
    let releaseFirst!: () => void;
    let firstObserved!: () => void;
    const firstReady = new Promise<void>(resolve => { firstObserved = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const context = createAiExecutionContext({ sourceName: 'usage-fixture' });
    await runWithAiExecutionContext(context, async () => {
      await observeUsage({ total_tokens: 500 });
      const first = runAttempt(async () => {
        await observeUsage({ total_tokens: 11 });
        firstObserved();
        await release;
        await observeUsage({ total_tokens: 7 });
        return {};
      });
      await firstReady;
      const second = await runAttempt(async () => {
        await observeUsage({ total_tokens: 89 });
        return {};
      });
      releaseFirst();
      expect((await first).metrics?.attemptTokenUsage).toBe(18);
      expect(second.metrics?.attemptTokenUsage).toBe(89);
    });
    expect(context.totals.totalTokens).toBe(607);
  });

  it.each([undefined, null, {}])('keeps unavailable provider usage unknown (%j)', async usage => {
    const result = await runAttempt(async () => { await observeUsage(usage); return {}; });
    expect(result.status).toBe('success');
    expect(result.metrics?.attemptTokenUsage).toBeUndefined();
  });

  it('preserves an explicit provider zero', async () => {
    const result = await runAttempt(async () => { await observeUsage({ total_tokens: 0 }); return {}; });
    expect(result.metrics?.attemptTokenUsage).toBe(0);
  });

  it.each([NaN, Infinity, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])('rejects invalid provider totals without losing earlier consumption (%s)', async total_tokens => {
    const result = await runAttempt(async () => {
      await observeUsage({ total_tokens: 11 });
      await observeUsage({ total_tokens }).catch(() => undefined);
      return {};
    });
    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.metrics?.attemptTokenUsage).toBe(11);
  });

  it('rejects an aggregate overflow and retains the prior representable usage', async () => {
    const result = await runAttempt(async () => {
      await observeUsage({ total_tokens: Number.MAX_SAFE_INTEGER });
      await observeUsage({ total_tokens: 1 }).catch(() => undefined);
      return {};
    });
    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.metrics?.attemptTokenUsage).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps invalid accounting terminal when a fallback later rejects for another reason', async () => {
    const result = await runAttempt(async () => {
      await observeUsage({ total_tokens: 11 });
      await observeUsage({ total_tokens: -1 }).catch(() => undefined);
      throw new Error('A subsequent fallback also failed.');
    });
    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.metrics?.attemptTokenUsage).toBe(11);
  });

  it.each([
    [{ input_tokens: 11, output_tokens: 7 }, 18],
    [{ prompt_tokens: 11, completion_tokens: 7 }, 18],
    [{ input_tokens: 11 }, undefined],
    [{ completion_tokens: 7 }, undefined]
  ])('reads only complete component totals when total_tokens is unavailable (%j)', async (usage, expected) => {
    const result = await runAttempt(async () => { await observeUsage(usage); return {}; });
    expect(result.metrics?.attemptTokenUsage).toBe(expected);
  });
});
