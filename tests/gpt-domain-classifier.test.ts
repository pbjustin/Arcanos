import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const aiLoggerWarnMock = jest.fn();

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: aiLoggerWarnMock,
    error: jest.fn()
  }
}));

const { gptFallbackClassifier } = await import('../src/dispatcher/gptDomainClassifier.js');

describe('gptDomainClassifier', () => {
  beforeEach(() => {
    aiLoggerWarnMock.mockReset();
  });

  it('returns the classifier label when the model output is valid', async () => {
    const openaiClient = {
      responses: {
        create: jest.fn().mockResolvedValue({ output_text: 'code' })
      }
    } as any;

    await expect(gptFallbackClassifier(openaiClient, 'Write a helper function')).resolves.toBe('code');
    expect(aiLoggerWarnMock).not.toHaveBeenCalled();
  });

  it('logs a warning and falls back to natural when the model output is invalid', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const openaiClient = {
      responses: {
        create: jest.fn().mockResolvedValue({ output_text: 'ok' })
      }
    } as any;

    try {
      await expect(gptFallbackClassifier(openaiClient, 'Hello there')).resolves.toBe('natural');
      expect(aiLoggerWarnMock).toHaveBeenCalledWith(
        '[gptFallbackClassifier] Invalid domain label received; using natural fallback',
        expect.objectContaining({
          module: 'gptDomainClassifier',
          invalidDomainLabel: 'ok'
        })
      );
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
