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
  it('suppresses in-process workers on Railway web services by default', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'true',
      RAILWAY_ENVIRONMENT: 'production',
      RAILWAY_SERVICE_NAME: 'ARCANOS V2',
      RAILWAY_SERVICE_ARCANOS_WORKER_URL: 'arcanos-worker-production.up.railway.app'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(false);
    expect(resolution.reason).toBe('railway_web_service');
    expect(getConfig().runWorkers).toBe(false);
  });

  it('keeps workers enabled for dedicated Railway worker services', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'true',
      RAILWAY_ENVIRONMENT: 'production',
      RAILWAY_SERVICE_NAME: 'ARCANOS Worker',
      RAILWAY_SERVICE_ARCANOS_WORKER_URL: 'arcanos-worker-production.up.railway.app'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(true);
    expect(resolution.reason).toBe('requested');
    expect(getConfig().runWorkers).toBe(true);
  });

  it('forces web role workers off when the launcher marks the process as web', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'true',
      ARCANOS_PROCESS_KIND: 'web'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(false);
    expect(resolution.reason).toBe('process_kind_web');
  });

  it('allows Railway web services to opt back into in-process workers explicitly', () => {
    resetEnv({
      NODE_ENV: 'production',
      RUN_WORKERS: 'true',
      RAILWAY_ENVIRONMENT: 'production',
      RAILWAY_SERVICE_NAME: 'ARCANOS V2',
      ARCANOS_ALLOW_WEB_SERVICE_WORKERS: 'true'
    });

    const resolution = resolveWorkerRuntimeMode();

    expect(resolution.resolvedRunWorkers).toBe(true);
    expect(resolution.reason).toBe('requested');
  });
});
