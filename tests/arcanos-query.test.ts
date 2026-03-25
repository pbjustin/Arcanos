import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getDefaultModelMock = jest.fn();
const getGPT5ModelMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();

let arcanosQuery: typeof import('../src/services/arcanosQuery.js').arcanosQuery;

beforeEach(async () => {
  jest.resetModules();
  getDefaultModelMock.mockReset();
  getGPT5ModelMock.mockReset();
  getOpenAIClientOrAdapterMock.mockReset();

  getDefaultModelMock.mockReturnValue('ft:arcanos-test');
  getGPT5ModelMock.mockReturnValue('gpt-5.1-test');

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    getDefaultModel: getDefaultModelMock,
    getGPT5Model: getGPT5ModelMock,
  }));

  jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
    getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
  }));

  ({ arcanosQuery } = await import('../src/services/arcanosQuery.js'));
});

describe('arcanosQuery', () => {
  it('passes the original user prompt into the reasoning layer', async () => {
    const responsesCreateMock = jest
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Draft answer' } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Final answer' } }],
      });

    getOpenAIClientOrAdapterMock.mockReturnValue({
      adapter: {
        responses: {
          create: responsesCreateMock,
        },
      },
      client: {},
    });

    const result = await arcanosQuery('Explain recursion simply.');

    expect(result).toBe('Final answer');
    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
    expect(responsesCreateMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        model: 'gpt-5.1-test',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Original user prompt:\nExplain recursion simply.'),
          }),
        ]),
      })
    );
    expect(String(responsesCreateMock.mock.calls[1][0].messages[1].content)).toContain(
      'Candidate fine-tuned output:\nDraft answer'
    );
  });

  it('preserves exact-response prompts by skipping the reasoning layer', async () => {
    const responsesCreateMock = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'OK' } }],
    });

    getOpenAIClientOrAdapterMock.mockReturnValue({
      adapter: {
        responses: {
          create: responsesCreateMock,
        },
      },
      client: {},
    });

    const result = await arcanosQuery('Reply with exactly OK.');

    expect(result).toBe('OK');
    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        model: 'ft:arcanos-test',
      })
    );
  });
});
