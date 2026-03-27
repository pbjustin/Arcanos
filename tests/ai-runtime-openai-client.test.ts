import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runSharedGPT5 = jest.fn();
const retryWithBackoff = jest.fn();
const getRuntimeOpenAIClient = jest.fn();

jest.unstable_mockModule('@arcanos/openai/runGPT5', () => ({
  runGPT5: runSharedGPT5
}));

jest.unstable_mockModule('@arcanos/openai/retry', () => ({
  retryWithBackoff
}));

jest.unstable_mockModule('../arcanos-ai-runtime/src/ai/openaiClient.ts', () => ({
  getRuntimeOpenAIClient
}));

const { runGPT5 } = await import('../arcanos-ai-runtime/src/runtime/openaiClient.ts');

describe('arcanos-ai-runtime openaiClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getRuntimeOpenAIClient.mockReturnValue({ clientId: 'runtime-openai-client' });
    runSharedGPT5.mockResolvedValue({ id: 'runtime-response' });
  });

  it('delegates GPT-5 execution to the shared runner with runtime retry ownership made explicit', async () => {
    const request = { model: 'gpt-5', input: [{ role: 'user', content: 'delegate me' }] };
    const budget = { startedAt: 0, hardDeadline: 60_000, watchdogLimit: 60_000, safetyBuffer: 0 };

    const result = await runGPT5(request, budget as any);

    expect(result).toEqual({ id: 'runtime-response' });
    expect(runSharedGPT5).toHaveBeenCalledWith(
      { clientId: 'runtime-openai-client' },
      request,
      budget,
      { retry: retryWithBackoff }
    );
  });
});
