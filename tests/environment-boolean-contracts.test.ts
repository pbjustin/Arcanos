import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { environmentBooleanCases } from './fixtures/environmentBooleanCases.js';

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({ recordTraceEvent: jest.fn() }));
jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({ recordJobEventCleanup: jest.fn() }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  cleanupRetainedFailedJobs: jest.fn(),
  cleanupRetainedNonGptTerminalJobs: jest.fn(),
  inspectLegacyNullNonGptTerminalJobs: jest.fn(),
  DEFAULT_FAILED_JOB_CLEANUP_MIN_AGE_MS: 86_400_000,
  DEFAULT_FAILED_JOB_RETENTION_COUNT: 50,
  DEFAULT_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE: 100,
  MAX_FAILED_JOB_CLEANUP_MIN_AGE_MS: 2_592_000_000,
  MAX_FAILED_JOB_RETENTION_COUNT: 1_000,
  MAX_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE: 1_000,
}));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  cleanupJobEvents: jest.fn(),
  DEFAULT_JOB_EVENT_CLEANUP_BATCH_SIZE: 1_000,
  DEFAULT_JOB_EVENT_RETENTION_DAYS: 30,
  MAX_JOB_EVENT_CLEANUP_BATCH_SIZE: 10_000,
  MAX_JOB_EVENT_RETENTION_DAYS: 365,
}));

const { getEnvBoolean } = await import('../src/platform/runtime/env.js');
const { getConfig } = await import('../src/platform/runtime/unifiedConfig.js');
const { isOpenAIApiKeyRequiredForStartup } = await import('../src/platform/runtime/environmentValidation.js');
const {
  resolveFailedJobCleanupPolicy,
  resolveNonGptTerminalCleanupPolicy,
  resolveJobEventCleanupPolicy,
} = await import('../src/queue/cleanup.js');

const originalEnv = { ...process.env };

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnv)) delete process.env[name];
  }
  Object.assign(process.env, originalEnv);
});

describe('characterized runtime environment Boolean contracts', () => {
  it.each(environmentBooleanCases)('preserves legacy configuration parsing for $label', ({ value, legacy }) => {
    setEnv('ARCANOS_BOOLEAN_CHARACTERIZATION_TEST', value);
    expect(getEnvBoolean('ARCANOS_BOOLEAN_CHARACTERIZATION_TEST', false)).toBe(legacy ?? false);
    expect(getEnvBoolean('ARCANOS_BOOLEAN_CHARACTERIZATION_TEST', true)).toBe(legacy ?? true);

    setEnv('PREDICTIVE_AUTO_EXECUTE', value);
    delete process.env.RAILWAY_PREDICTIVE_AUTO_EXECUTE;
    delete process.env.AUTO_EXECUTE_HEALING;
    expect(getConfig().autoExecuteHealing).toBe(legacy ?? false);
  });

  it.each(environmentBooleanCases)('preserves cleanup defaults for $label', ({ value, extended }) => {
    expect(resolveFailedJobCleanupPolicy({ QUEUE_FAILED_JOB_CLEANUP_ENABLED: value }).enabled).toBe(extended ?? true);
    expect(resolveNonGptTerminalCleanupPolicy({ QUEUE_NON_GPT_TERMINAL_CLEANUP_ENABLED: value }).enabled).toBe(extended ?? true);
    expect(resolveJobEventCleanupPolicy({
      JOB_EVENTS_CLEANUP_ENABLED: value,
      JOB_EVENTS_CLEANUP_DRY_RUN: value,
    })).toMatchObject({ enabled: extended ?? true, dryRun: extended ?? true });
  });

  it.each(environmentBooleanCases)('preserves nullable startup overrides for $label', ({ value, extended }) => {
    setEnv('OPENAI_API_KEY_REQUIRED', value);
    process.env.ALLOW_MOCK_OPENAI = 'false';
    process.env.FORCE_MOCK = 'false';
    process.env.NODE_ENV = 'production';
    expect(isOpenAIApiKeyRequiredForStartup()).toBe(extended ?? true);
    process.env.NODE_ENV = 'test';
    expect(isOpenAIApiKeyRequiredForStartup()).toBe(extended ?? false);
  });

  it.each(['on', 'off', 'unknown'])('keeps predictive dry-run fail-closed for %s', (value) => {
    process.env.PREDICTIVE_HEALING_DRY_RUN = value;
    process.env.PREDICTIVE_DRY_RUN = 'false';
    expect(getConfig().predictiveHealingDryRun).toBe(true);
  });
});
