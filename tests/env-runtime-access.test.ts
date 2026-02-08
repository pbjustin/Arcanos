import { afterEach, describe, expect, test } from '@jest/globals';

import { readRuntimeEnv, unsetRuntimeEnv, writeRuntimeEnv } from '../src/config/env.js';

const RUNTIME_ENV_TEST_KEY = 'ARCANOS_RUNTIME_ENV_TEST_KEY';

afterEach(() => {
  unsetRuntimeEnv(RUNTIME_ENV_TEST_KEY);
});

describe('readRuntimeEnv', () => {
  test('returns default value when env key is unset', () => {
    const resolved = readRuntimeEnv(RUNTIME_ENV_TEST_KEY, 'fallback-value');
    expect(resolved).toBe('fallback-value');
  });

  test('returns default value when env key is empty string', () => {
    writeRuntimeEnv(RUNTIME_ENV_TEST_KEY, '');
    const resolved = readRuntimeEnv(RUNTIME_ENV_TEST_KEY, 'fallback-value');
    expect(resolved).toBe('fallback-value');
  });

  test('returns default value when env key is whitespace-only', () => {
    writeRuntimeEnv(RUNTIME_ENV_TEST_KEY, '   ');
    const resolved = readRuntimeEnv(RUNTIME_ENV_TEST_KEY, 'fallback-value');
    expect(resolved).toBe('fallback-value');
  });

  test('returns explicit env value when non-empty', () => {
    writeRuntimeEnv(RUNTIME_ENV_TEST_KEY, 'configured-value');
    const resolved = readRuntimeEnv(RUNTIME_ENV_TEST_KEY, 'fallback-value');
    expect(resolved).toBe('configured-value');
  });

  test('preserves string zero and does not use default', () => {
    writeRuntimeEnv(RUNTIME_ENV_TEST_KEY, '0');
    const resolved = readRuntimeEnv(RUNTIME_ENV_TEST_KEY, 'fallback-value');
    expect(resolved).toBe('0');
  });
});
