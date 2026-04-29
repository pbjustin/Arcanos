import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getDefaultModelMock = jest.fn();
const getGPT5ModelMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();
const runTrinityWritingPipelineMock = jest.fn();

let arcanosQuery: typeof import('../src/services/arcanosQuery.js').arcanosQuery;

beforeEach(async () => {
  jest.resetModules();
  getDefaultModelMock.mockReset();
  getGPT5ModelMock.mockReset();
  getOpenAIClientOrAdapterMock.mockReset();
  runTrinityWritingPipelineMock.mockReset();

  getDefaultModelMock.mockReturnValue('ft:arcanos-test');
  getGPT5ModelMock.mockReturnValue('gpt-5.1-test');

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    getDefaultModel: getDefaultModelMock,
    getGPT5Model: getGPT5ModelMock,
  }));

  jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
    getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
    requireOpenAIClientOrAdapter: jest.fn(() => getOpenAIClientOrAdapterMock()),
  }));

  jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
    runTrinityWritingPipeline: runTrinityWritingPipelineMock
  }));

  ({ arcanosQuery } = await import('../src/services/arcanosQuery.js'));
});

describe('arcanosQuery', () => {
  it('passes the original user prompt into the reasoning layer', async () => {
    runTrinityWritingPipelineMock.mockResolvedValue({ result: 'Final answer' });

    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: {},
    });

    const result = await arcanosQuery('Explain recursion simply.');

    expect(result).toBe('Final answer');
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: 'Explain recursion simply.',
        moduleId: 'ARCANOS:QUERY',
        sourceEndpoint: 'arcanosQuery',
        requestedAction: 'query',
        body: { prompt: 'Explain recursion simply.' }
      })
    }));
  });

  it('preserves exact-response prompts by skipping the reasoning layer', async () => {
    runTrinityWritingPipelineMock.mockResolvedValue({ result: 'OK' });

    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: {},
    });

    const result = await arcanosQuery('Reply with exactly OK.');

    expect(result).toBe('OK');
    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(1);
  });
});
