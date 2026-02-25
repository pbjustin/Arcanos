import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const chatCreateMock = jest.fn();
const embeddingsCreateMock = jest.fn();
const imagesGenerateMock = jest.fn();
const transcriptionsCreateMock = jest.fn();
const openAIConstructorMock = jest.fn();

let createOpenAIAdapter: typeof import('../src/adapters/openai.adapter.js').createOpenAIAdapter;

beforeEach(async () => {
  jest.resetModules();
  chatCreateMock.mockReset();
  embeddingsCreateMock.mockReset();
  imagesGenerateMock.mockReset();
  transcriptionsCreateMock.mockReset();
  openAIConstructorMock.mockReset();

  openAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: chatCreateMock } },
    embeddings: { create: embeddingsCreateMock },
    images: { generate: imagesGenerateMock },
    audio: { transcriptions: { create: transcriptionsCreateMock } },
  }));

  jest.unstable_mockModule('openai', () => ({
    default: openAIConstructorMock
  }));

  ({ createOpenAIAdapter } = await import('../src/adapters/openai.adapter.js'));
});

describe('openai adapter', () => {
  it('forwards chat request options and enforces non-stream payloads', async () => {
    chatCreateMock.mockResolvedValue({
      id: 'chat_1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4.1-mini',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    const adapter = createOpenAIAdapter({ apiKey: 'test-key' });
    const signal = new AbortController().signal;
    const headers = { 'x-request-id': 'req_1' };

    await adapter.responses.create(
      {
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      { signal, headers }
    );

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
    expect(chatCreateMock.mock.calls[0][0]).toEqual(expect.objectContaining({ stream: false }));
    expect(chatCreateMock.mock.calls[0][1]).toEqual({ signal, headers });
  });

  it('routes image generation through adapter images surface with options', async () => {
    imagesGenerateMock.mockResolvedValue({
      created: 1700000000,
      data: [{ b64_json: 'ZmFrZQ==' }],
    });

    const adapter = createOpenAIAdapter({ apiKey: 'test-key' });
    const headers = { 'x-trace-id': 'trace_1' };

    await adapter.images.generate(
      {
        model: 'gpt-image-1',
        prompt: 'draw a lighthouse',
        size: '1024x1024',
      } as any,
      { headers }
    );

    expect(imagesGenerateMock).toHaveBeenCalledTimes(1);
    expect(imagesGenerateMock.mock.calls[0][0]).toEqual(expect.objectContaining({ prompt: 'draw a lighthouse' }));
    expect(imagesGenerateMock.mock.calls[0][1]).toEqual({ headers });
  });
});
