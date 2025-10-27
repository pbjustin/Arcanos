import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createChatCompletionWithFallback, getDefaultModel, getGPT5Model, getFallbackModel } from '../src/services/openai.js';

describe('createChatCompletionWithFallback', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
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
      .mockResolvedValueOnce({ id: 'final', model: finalModel, choices: [] });

    const client = {
      chat: {
        completions: {
          create: createSpy
        }
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
});
