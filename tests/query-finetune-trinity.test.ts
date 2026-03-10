import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const runResponseMock = jest.fn();
const getFallbackModelMock = jest.fn(() => 'gpt-4.1');
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../src/lib/runResponse.js', () => ({
  runResponse: runResponseMock
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  getFallbackModel: getFallbackModelMock
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  logger: {
    warn: loggerWarnMock
  }
}));

const { runTrinity } = await import('../src/trinity/trinity.js');

describe('runTrinity fine-tuned route fallback', () => {
  beforeEach(() => {
    runResponseMock.mockReset();
    getFallbackModelMock.mockClear();
    loggerWarnMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('includes json wording in structured prompts and falls back to the base model on primary failure', async () => {
    runResponseMock
      .mockRejectedValueOnce(new Error('fine-tuned model unavailable'))
      .mockResolvedValueOnce({
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '{"status":"ok"}'
              }
            ]
          }
        ]
      });

    const result = await runTrinity({
      prompt: 'health check',
      model: 'ft:custom-model',
      structured: true
    });

    expect(runResponseMock).toHaveBeenCalledTimes(2);
    expect(runResponseMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: 'ft:custom-model',
      json: true,
      input: [
        {
          role: 'user',
          content: expect.stringMatching(/json/i)
        }
      ]
    }));
    expect(runResponseMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      model: 'gpt-4.1',
      json: true
    }));
    expect(result).toEqual(expect.objectContaining({
      requestedModel: 'ft:custom-model',
      activeModel: 'gpt-4.1',
      fallbackFlag: true,
      fallbackReason: 'fine-tuned model unavailable',
      output: '{"status":"ok"}'
    }));
    expect(loggerWarnMock).toHaveBeenCalledWith('MODEL_FALLBACK_TRIGGERED', expect.objectContaining({
      requestedModel: 'ft:custom-model',
      fallbackModel: 'gpt-4.1'
    }));
  });

  it('aborts slow primary calls at the latency budget and retries the fallback with its own bounded attempt', async () => {
    jest.useFakeTimers();
    runResponseMock
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '{"status":"fallback-ok"}'
              }
            ]
          }
        ]
      });

    const resultPromise = runTrinity({
      prompt: 'health check',
      model: 'ft:slow-model',
      structured: true,
      latencyBudgetMs: 25
    });

    await jest.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(runResponseMock).toHaveBeenCalledTimes(2);
    expect(runResponseMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: 'ft:slow-model',
      requestOptions: expect.objectContaining({
        signal: expect.objectContaining({
          aborted: true
        })
      })
    }));
    expect(runResponseMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      model: 'gpt-4.1',
      requestOptions: expect.objectContaining({
        signal: expect.any(Object)
      })
    }));
    expect(result).toEqual(expect.objectContaining({
      requestedModel: 'ft:slow-model',
      activeModel: 'gpt-4.1',
      fallbackFlag: true,
      output: '{"status":"fallback-ok"}'
    }));
    expect(loggerWarnMock).toHaveBeenCalledWith('MODEL_LATENCY_BUDGET_EXCEEDED', expect.objectContaining({
      requestedModel: 'ft:slow-model',
      activeModel: 'ft:slow-model',
      attempt: 'primary',
      latencyBudgetMs: 25
    }));
    expect(loggerWarnMock).toHaveBeenCalledWith('MODEL_FALLBACK_TRIGGERED', expect.objectContaining({
      requestedModel: 'ft:slow-model',
      fallbackModel: 'gpt-4.1',
      latencyBudgetMs: 25
    }));
  });
});
