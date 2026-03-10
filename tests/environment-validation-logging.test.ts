import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const loggerDebugMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  logger: {
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock
  }
}));

const { validateEnvironment } = await import('../src/platform/runtime/environmentValidation.js');

describe('environment validation logging', () => {
  const originalEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    AI_MODEL: process.env.AI_MODEL,
    PORT: process.env.PORT
  };

  beforeEach(() => {
    loggerDebugMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();

    process.env.OPENAI_API_KEY = 'sk-test-openai-key-1234567890abcdefghijklmn';
    process.env.RAILWAY_API_TOKEN = 'railway_token_1234567890abcdefghijkl';
    process.env.DATABASE_URL = 'postgresql://postgres:super-secret-password@db.example.com:5432/arcanos';
    process.env.AI_MODEL = 'gpt-4.1';
    process.env.PORT = '8080';
  });

  afterEach(() => {
    for (const [environmentKey, originalValue] of Object.entries(originalEnvironment)) {
      if (originalValue === undefined) {
        delete process.env[environmentKey];
      } else {
        process.env[environmentKey] = originalValue;
      }
    }
  });

  it('redacts sensitive environment values while preserving public previews', () => {
    validateEnvironment();

    expect(loggerDebugMock).toHaveBeenCalledWith(
      '✅ OPENAI_API_KEY validation passed',
      expect.objectContaining({
        state: 'set',
        sensitivity: 'sensitive',
        length: process.env.OPENAI_API_KEY?.length
      })
    );
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '✅ RAILWAY_API_TOKEN validation passed',
      expect.objectContaining({
        state: 'set',
        sensitivity: 'sensitive',
        length: process.env.RAILWAY_API_TOKEN?.length
      })
    );
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '✅ DATABASE_URL validation passed',
      expect.objectContaining({
        state: 'set',
        sensitivity: 'sensitive',
        length: process.env.DATABASE_URL?.length
      })
    );
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '✅ AI_MODEL validation passed',
      expect.objectContaining({
        state: 'set',
        sensitivity: 'public',
        valuePreview: 'gpt-4.1...'
      })
    );

    const serializedCalls = JSON.stringify(loggerDebugMock.mock.calls);

    //audit Assumption: regression protection should fail on any raw secret material, not just the OpenAI key; failure risk: generic logger shape changes keep the test green while sensitive values still leak; expected invariant: serialized debug payloads exclude the exact secret inputs set above; handling strategy: assert each seeded secret string is absent from captured calls.
    expect(serializedCalls).not.toContain('sk-test-openai-key-1234567890abcdefghijklmn');
    expect(serializedCalls).not.toContain('railway_token_1234567890abcdefghijkl');
    expect(serializedCalls).not.toContain('postgresql://postgres:super-secret-password@db.example.com:5432/arcanos');
  });
});
