import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

  it('evaluates HRC output through the shared structured response helper', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-4.1-mini',
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
});
