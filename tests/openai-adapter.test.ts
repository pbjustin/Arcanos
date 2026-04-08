import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const chatCreateMock = jest.fn();
const responsesCreateMock = jest.fn();
const sdkResponsesParseMock = jest.fn();
const embeddingsCreateMock = jest.fn();
const imagesGenerateMock = jest.fn();
const transcriptionsCreateMock = jest.fn();
const openAIConstructorMock = jest.fn();

let createOpenAIAdapter: typeof import('../src/core/adapters/openai.adapter.js').createOpenAIAdapter;

beforeEach(async () => {
  jest.resetModules();
  chatCreateMock.mockReset();
  responsesCreateMock.mockReset();
  sdkResponsesParseMock.mockReset();
  embeddingsCreateMock.mockReset();
  imagesGenerateMock.mockReset();
  transcriptionsCreateMock.mockReset();
  openAIConstructorMock.mockReset();

  openAIConstructorMock.mockImplementation(() => {
    const client: any = {
      chat: { completions: { create: chatCreateMock } },
      responses: {
        create: responsesCreateMock,
        parse: sdkResponsesParseMock
      },
      embeddings: { create: embeddingsCreateMock },
      images: { generate: imagesGenerateMock },
      audio: { transcriptions: { create: transcriptionsCreateMock } },
      models: { retrieve: jest.fn() },
      beta: {
        assistants: { list: jest.fn() },
        threads: {
          create: jest.fn(),
          runs: { create: jest.fn() },
        },
      },
    };

    return client;
  });

  jest.unstable_mockModule('openai', () => ({
    default: openAIConstructorMock
  }));

  ({ createOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js'));
});

describe('openai adapter', () => {
  it('forwards chat request options and enforces non-stream payloads', async () => {
    responsesCreateMock.mockResolvedValue({
      id: 'resp_1',
      created_at: 1,
      model: 'gpt-4.1-mini',
      output_text: 'hello',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ model: 'gpt-4.1-mini' })
    );
    expect(responsesCreateMock.mock.calls[0][1]).toEqual({ signal, headers });
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

  it('patches the raw SDK client parse helper onto explicit JSON parsing', async () => {
    responsesCreateMock.mockResolvedValue({
      id: 'resp_parse_1',
      created_at: 1,
      model: 'gpt-4.1-mini',
      output_text: '{"ok":true}',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    });

    const adapter = createOpenAIAdapter({ apiKey: 'test-key' });
    const client = adapter.getClient() as any;
    expect(client.responses.create).toBe(responsesCreateMock);
    expect(client.responses.parse).not.toBe(sdkResponsesParseMock);

    const result = await client.responses['parse']({
      model: 'gpt-4.1-mini',
      input: 'hello',
      text: { format: { type: 'json_object' } }
    });

    expect(sdkResponsesParseMock).not.toHaveBeenCalled();
    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ output_parsed: { ok: true } }));
  });
});
