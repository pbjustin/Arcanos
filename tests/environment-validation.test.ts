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

const CI_GPT_ACCESS_SCOPES = [
  'runtime.read',
  'workers.read',
  'queue.read',
  'jobs.create',
  'jobs.result',
  'logs.read_sanitized',
  'db.explain_approved',
  'mcp.approved_readonly',
  'diagnostics.read'
].join(',');

const CI_GPT_ACCESS_PORT = ['80', '80'].join('');
const CI_GPT_ACCESS_BASE_URL = ['http', '://localhost:', CI_GPT_ACCESS_PORT].join('');
const CI_OPENAI_KEY = ['mock', 'api', 'key'].join('-');

describe('environment validation', () => {
  const originalEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    AI_MODEL: process.env.AI_MODEL,
    PORT: process.env.PORT,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
    ALLOW_MOCK_OPENAI: process.env.ALLOW_MOCK_OPENAI,
    FORCE_MOCK: process.env.FORCE_MOCK,
    OPENAI_API_KEY_REQUIRED: process.env.OPENAI_API_KEY_REQUIRED,
    ARCANOS_GPT_ACCESS_TOKEN: process.env.ARCANOS_GPT_ACCESS_TOKEN,
    ARCANOS_GPT_ACCESS_BASE_URL: process.env.ARCANOS_GPT_ACCESS_BASE_URL,
    ARCANOS_GPT_ACCESS_SCOPES: process.env.ARCANOS_GPT_ACCESS_SCOPES
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
    process.env.NODE_ENV = 'development';
    process.env.ARCANOS_GPT_ACCESS_TOKEN = 'test-gpt-access-token-1234567890';
    process.env.ARCANOS_GPT_ACCESS_BASE_URL = 'https://gateway.example.test';
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'runtime.read,workers.read,queue.read,jobs.create,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read';
    delete process.env.OPENAI_API_KEY_REQUIRED;
    delete process.env.ALLOW_MOCK_OPENAI;
    delete process.env.FORCE_MOCK;
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

  it('requires OpenAI and GPT access credentials in production by default', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = '';
    process.env.ARCANOS_GPT_ACCESS_TOKEN = '';
    process.env.ARCANOS_GPT_ACCESS_BASE_URL = '';
    process.env.ARCANOS_GPT_ACCESS_SCOPES = '';

    const result = validateEnvironment();

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '❌ Required environment variable OPENAI_API_KEY is not set',
        '❌ Required environment variable ARCANOS_GPT_ACCESS_TOKEN is not set',
        '❌ Required environment variable ARCANOS_GPT_ACCESS_BASE_URL is not set',
        '❌ Required environment variable ARCANOS_GPT_ACCESS_SCOPES is not set'
      ])
    );
  });

  it('rejects invalid GPT access OpenAPI origin and scope config', () => {
    process.env.ARCANOS_GPT_ACCESS_BASE_URL = 'http://gateway.example.test?token=secret';
    process.env.ARCANOS_GPT_ACCESS_SCOPES = 'runtime.read,workers.typo';

    const result = validateEnvironment();

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('❌ Invalid value for ARCANOS_GPT_ACCESS_BASE_URL: set but invalid'),
        '❌ Invalid value for ARCANOS_GPT_ACCESS_SCOPES: "runtime.read,workers.typo"'
      ])
    );
  });

  it('allows an explicit OpenAI startup requirement override for rollback', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_API_KEY_REQUIRED = 'false';

    const result = validateEnvironment();

    expect(result.errors).not.toContain('❌ Required environment variable OPENAI_API_KEY is not set');
  });

  it('accepts CI production startup env with mock OpenAI and local GPT access gateway config', () => {
    process.env.CI = 'true';
    process.env.NODE_ENV = 'production';
    process.env['OPENAI_API_KEY'] = CI_OPENAI_KEY;
    process.env.ARCANOS_GPT_ACCESS_TOKEN = 'ci-gpt-access-token-for-local-workflow-only';
    process.env.ARCANOS_GPT_ACCESS_BASE_URL = CI_GPT_ACCESS_BASE_URL;
    process.env.ARCANOS_GPT_ACCESS_SCOPES = CI_GPT_ACCESS_SCOPES;

    const result = validateEnvironment();

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
