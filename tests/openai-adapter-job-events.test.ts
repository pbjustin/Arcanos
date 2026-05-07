import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const responsesCreateMock = jest.fn();
const chatCreateMock = jest.fn();
const embeddingsCreateMock = jest.fn();
const imagesGenerateMock = jest.fn();
const transcriptionsCreateMock = jest.fn();
const openAIConstructorMock = jest.fn();
const getAiExecutionContextMock = jest.fn();
const recordJobEventMock = jest.fn();
const recordDependencyCallMock = jest.fn();
const recordAiOperationResultMock = jest.fn();

jest.unstable_mockModule('openai', () => ({
  default: openAIConstructorMock
}));

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordDependencyCall: recordDependencyCallMock
}));

jest.unstable_mockModule('@services/openai/aiExecutionContext.js', () => ({
  assertAiBudgetAllowsCall: jest.fn(),
  getAiExecutionContext: getAiExecutionContextMock,
  recordAiOperationResult: recordAiOperationResultMock
}));

jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock
}));

const { createOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js');

describe('openai adapter job events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    openAIConstructorMock.mockImplementation(() => ({
      chat: { completions: { create: chatCreateMock } },
      responses: {
        create: responsesCreateMock
      },
      embeddings: { create: embeddingsCreateMock },
      images: { generate: imagesGenerateMock },
      audio: { transcriptions: { create: transcriptionsCreateMock } }
    }));
    getAiExecutionContextMock.mockReturnValue({
      provider: 'openai',
      sourceType: 'job',
      sourceName: 'gpt',
      requestId: 'req-1',
      traceId: 'trace-1',
      jobId: '11111111-1111-4111-8111-111111111111'
    });
  });

  it('records failed AI job events without raw provider error text', async () => {
    responsesCreateMock.mockRejectedValueOnce(
      new Error('provider echoed prompt SECRET_PROMPT and completion SECRET_COMPLETION')
    );

    const adapter = createOpenAIAdapter({ apiKey: 'test-key' });

    await expect(adapter.responses.create({
      model: 'gpt-4.1-mini',
      input: 'SECRET_PROMPT'
    } as any)).rejects.toThrow('SECRET_PROMPT');

    const failedEvent = recordJobEventMock.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((event) => event.eventType === 'ai.request.failed');

    expect(failedEvent).toEqual(expect.objectContaining({
      jobId: '11111111-1111-4111-8111-111111111111',
      eventType: 'ai.request.failed',
      traceId: 'trace-1',
        metadata: expect.objectContaining({
          provider: 'openai',
        operation: 'responses_create',
        model: 'gpt-4.1-mini',
        sourceType: 'job',
        sourceName: 'gpt',
        errorType: 'Error'
      })
    }));
    expect(JSON.stringify(failedEvent)).not.toContain('SECRET_PROMPT');
    expect(JSON.stringify(failedEvent)).not.toContain('SECRET_COMPLETION');
  });
});
