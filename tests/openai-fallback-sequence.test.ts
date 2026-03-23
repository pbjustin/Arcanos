import { afterEach, describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createChatCompletionWithFallback, getDefaultModel, getGPT5Model, getFallbackModel } from '../src/services/openai.js';
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
