import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRecordTraceEvent = jest.fn();
const mockAiLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
};

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: mockRecordTraceEvent
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: mockAiLogger
}));

const {
  getConfig,
  getConfigValue,
  getEnvVar,
  isRailwayEnvironment,
  validateConfig
} = await import('../src/platform/runtime/unifiedConfig.js');

const TRACKED_ENV_KEYS = [
  'OPENAI_API_KEY',
  'RAILWAY_OPENAI_API_KEY',
  'API_KEY',
  'OPENAI_KEY',
  'NODE_ENV',
  'DATABASE_URL',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_SERVICE_NAME',
  'FINETUNED_MODEL_ID',
  'FINE_TUNED_MODEL_ID',
  'AI_MODEL',
  'OPENAI_MODEL',
  'RAILWAY_OPENAI_MODEL',
  'FALLBACK_MODEL',
  'AI_FALLBACK_MODEL',
  'RAILWAY_OPENAI_FALLBACK_MODEL',
  'ENABLE_ACTION_PLANS',
  'RUN_WORKERS'
] as const;

const originalEnv = new Map<string, string | undefined>(
  TRACKED_ENV_KEYS.map((key) => [key, process.env[key]])
);

function setEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function restoreTrackedEnv(): void {
  for (const key of TRACKED_ENV_KEYS) {
    setEnvValue(key, originalEnv.get(key));
  }
}

describe('unified runtime config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    restoreTrackedEnv();
  });

  afterEach(() => {
    restoreTrackedEnv();
  });

  afterAll(() => {
    restoreTrackedEnv();
  });

  it('resolves env vars in priority order and trims whitespace', () => {
    setEnvValue('OPENAI_API_KEY', '  primary-value  ');
    setEnvValue('RAILWAY_OPENAI_API_KEY', 'railway-value');

    expect(getEnvVar('OPENAI_API_KEY', ['OPENAI_KEY'])).toBe('primary-value');
  });

  it('falls back from primary to Railway-prefixed and fallback keys', () => {
    setEnvValue('OPENAI_API_KEY', '   ');
    setEnvValue('RAILWAY_OPENAI_API_KEY', 'railway-value');
    setEnvValue('OPENAI_KEY', 'fallback-value');

    expect(getEnvVar('OPENAI_API_KEY', ['OPENAI_KEY'])).toBe('railway-value');

    setEnvValue('RAILWAY_OPENAI_API_KEY', '   ');
    expect(getEnvVar('OPENAI_API_KEY', ['OPENAI_KEY'])).toBe('fallback-value');
  });

  it('returns undefined when no env value is available', () => {
    setEnvValue('MISSING_KEY', undefined);
    expect(getEnvVar('MISSING_KEY')).toBeUndefined();
  });

  it('detects Railway environment only when at least one Railway marker exists', () => {
    setEnvValue('RAILWAY_ENVIRONMENT', undefined);
    setEnvValue('RAILWAY_PROJECT_ID', undefined);
    setEnvValue('RAILWAY_SERVICE_NAME', undefined);
    expect(isRailwayEnvironment()).toBe(false);

    setEnvValue('RAILWAY_SERVICE_NAME', 'ARCANOS V2');
    expect(isRailwayEnvironment()).toBe(true);
  });

  it('uses fine-tuned model id as default and fallback model when explicit fallback is absent', () => {
    setEnvValue('FINETUNED_MODEL_ID', 'ft:model-123');
    setEnvValue('FALLBACK_MODEL', undefined);
    setEnvValue('AI_FALLBACK_MODEL', undefined);
    setEnvValue('RAILWAY_OPENAI_FALLBACK_MODEL', undefined);

    const config = getConfig();

    expect(config.defaultModel).toBe('ft:model-123');
    expect(config.fallbackModel).toBe('ft:model-123');
  });

  it('returns config values by key', () => {
    setEnvValue('ENABLE_ACTION_PLANS', 'true');

    expect(getConfigValue('enableActionPlans')).toBe(true);
  });

  it('emits validation warnings and trace event when important values are missing', () => {
    setEnvValue('OPENAI_API_KEY', undefined);
    setEnvValue('NODE_ENV', 'production');
    setEnvValue('DATABASE_URL', undefined);
    setEnvValue('RAILWAY_SERVICE_NAME', 'ARCANOS V2');
    setEnvValue('RAILWAY_ENVIRONMENT', undefined);
    setEnvValue('RAILWAY_PROJECT_ID', undefined);

    const result = validateConfig();

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'OPENAI_API_KEY not set - AI endpoints will return mock responses',
      'DATABASE_URL not set - database features will be unavailable',
      'RAILWAY_ENVIRONMENT not set - Railway environment detection may be incomplete',
      'RAILWAY_PROJECT_ID not set - Railway project identification may be incomplete'
    ]));
    expect(mockRecordTraceEvent).toHaveBeenCalledWith('config.validation', expect.objectContaining({
      warnings: result.warnings.length
    }));
    expect(mockAiLogger.warn).toHaveBeenCalled();
  });

  it('logs a success message when validation has no warnings', () => {
    setEnvValue('OPENAI_API_KEY', 'sk-test');
    setEnvValue('NODE_ENV', 'development');
    setEnvValue('DATABASE_URL', 'postgres://localhost:5432/test');
    setEnvValue('RAILWAY_SERVICE_NAME', undefined);
    setEnvValue('RAILWAY_ENVIRONMENT', undefined);
    setEnvValue('RAILWAY_PROJECT_ID', undefined);

    const result = validateConfig();

    expect(result.warnings).toHaveLength(0);
    expect(mockAiLogger.info).toHaveBeenCalledWith('Configuration validation passed', expect.objectContaining({
      module: 'config.unified',
      environment: 'development'
    }));
  });
});
