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

const { HRCCore } = await import('../src/services/hrc.ts');

describe('HRC core', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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

    await expect(evaluationPromise).resolves.toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: HRC evaluation timed out after 25ms'
    });
    const [, options] = create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { signal?: AbortSignal }
    ];
    expect(options.signal?.aborted).toBe(true);
  });
});
