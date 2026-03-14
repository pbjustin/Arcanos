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

describe('environment validation', () => {
  const originalEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    AI_MODEL: process.env.AI_MODEL,
    PORT: process.env.PORT,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT
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

  it('accepts custom Railway environment labels such as DEBUG', () => {
    process.env.RAILWAY_ENVIRONMENT = 'DEBUG';

    const result = validateEnvironment();

    expect(result.isValid).toBe(true);
    expect(result.errors).not.toContain('❌ Invalid value for RAILWAY_ENVIRONMENT: "DEBUG"');
  });

  it('treats blank Railway environment labels as unset and falls back to the default', () => {
    process.env.RAILWAY_ENVIRONMENT = '   ';

    const result = validateEnvironment();

    //audit Assumption: whitespace-only values are handled by the existing missing-value fallback path before validator execution; failure risk: tests incorrectly claim startup must fail for unset optional envs; expected invariant: blank optional Railway env labels normalize to the default and keep validation green; handling strategy: assert the default fallback warning instead of an invalid-value error.
    expect(result.isValid).toBe(true);
    expect(result.warnings).toContain('⚠️  RAILWAY_ENVIRONMENT not set, using default: production');
    expect(process.env.RAILWAY_ENVIRONMENT).toBe('production');
  });
});
