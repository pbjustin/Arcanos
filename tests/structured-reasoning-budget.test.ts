import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createLinkedAbortController = jest.fn();
const getRequestAbortSignal = jest.fn();
const getRequestRemainingMs = jest.fn();
const isAbortError = jest.fn(() => false);
const getSafeRemainingMs = jest.fn();

jest.unstable_mockModule('@arcanos/runtime', () => ({
  createLinkedAbortController,
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  getSafeRemainingMs,
  RuntimeBudgetExceededError: class RuntimeBudgetExceededError extends Error {
    constructor() {
      super('runtime_budget_exhausted');
      this.name = 'RuntimeBudgetExceededError';
    }
  },
  OpenAIAbortError: class OpenAIAbortError extends Error {
    constructor() {
      super('openai_call_aborted_due_to_budget');
      this.name = 'OpenAIAbortError';
    }
  }
}));

const { runStructuredReasoning } = await import('../packages/arcanos-openai/src/structuredReasoning.ts');

describe('runStructuredReasoning budget handling', () => {
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses the available runtime budget when no explicit timeout is provided', async () => {
    const parse = jest.fn().mockResolvedValue({
      output_parsed: { answer: 'ok' },
      output: []
    });
    const client = { responses: { parse } } as any;

    const result = await runStructuredReasoning(client, {
      model: 'gpt-5',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string'
    });

    expect(result).toEqual({ answer: 'ok' });
    expect(createLinkedAbortController).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 42_000,
        abortMessage: 'Structured reasoning timed out after 42000ms'
      })
    );
  });

  it('still honors an explicit smaller timeout override', async () => {
    const parse = jest.fn().mockResolvedValue({
      output_parsed: { answer: 'ok' },
      output: []
    });
    const client = { responses: { parse } } as any;

    await runStructuredReasoning(client, {
      model: 'gpt-5',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      timeoutMs: 9_000
    });

    expect(createLinkedAbortController).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 9_000,
        abortMessage: 'Structured reasoning timed out after 9000ms'
      })
    );
  });
});
