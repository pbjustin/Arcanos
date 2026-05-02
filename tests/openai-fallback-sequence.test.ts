import { afterEach, describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  createChatCompletionWithFallback,
  createSingleChatCompletion,
  getDefaultModel,
  getGPT5Model,
  getFallbackModel
} from '../src/services/openai.js';
import { runWithRequestAbortTimeout } from '@arcanos/runtime';

describe('createChatCompletionWithFallback', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('attempts models in the expected fallback order', async () => {
    const primaryModel = getDefaultModel();
    const gpt5Model = getGPT5Model();
    const finalModel = getFallbackModel();

    const createSpy = jest
      .fn()
      .mockRejectedValueOnce(new Error('primary failure'))
      .mockRejectedValueOnce(new Error('retry failure'))
      .mockRejectedValueOnce(new Error('gpt5 failure'))
      .mockResolvedValueOnce({ id: 'final', model: finalModel, output_text: '' });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const result = await createChatCompletionWithFallback(client, { messages: [] });

    expect(createSpy).toHaveBeenCalledTimes(4);
    expect(createSpy.mock.calls[0][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[1][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[2][0].model).toBe(gpt5Model);
    expect(createSpy.mock.calls[3][0].model).toBe(finalModel);
    expect(result.activeModel).toBe(finalModel);
    expect(result.fallbackFlag).toBe(true);
  });

  it('does not return incomplete provider output as a successful single completion', async () => {
    const createSpy = jest.fn().mockResolvedValue({
      id: 'resp_incomplete_single',
      model: 'gpt-4.1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '1. Open with threat. 2. Keep mitigation',
      output: [],
      usage: { input_tokens: 8, output_tokens: 16, total_tokens: 24 }
    });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    await expect(
      createSingleChatCompletion(client, {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'SWTOR tanking guide' }]
      })
    ).rejects.toMatchObject({
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      finishReason: 'length',
      incompleteReason: 'max_output_tokens',
      truncated: true,
      lengthTruncated: true
    });
  });

  it('falls through to another model when a fallback-sequence attempt is incomplete', async () => {
    const primaryModel = getDefaultModel();
    const gpt5Model = getGPT5Model();

    const createSpy = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp_incomplete_primary',
        model: primaryModel,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: 'partial guide',
        output: [],
        usage: { input_tokens: 8, output_tokens: 16, total_tokens: 24 }
      })
      .mockResolvedValueOnce({
        id: 'resp_complete_retry',
        model: primaryModel,
        status: 'completed',
        output_text: 'Complete guide answer.',
        output: [],
        usage: { input_tokens: 8, output_tokens: 20, total_tokens: 28 }
      });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const result = await createChatCompletionWithFallback(client, {
      messages: [{ role: 'user', content: 'SWTOR tanking guide' }]
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[0][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[1][0].model).toBe(primaryModel);
    expect(createSpy.mock.calls[1][0].model).not.toBe(gpt5Model);
    expect(result.choices[0]?.message.content).toBe('Complete guide answer.');
    expect(result.choices[0]?.finish_reason).toBe('stop');
  });

  it('stops fallback expansion once the active request is aborted', async () => {
    jest.useFakeTimers();

    const createSpy = jest.fn().mockImplementation((_payload, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    });

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    const resultPromise = runWithRequestAbortTimeout(
      {
        timeoutMs: 25,
        requestId: 'req_abort_fallback',
        abortMessage: 'GPT route timeout after 25ms'
      },
      () => createChatCompletionWithFallback(client, { messages: [] })
    );
    const rejectionExpectation = expect(resultPromise).rejects.toThrow('GPT route timeout after 25ms');

    await jest.advanceTimersByTimeAsync(30);

    await rejectionExpectation;
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
