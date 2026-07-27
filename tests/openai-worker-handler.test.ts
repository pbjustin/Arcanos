import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';

const responsesCreateMock = jest.fn();
const getWorkerOpenAIAdapterMock = jest.fn();

let openaiCompletionHandler:
  typeof import('../workers/src/handlers/openai.js').openaiCompletionHandler;

jest.unstable_mockModule('../workers/src/infrastructure/sdk/openai.js', () => ({
  getWorkerOpenAIAdapter: getWorkerOpenAIAdapterMock
}));

beforeAll(async () => {
  ({ openaiCompletionHandler } = await import('../workers/src/handlers/openai.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  getWorkerOpenAIAdapterMock.mockReturnValue({
    responses: {
      create: responsesCreateMock
    },
    getDefaults: () => ({
      chatModel: 'worker-default-model',
      embeddingModel: 'worker-embedding-model'
    })
  });
});

describe('OpenAI completion worker response handling', () => {
  it('returns text only from a completed provider response', async () => {
    responsesCreateMock.mockResolvedValue({
      id: 'resp_worker_text',
      status: 'completed',
      output_text: 'completed worker answer',
      output: []
    });

    await expect(
      openaiCompletionHandler({
        type: 'OPENAI_COMPLETION',
        payload: {
          prompt: 'answer the request'
        }
      })
    ).resolves.toEqual({
      response: 'completed worker answer'
    });
  });

  it.each([
    ['failed', 'terminal_status'],
    ['cancelled', 'terminal_status'],
    ['queued', 'pending_status'],
    ['in_progress', 'pending_status']
  ] as const)(
    'rejects %s responses instead of storing an empty successful result',
    async (status, reason) => {
      responsesCreateMock.mockResolvedValue({
        id: `resp_worker_${status}`,
        status,
        output_text: '',
        output: []
      });

      await expect(
        openaiCompletionHandler({
          type: 'OPENAI_COMPLETION',
          payload: {
            prompt: 'answer the request'
          }
        })
      ).rejects.toMatchObject({
        code: 'OPENAI_RESPONSE_LEGACY_CONVERSION_ERROR',
        reason,
        responseStatus: status
      });
    }
  );

  it('rejects a refusal instead of storing it as an empty successful result', async () => {
    responsesCreateMock.mockResolvedValue({
      id: 'resp_worker_refusal',
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'refusal',
              refusal: 'request declined'
            }
          ]
        }
      ]
    });

    await expect(
      openaiCompletionHandler({
        type: 'OPENAI_COMPLETION',
        payload: {
          prompt: 'answer the request'
        }
      })
    ).rejects.toMatchObject({
      name: 'OpenAIResponseRefusalError',
      source: 'OpenAI completion worker'
    });
  });
});
