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
    ARCANOS_GPT_ACCESS_SCOPES: process.env.ARCANOS_GPT_ACCESS_SCOPES,
    ARCANOS_JOB_READ_CAPABILITY_SECRET:
      process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET,
    ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET:
      process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET,
    ARCANOS_WORKER_HELPER_TOKEN: process.env.ARCANOS_WORKER_HELPER_TOKEN,
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    RAILWAY_SERVICE_ID: process.env.RAILWAY_SERVICE_ID,
    RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
    RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
    RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID
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
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET =
      'test-job-read-capability-secret-1234567890';
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET;
    delete process.env.ARCANOS_WORKER_HELPER_TOKEN;
    delete process.env.RAILWAY_PROJECT_ID;
    delete process.env.RAILWAY_SERVICE_ID;
    delete process.env.RAILWAY_SERVICE_NAME;
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    delete process.env.RAILWAY_DEPLOYMENT_ID;
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
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = '';

    const result = validateEnvironment();

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '❌ Required environment variable OPENAI_API_KEY is not set',
        '❌ Required environment variable ARCANOS_GPT_ACCESS_TOKEN is not set',
        '❌ Required environment variable ARCANOS_GPT_ACCESS_BASE_URL is not set',
        '❌ Required environment variable ARCANOS_GPT_ACCESS_SCOPES is not set',
        '❌ Required environment variable ARCANOS_JOB_READ_CAPABILITY_SECRET is not set'
      ])
    );
  });

  it('requires the current job-read signing key on Railway outside test mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.RAILWAY_PROJECT_ID = 'railway-project-test';
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const result = validateEnvironment();

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      '❌ Required environment variable ARCANOS_JOB_READ_CAPABILITY_SECRET is not set'
    );
  });

  it('keeps local and test validation friendly when the current key is absent', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const localResult = validateEnvironment();

    expect(localResult.isValid).toBe(true);
    expect(localResult.errors).not.toContain(
      '❌ Required environment variable ARCANOS_JOB_READ_CAPABILITY_SECRET is not set'
    );

    process.env.NODE_ENV = 'test';
    process.env.RAILWAY_PROJECT_ID = 'railway-project-test';

    const testResult = validateEnvironment();

    expect(testResult.isValid).toBe(true);
    expect(testResult.errors).not.toContain(
      '❌ Required environment variable ARCANOS_JOB_READ_CAPABILITY_SECRET is not set'
    );
  });

  it.each([
    ['too short', 'too-short'],
    ['whitespace', 'job-read-capability-secret-with internal-whitespace-1234'],
    ['purpose-bound collision', 'test-gpt-access-token-1234567890']
  ])('rejects a %s current job-read signing key through the shared resolver', (_caseName, secret) => {
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = secret;

    const result = validateEnvironment();

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      `❌ Invalid value for ARCANOS_JOB_READ_CAPABILITY_SECRET: set but invalid (${secret.length} characters)`
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('accepts a distinct previous signing key and rejects reuse or peer collisions', () => {
    const previousSecret =
      'previous-job-read-capability-secret-1234567890';
    process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET = previousSecret;

    const validResult = validateEnvironment();

    expect(validResult.isValid).toBe(true);

    process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET =
      process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const reusedResult = validateEnvironment();

    expect(reusedResult.isValid).toBe(false);
    expect(reusedResult.errors).toEqual(expect.arrayContaining([
      expect.stringContaining(
        '❌ Invalid value for ARCANOS_JOB_READ_CAPABILITY_SECRET: set but invalid'
      ),
      expect.stringContaining(
        '❌ Invalid value for ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET: set but invalid'
      )
    ]));

    process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET =
      'worker-helper-purpose-bound-collision-1234567890';
    process.env.ARCANOS_WORKER_HELPER_TOKEN =
      process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET;

    const collisionResult = validateEnvironment();

    expect(collisionResult.isValid).toBe(false);
    expect(collisionResult.errors).toEqual([
      expect.stringContaining(
        '❌ Invalid value for ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET: set but invalid'
      )
    ]);
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
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET =
      'ci-job-read-capability-secret-for-local-workflow';

    const result = validateEnvironment();

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
