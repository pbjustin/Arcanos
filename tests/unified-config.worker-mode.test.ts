import { afterEach, describe, expect, it } from '@jest/globals';
import { getConfig, resolveWorkerRuntimeMode } from '../src/platform/runtime/unifiedConfig.js';

const originalEnv = { ...process.env };

function resetEnv(overrides: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  Object.assign(process.env, originalEnv);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

afterEach(() => {
  resetEnv({});
});

describe('resolveWorkerRuntimeMode', () => {
  it('forces workers off when the process kind is explicitly web', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'true',
      ARCANOS_PROCESS_KIND: 'web'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(false);
    expect(resolution.reason).toBe('process_kind_web');
    expect(getConfig().runWorkers).toBe(false);
  });

  it('forces workers on when the process kind is explicitly worker', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'false',
      ARCANOS_PROCESS_KIND: 'worker'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(true);
    expect(resolution.reason).toBe('process_kind_worker');
    expect(getConfig().runWorkers).toBe(true);
  });

  it('falls back to RUN_WORKERS without service-name suppression when process kind is missing', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'true',
      RAILWAY_ENVIRONMENT: 'production',
      RAILWAY_SERVICE_NAME: 'ARCANOS V2'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(true);
    expect(resolution.reason).toBe('requested');
  });

  it('treats invalid process kinds as unknown and falls back to RUN_WORKERS', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'false',
      ARCANOS_PROCESS_KIND: 'scheduler'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.processKind).toBe('unknown');
    expect(resolution.resolvedRunWorkers).toBe(false);
    expect(resolution.reason).toBe('requested');
  });
});
