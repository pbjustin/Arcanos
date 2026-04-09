import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runStructuredReasoningGenericMock = jest.fn();

jest.unstable_mockModule('@arcanos/openai/structuredReasoning', () => ({
  runStructuredReasoning: runStructuredReasoningGenericMock
}));

const { runStructuredReasoning } = await import('../src/services/openai/structuredReasoning.ts');

describe('preview reasoning chaos hook', () => {
  beforeEach(() => {
    runStructuredReasoningGenericMock.mockReset();
  });

  it('injects a one-shot timeout-shaped failure without rewriting it into a budget abort', async () => {
    runStructuredReasoningGenericMock.mockImplementation(async (_client: unknown, options: Record<string, unknown>) => {
      const beforeCall = options.beforeCall as ((signal: AbortSignal) => Promise<void>) | undefined;
      if (beforeCall) {
        await beforeCall(new AbortController().signal);
      }
      return {
        response_mode: 'answer',
        achievable_subtasks: [],
        blocked_subtasks: [],
        user_visible_caveats: [],
        claim_tags: [],
        final_answer: 'ok'
      };
    });

    await expect(runStructuredReasoning(
      {} as never,
      'gpt-5',
      'test prompt',
      { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      5_000,
      {
        schemaVariant: 'compact',
        previewChaosHook: {
          kind: 'reasoning_timeout_once',
          hookId: 'preview-chaos-test-timeout',
          delayBeforeCallMs: 1,
          timeoutMs: 75
        }
      }
    )).rejects.toThrow('Structured reasoning timed out after 75ms');

    expect(runStructuredReasoningGenericMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 5_000,
        beforeCall: expect.any(Function)
      })
    );
  });

  it('consumes the timeout chaos token so retries fall back to normal execution', async () => {
    runStructuredReasoningGenericMock.mockImplementation(async (_client: unknown, options: Record<string, unknown>) => {
      const beforeCall = options.beforeCall as ((signal: AbortSignal) => Promise<void>) | undefined;
      if (beforeCall) {
        await beforeCall(new AbortController().signal);
      }
      return {
        response_mode: 'answer',
        achievable_subtasks: [],
        blocked_subtasks: [],
        user_visible_caveats: [],
        claim_tags: [],
        final_answer: 'ok'
      };
    });

    const previewChaosHook = {
      kind: 'reasoning_timeout_once' as const,
      hookId: 'preview-chaos-test-retry',
      delayBeforeCallMs: 1,
      timeoutMs: 50
    };

    await expect(runStructuredReasoning(
      {} as never,
      'gpt-5',
      'test prompt',
      { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      5_000,
      {
        schemaVariant: 'compact',
        previewChaosHook
      }
    )).rejects.toThrow('Structured reasoning timed out after 50ms');

    const recovered = await runStructuredReasoning(
      {} as never,
      'gpt-5',
      'test prompt',
      { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 },
      5_000,
      {
        schemaVariant: 'compact',
        previewChaosHook
      }
    );

    expect(recovered).toEqual({
      response_mode: 'answer',
      achievable_subtasks: [],
      blocked_subtasks: [],
      user_visible_caveats: [],
      claim_tags: [],
      final_answer: 'ok'
    });
    expect(runStructuredReasoningGenericMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 5_000
      })
    );
    const secondCallOptions = runStructuredReasoningGenericMock.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(secondCallOptions.beforeCall).toBeUndefined();
  });
});
