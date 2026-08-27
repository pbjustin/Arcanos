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
    const usage = {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 20
    };
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":"ok"}',
      output: [],
      usage
    });
    const client = { responses: { create } } as any;
    const onUsage = jest.fn();

    const result = await runStructuredReasoning(client, {
      model: 'gpt-5',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      reasoningEffort: 'low',
      maxOutputTokens: 8_000,
      onUsage
    });

    expect(result).toEqual({ answer: 'ok' });
    expect(createLinkedAbortController).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 42_000,
        abortMessage: 'Structured reasoning timed out after 42000ms'
      })
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: { effort: 'low' },
        max_output_tokens: 8_000
      }),
      expect.anything()
    );
    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it('rejects an invalid structured reasoning output cap before calling the SDK', async () => {
    const create = jest.fn();
    const beforeCall = jest.fn();
    const client = { responses: { create } } as any;

    await expect(runStructuredReasoning(client, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      maxOutputTokens: 0,
      beforeCall
    })).rejects.toThrow('Structured reasoning maxOutputTokens must be a positive integer.');

    expect(create).not.toHaveBeenCalled();
    expect(beforeCall).not.toHaveBeenCalled();
  });

  it('rejects a fractional structured reasoning output cap before calling the SDK', async () => {
    const create = jest.fn();
    const beforeCall = jest.fn();
    const client = { responses: { create } } as any;

    await expect(runStructuredReasoning(client, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      maxOutputTokens: 0.5,
      beforeCall
    })).rejects.toThrow('Structured reasoning maxOutputTokens must be a positive integer.');

    expect(create).not.toHaveBeenCalled();
    expect(beforeCall).not.toHaveBeenCalled();
  });

  it('rejects positive non-integer structured reasoning output caps', async () => {
    const create = jest.fn();
    const beforeCall = jest.fn();
    const client = { responses: { create } } as any;

    await expect(runStructuredReasoning(client, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      maxOutputTokens: 1.5,
      beforeCall
    })).rejects.toThrow('Structured reasoning maxOutputTokens must be a positive integer.');

    expect(create).not.toHaveBeenCalled();
    expect(beforeCall).not.toHaveBeenCalled();
  });

  it('reports usage before preserving an incomplete response failure', async () => {
    const usage = {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 8_000,
      output_tokens_details: { reasoning_tokens: 7_900 },
      total_tokens: 8_050
    };
    const create = jest.fn().mockResolvedValue({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      usage
    });
    const onUsage = jest.fn();

    await expect(runStructuredReasoning({ responses: { create } } as any, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      maxOutputTokens: 8_000,
      onUsage
    })).rejects.toThrow('structured reasoning returned incomplete structured output.');

    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('reports usage while preserving a refusal failure', async () => {
    const usage = { input_tokens: 3, output_tokens: 1, total_tokens: 4 };
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot comply' }] }],
      usage
    });
    const onUsage = jest.fn();

    await expect(runStructuredReasoning({ responses: { create } } as any, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      onUsage
    })).rejects.toThrow('Model refusal: cannot comply');

    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('reports usage while preserving a schema-validation failure', async () => {
    const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":42}',
      output: [],
      usage
    });
    const onUsage = jest.fn(() => {
      throw new Error('observer failed');
    });

    await expect(runStructuredReasoning({ responses: { create } } as any, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      onUsage
    })).rejects.toThrow('structured reasoning returned structured output that failed validation.');

    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('reports usage while preserving malformed JSON translation', async () => {
    const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":',
      output: [],
      usage
    });
    const onUsage = jest.fn();

    await expect(runStructuredReasoning({ responses: { create } } as any, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      onUsage
    })).rejects.toThrow('Model returned malformed structured reasoning JSON');

    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('does not let a usage observer failure replace a successful model result', async () => {
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":"ok"}',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    await expect(runStructuredReasoning({ responses: { create } } as any, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      onUsage: () => {
        throw new Error('observer failed');
      }
    })).resolves.toEqual({ answer: 'ok' });
  });

  it('absorbs a rejected asynchronous usage observer without changing the result', async () => {
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":"ok"}',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });
    const onUsage = jest.fn(async () => {
      throw new Error('async observer failed');
    });

    await expect(runStructuredReasoning({ responses: { create } } as any, {
      model: 'gpt-5.6-terra',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      onUsage
    })).resolves.toEqual({ answer: 'ok' });

    await Promise.resolve();
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('still honors an explicit smaller timeout override', async () => {
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":"ok"}',
      output: []
    });
    const client = { responses: { create } } as any;

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

  it('accepts native Promise responses without SDK parse helpers', async () => {
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":"ok"}',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"answer":"ok"}' }]
        }
      ]
    });
    const client = {
      responses: {
        create,
        parse: jest.fn(() => {
          throw new Error('responses.parse should not be used');
        })
      }
    } as any;

    const result = await runStructuredReasoning(client, {
      model: 'gpt-5',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string'
    });

    expect(result).toEqual({ answer: 'ok' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the structured response JSON is malformed', async () => {
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"answer":' }]
        }
      ]
    });
    const client = { responses: { create } } as any;

    await expect(runStructuredReasoning(client, {
      model: 'gpt-5',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string'
    })).rejects.toThrow('Model returned malformed structured reasoning JSON');
  });

  it('treats pre-call abort hooks as OpenAI aborts and skips the SDK request', async () => {
    const create = jest.fn().mockResolvedValue({
      status: 'completed',
      output_text: '{"answer":"ok"}',
      output: []
    });
    const client = { responses: { create } } as any;
    isAbortError.mockImplementation((error: unknown) =>
      error instanceof Error && error.message === 'Request was aborted.'
    );

    await expect(runStructuredReasoning(client, {
      model: 'gpt-5',
      prompt: 'test prompt',
      budget: { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      schema: { type: 'json_schema', name: 'test', schema: {} },
      validate: (value: unknown): value is { answer: string } =>
        typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string',
      beforeCall: async () => {
        throw new Error('Request was aborted.');
      }
    })).rejects.toMatchObject({
      name: 'OpenAIAbortError',
      message: 'openai_call_aborted_due_to_budget'
    });

    expect(create).not.toHaveBeenCalled();
  });
});
