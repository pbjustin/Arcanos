import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getOpenAIClientOrAdapter = jest.fn();
const getDefaultModel = jest.fn(() => 'gpt-4.1-mini');
const getEnv = jest.fn(() => undefined);
const getEnvNumber = jest.fn(() => undefined);

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel,
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv,
  getEnvNumber,
}));

const { HRCCore, isHRCResultCacheable } = await import('../src/services/hrc.ts');
const { evaluateWithHRC } = await import('../src/services/hrcWrapper.ts');
const { queryCache } = await import('../src/platform/resilience/cache.ts');
const { createAbortError, runWithRequestAbortContext } = await import('@arcanos/runtime');

beforeEach(() => {
  jest.clearAllMocks();
  queryCache.clear();
});

afterEach(() => {
  queryCache.clear();
  jest.useRealTimers();
});

describe('HRC core', () => {
  it('evaluates HRC output through the shared structured response helper', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-4.1-mini',
      status: 'completed',
      output_text: '{"fidelity":"0.9","resilience":0.7,"verdict":"stable"}',
      output: [],
    });
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    const core = new HRCCore();
    const result = await core.evaluate('hello');

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      fidelity: 0.9,
      resilience: 0.7,
      verdict: 'stable',
    });
    expect(isHRCResultCacheable(result)).toBe(true);
  });

  it('bounds a caller-scoped HRC evaluation and aborts the provider request', async () => {
    jest.useFakeTimers();
    const create = jest.fn().mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
        const signal = options?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    );
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    const core = new HRCCore();
    const evaluationPromise = core.evaluate('hello', { timeoutMs: 25 });

    await jest.advanceTimersByTimeAsync(30);

    const result = await evaluationPromise;

    expect(result).toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: HRC evaluation timed out after 25ms'
    });
    expect(isHRCResultCacheable(result)).toBe(false);
    const [, options] = create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { signal?: AbortSignal }
    ];
    expect(options.signal?.aborted).toBe(true);
  });
});

describe('HRC wrapper cache', () => {
  it('does not cache a caller-scoped timeout fallback and caches the successful retry', async () => {
    jest.useFakeTimers();
    const successResponse = {
      model: 'gpt-4.1-mini',
      status: 'completed',
      output_text: '{"fidelity":0.8,"resilience":0.6,"verdict":"retry succeeded"}',
      output: [],
    };
    const create = jest.fn()
      .mockImplementationOnce(
        (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
          const signal = options?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      )
      .mockResolvedValueOnce(successResponse);
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    const timedOutEvaluation = evaluateWithHRC('caller-timeout-cache-isolation', {
      timeoutMs: 25
    });
    await jest.advanceTimersByTimeAsync(30);

    await expect(timedOutEvaluation).resolves.toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: HRC evaluation timed out after 25ms'
    });
    await expect(evaluateWithHRC('caller-timeout-cache-isolation')).resolves.toEqual({
      fidelity: 0.8,
      resilience: 0.6,
      verdict: 'retry succeeded'
    });
    await expect(
      evaluateWithHRC('caller-timeout-cache-isolation', { timeoutMs: 1 })
    ).resolves.toEqual({
      fidelity: 0.8,
      resilience: 0.6,
      verdict: 'retry succeeded'
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not cache an ambient-request cancellation and retries outside that scope', async () => {
    let notifyProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      notifyProviderStarted = resolve;
    });
    const create = jest.fn()
      .mockImplementationOnce(
        (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
          const signal = options?.signal;
          const rejectWithAbort = () => reject(signal?.reason);
          if (signal?.aborted) {
            rejectWithAbort();
          } else {
            signal?.addEventListener('abort', rejectWithAbort, { once: true });
          }
          notifyProviderStarted?.();
        })
      )
      .mockResolvedValueOnce({
        model: 'gpt-4.1-mini',
        status: 'completed',
        output_text: '{"fidelity":0.7,"resilience":0.5,"verdict":"ambient retry succeeded"}',
        output: [],
      });
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });
    const controller = new AbortController();

    const cancelledEvaluation = runWithRequestAbortContext({
      controller,
      signal: controller.signal,
      deadlineAt: Date.now() + 1_000,
      timeoutMs: 1_000
    }, () => evaluateWithHRC('ambient-cancellation-cache-isolation'));
    await providerStarted;
    controller.abort(createAbortError('ambient HRC evaluation cancelled'));

    await expect(cancelledEvaluation).resolves.toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: ambient HRC evaluation cancelled'
    });
    await expect(evaluateWithHRC('ambient-cancellation-cache-isolation')).resolves.toEqual({
      fidelity: 0.7,
      resilience: 0.5,
      verdict: 'ambient retry succeeded'
    });
    await expect(evaluateWithHRC('ambient-cancellation-cache-isolation')).resolves.toEqual({
      fidelity: 0.7,
      resilience: 0.5,
      verdict: 'ambient retry succeeded'
    });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
