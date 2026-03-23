import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createGPT5Reasoning } from '../src/services/openai.js';

describe('createGPT5Reasoning abort propagation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes an AbortSignal to the underlying Responses API call and rejects on request timeout', async () => {
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
        requestId: 'req_gpt5_reasoning_abort',
        abortMessage: 'GPT reasoning request timed out after 25ms'
      },
      () => createGPT5Reasoning(client, 'Explain mutexes.', 'Return plain text only.')
    );
    const rejectionExpectation = expect(resultPromise).rejects.toThrow('GPT reasoning request timed out after 25ms');

    await jest.advanceTimersByTimeAsync(30);

    await rejectionExpectation;
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[1]?.signal).toBeDefined();
  });

  it('preserves fallback behavior for non-abort provider failures', async () => {
    const createSpy = jest.fn().mockRejectedValue(new Error('provider failure'));

    const client = {
      responses: {
        create: createSpy
      }
    } as any;

    await expect(createGPT5Reasoning(client, 'Explain mutexes.')).resolves.toMatchObject({
      error: 'provider failure'
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
