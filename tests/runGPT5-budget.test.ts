import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createLinkedAbortController = jest.fn();
const getRequestAbortSignal = jest.fn();
const getRequestRemainingMs = jest.fn();
const getSafeRemainingMs = jest.fn();
const isAbortError = jest.fn(() => false);

class RuntimeBudgetExceededError extends Error {
  constructor() {
    super('runtime_budget_exhausted');
    this.name = 'RuntimeBudgetExceededError';
  }
}

class OpenAIAbortError extends Error {
  constructor() {
    super('openai_call_aborted_due_to_budget');
    this.name = 'OpenAIAbortError';
  }
}

jest.unstable_mockModule('@arcanos/runtime', () => ({
  assertBudgetAvailable: jest.fn(),
  createLinkedAbortController,
  getRequestAbortSignal,
  getRequestRemainingMs,
  getSafeRemainingMs,
  isAbortError,
  RuntimeBudgetExceededError,
  OpenAIAbortError
}));

const { runGPT5 } = await import('../packages/arcanos-openai/src/runGPT5.ts');

describe('shared runGPT5 budget handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getRequestAbortSignal.mockReturnValue(undefined);
    getRequestRemainingMs.mockReturnValue(null);
    getSafeRemainingMs.mockReturnValue(42_000);
    createLinkedAbortController.mockReturnValue({
      signal: { aborted: false } as AbortSignal,
      cleanup: jest.fn()
    });
  });

  it('uses the available runtime budget when creating the linked abort scope', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'response-1' });
    const client = { responses: { create } } as any;

    const result = await runGPT5(
      client,
      {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 256
      },
      { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 }
    );

    expect(result).toEqual({ id: 'response-1' });
    expect(createLinkedAbortController).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 42_000,
        abortMessage: 'OpenAI GPT-5 request timed out after 42000ms'
      })
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5',
        max_output_tokens: 256
      }),
      expect.objectContaining({
        signal: createLinkedAbortController.mock.results[0]?.value.signal
      })
    );
  });

  it('routes execution through the provided retry helper when present', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'response-2' });
    const client = { responses: { create } } as any;
    const retry = jest.fn(async (fn: (attempt: number) => Promise<unknown>) => fn(2));

    const result = await runGPT5(
      client,
      { model: 'gpt-5', input: [{ role: 'user', content: 'retry me' }] },
      { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      { retry }
    );

    expect(result).toEqual({ id: 'response-2' });
    expect(retry).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      signal: createLinkedAbortController.mock.results[0]?.value.signal
    }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('translates aborted request execution into OpenAIAbortError', async () => {
    const abortSignal = { aborted: true } as AbortSignal;
    createLinkedAbortController.mockReturnValue({
      signal: abortSignal,
      cleanup: jest.fn()
    });
    isAbortError.mockReturnValue(true);

    const client = {
      responses: {
        create: jest.fn().mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      }
    } as any;

    await expect(
      runGPT5(
        client,
        { model: 'gpt-5', input: [{ role: 'user', content: 'abort me' }] },
        { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 }
      )
    ).rejects.toBeInstanceOf(OpenAIAbortError);
  });
});
