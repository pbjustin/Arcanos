import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  buildWorkerReadinessResponse,
  createPassivePrPreviewServer,
  createWorkerHealthServer,
  createWorkerReadinessState,
  mirrorAndObserveWorkerOutput,
  recordWorkerShutdown,
  recordWorkerExit,
  recordWorkerOutput,
  assertPreviewIsolationOrThrow,
  buildNativePrApplicationChildEnvironment,
  buildNativePrApplicationSpawnSpec,
  resolvePassivePrPreviewOrThrow,
  resolveNativePrPreviewOrThrow,
  resolveCliBridgeListenerConfig,
  resolveHealthListenerConfig,
  waitForExit,
  WORKER_BOOTSTRAP_READY_SENTINEL,
  WORKER_OPERATIONAL_STATE_PREFIX,
} from '../scripts/start-railway-service.mjs';
import {
  WORKER_BOOTSTRAP_READY_SENTINEL as JOB_RUNNER_BOOTSTRAP_READY_SENTINEL,
} from '../src/workers/jobRunnerRuntime.js';

function buildWorkerOperationalStateLine({
  workerId = 'async-queue-slot-1',
  sequence = 1,
  state = 'accepting_claims',
  reason = null,
  retryAt = null,
} = {}) {
  return `${WORKER_OPERATIONAL_STATE_PREFIX}${JSON.stringify({
    workerId,
    sequence,
    state,
    reason,
    retryAt,
  })}\n`;
}

describe('start-railway-service launcher helpers', () => {
  const nativeApplicationPreviewEnvironment = {
    ARCANOS_PROCESS_KIND: 'web',
    PORT: '8080',
    RAILWAY_PROJECT_ID: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
    RAILWAY_ENVIRONMENT_ID: '73e443b6-a678-4315-8016-97f76825a432',
    RAILWAY_ENVIRONMENT_NAME: 'Arcanos-pr-1413',
    RAILWAY_SERVICE_ID: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
    RAILWAY_DEPLOYMENT_ID: '1ba334c8-c6d6-4a54-9762-02ae6bf9db06',
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    RAILWAY_PUBLIC_DOMAIN: 'arcanos-v2-arcanos-pr-1413.up.railway.app',
  };

  it('selects the contained application only for the native PR web role', () => {
    expect(resolveNativePrPreviewOrThrow(
      ['--pr-preview-app-safe-v1'],
      nativeApplicationPreviewEnvironment,
    )).toEqual({
      enabled: true,
      environmentCategory: 'native-pr',
      processKind: 'web',
      prNumber: 1413,
      runtimeMode: 'application',
      sourceCommit: 'a'.repeat(40),
    });

    expect(resolveNativePrPreviewOrThrow(
      ['--pr-preview-app-safe-v1'],
      {
        ...nativeApplicationPreviewEnvironment,
        ARCANOS_PROCESS_KIND: 'worker',
        RAILWAY_SERVICE_ID: '1765befb-b805-4051-9af9-28634e986886',
        RAILWAY_PUBLIC_DOMAIN: 'arcanos-worker-arcanos-pr-1413.up.railway.app',
      },
    )).toEqual({
      enabled: true,
      environmentCategory: 'native-pr',
      processKind: 'worker',
      prNumber: 1413,
      runtimeMode: 'passive',
      sourceCommit: 'a'.repeat(40),
    });

    expect(resolveNativePrPreviewOrThrow(
      ['--pr-preview-app-safe-v1'],
      {
        ...nativeApplicationPreviewEnvironment,
        RAILWAY_ENVIRONMENT_NAME: 'pr-c1a651-1411',
        RAILWAY_PUBLIC_DOMAIN:
          'arcanos-v2-pr-c1a651-1411.up.railway.app',
      },
    )).toMatchObject({
      prNumber: 1411,
      runtimeMode: 'application',
    });
  });

  it.each([
    [{ RAILWAY_ENVIRONMENT_NAME: 'production' }, 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    [{ RAILWAY_SERVICE_ID: '' }, 'PREVIEW_APPLICATION_SERVICE_REQUIRED'],
    [{ RAILWAY_DEPLOYMENT_ID: '' }, 'PREVIEW_APPLICATION_DEPLOYMENT_REQUIRED'],
    [{ RAILWAY_GIT_COMMIT_SHA: '' }, 'PREVIEW_APPLICATION_SOURCE_COMMIT_REQUIRED'],
    [{ RAILWAY_GIT_COMMIT_SHA: 'not-a-commit' }, 'PREVIEW_APPLICATION_SOURCE_COMMIT_INVALID'],
    [{ RAILWAY_PUBLIC_DOMAIN: 'arcanos-v2-production.up.railway.app' }, 'PREVIEW_APPLICATION_DOMAIN_MISMATCH'],
  ])('fails closed before application import for invalid native PR identity %#', (override, expectedCode) => {
    expect(() => resolveNativePrPreviewOrThrow(
      ['--pr-preview-app-safe-v1'],
      { ...nativeApplicationPreviewEnvironment, ...override },
    )).toThrow(expectedCode);
  });

  it('constructs an exact child allowlist without inherited credentials or code injection settings', () => {
    const childEnvironment = buildNativePrApplicationChildEnvironment({
      ...nativeApplicationPreviewEnvironment,
      DATABASE_URL: 'postgresql://sentinel.invalid/db',
      REDIS_URL: 'redis://sentinel.invalid',
      OPENAI_API_KEY: 'test-openai-key',
      RAILWAY_TOKEN: 'sentinel-railway-token',
      NODE_OPTIONS: '--import=./sentinel-loader.mjs',
      ARCANOS_GPT_ACCESS_TOKEN: 'sentinel-gpt-token',
    });

    expect(childEnvironment).toEqual({
      ARCANOS_NATIVE_PR_APPLICATION_PREVIEW: 'v1',
      ARCANOS_PREVIEW_PR_NUMBER: '1413',
      ARCANOS_PREVIEW_SOURCE_COMMIT: nativeApplicationPreviewEnvironment.RAILWAY_GIT_COMMIT_SHA,
      ARCANOS_PROCESS_KIND: 'web',
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      PORT: '8080',
      RUN_WORKERS: 'false',
      TZ: 'UTC',
    });

    const spawnSpec = buildNativePrApplicationSpawnSpec({
      ...nativeApplicationPreviewEnvironment,
      DATABASE_URL: 'postgresql://sentinel.invalid/db',
      NODE_OPTIONS: '--import=./sentinel-loader.mjs',
    });
    expect(spawnSpec).toEqual({
      args: [
        '--max-old-space-size=512',
        'dist/start-native-pr-preview.js',
      ],
      command: process.execPath,
      cwd: expect.any(String),
      env: childEnvironment,
    });
    expect(path.resolve(spawnSpec.cwd)).toBe(path.resolve(process.cwd()));

    const childProbe = spawnSync(
      spawnSpec.command,
      [
        '-e',
        'process.stdout.write(JSON.stringify(process.env))',
      ],
      {
        cwd: spawnSpec.cwd,
        encoding: 'utf8',
        env: spawnSpec.env,
      }
    );
    expect(childProbe.status).toBe(0);
    const observedChildEnvironment = JSON.parse(childProbe.stdout);
    expect(observedChildEnvironment).toMatchObject(childEnvironment);
    for (const forbiddenName of [
      'ARCANOS_GPT_ACCESS_TOKEN',
      'DATABASE_URL',
      'NODE_OPTIONS',
      'OPENAI_API_KEY',
      'RAILWAY_TOKEN',
      'REDIS_URL',
    ]) {
      expect(observedChildEnvironment[forbiddenName]).toBeUndefined();
    }
  });

  it('recognizes only the exact supported Railway native PR preview contracts', () => {
    expect(resolvePassivePrPreviewOrThrow(['--pr-preview-safe'], {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: 'Arcanos-pr-1395',
    })).toEqual({
      enabled: true,
      environmentCategory: 'native-pr',
      runtimeMode: 'passive',
    });

    expect(resolvePassivePrPreviewOrThrow(['--pr-preview-safe'], {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: 'pr-c1a651-1411',
    })).toEqual({
      enabled: true,
      environmentCategory: 'native-pr',
      runtimeMode: 'passive',
    });

    expect(resolvePassivePrPreviewOrThrow([], {
      RAILWAY_ENVIRONMENT_NAME: 'production',
    })).toEqual({ enabled: false });

    expect(resolvePassivePrPreviewOrThrow([], {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: 'Arcanos-pr-1395',
    })).toEqual({
      enabled: true,
      environmentCategory: 'native-pr',
      runtimeMode: 'passive',
    });

    expect(resolvePassivePrPreviewOrThrow([], {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: 'pr-c1a651-1411',
    })).toEqual({
      enabled: true,
      environmentCategory: 'native-pr',
      runtimeMode: 'passive',
    });
  });

  it.each([
    ['production', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['Arcanos-pr-0', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['Arcanos-pr-1395-extra', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['Arcanos-pr-production', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-c1a651-0', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-c1a651-01411', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-c1a65-1411', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-c1a65g-1411', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-production-1411', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-c1a651-production', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
    ['pr-c1a651-1411-extra', 'PREVIEW_ISOLATION_NATIVE_PR_ENVIRONMENT_REQUIRED'],
  ])('rejects passive preview mode outside an exact native PR environment: %s', (environmentName, expectedCode) => {
    expect(() => resolvePassivePrPreviewOrThrow(['--pr-preview-safe'], {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: environmentName,
    })).toThrow(expectedCode);
  });

  it.each([
    ['RAILWAY_PROJECT_ID', 'PREVIEW_ISOLATION_PROJECT_REQUIRED'],
    ['RAILWAY_ENVIRONMENT_ID', 'PREVIEW_ISOLATION_ENVIRONMENT_ID_REQUIRED'],
  ])('requires Railway-owned %s before passive preview startup', (missingName, expectedCode) => {
    const env = {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: 'Arcanos-pr-1395',
    };
    delete env[missingName];

    expect(() => resolvePassivePrPreviewOrThrow(['--pr-preview-safe'], env)).toThrow(expectedCode);
  });

  it('rejects extra launcher arguments in passive preview mode', () => {
    expect(() => resolvePassivePrPreviewOrThrow(['--pr-preview-safe', '--unexpected'], {
      RAILWAY_PROJECT_ID: 'project-id',
      RAILWAY_ENVIRONMENT_ID: 'environment-id',
      RAILWAY_ENVIRONMENT_NAME: 'Arcanos-pr-1395',
    })).toThrow('PREVIEW_ISOLATION_ARGUMENT_INVALID');
  });

  it.each(['web', 'worker'])('serves only passive health endpoints for %s without starting an application runtime', async (processKind) => {
    const server = createPassivePrPreviewServer(processKind);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      expect(address && typeof address === 'object').toBe(true);
      const origin = `http://127.0.0.1:${address.port}`;

      const healthResponse = await fetch(`${origin}/health`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.text()).toBe('ok');

      const readinessResponse = await fetch(`${origin}/readyz`);
      expect(readinessResponse.status).toBe(200);
      expect(await readinessResponse.json()).toEqual({
        ready: true,
        mode: 'passive-pr-preview',
        processKind,
      });

      const protectedResponse = await fetch(`${origin}/api/plans`);
      expect(protectedResponse.status).toBe(404);
      expect(await protectedResponse.text()).toBe('not found');

      const mutatingHealthResponse = await fetch(`${origin}/health`, { method: 'POST' });
      expect(mutatingHealthResponse.status).toBe(404);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('keeps preview isolation inert unless explicitly enabled', () => {
    expect(assertPreviewIsolationOrThrow({
      RAILWAY_ENVIRONMENT_NAME: 'production',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    })).toEqual({ enabled: false });
  });

  it.each(['false', 'TRUE', '1', 'tru'])('fails closed when the preview marker is present but invalid: %s', marker => {
    expect(() => assertPreviewIsolationOrThrow({
      ARCANOS_PREVIEW_ISOLATION: marker,
      RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
      FORCE_MOCK: 'true',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    })).toThrow('PREVIEW_ISOLATION_MARKER_INVALID');
  });

  it.each([
    'http://127.0.0.1:9/v1',
    'http://localhost:9/v1',
    'http://[::1]:9/v1',
  ])('accepts explicit preview isolation with loopback provider %s', (baseUrl) => {
    expect(assertPreviewIsolationOrThrow({
      ARCANOS_PREVIEW_ISOLATION: 'true',
      RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
      FORCE_MOCK: 'true',
      OPENAI_BASE_URL: baseUrl,
    })).toEqual({
      enabled: true,
      environmentCategory: 'non-production',
      providerCategory: 'loopback',
    });
  });

  it.each([
    {
      name: 'production target',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'production',
        FORCE_MOCK: 'true',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      },
      expectedCode: 'PREVIEW_ISOLATION_PRODUCTION_FORBIDDEN',
    },
    {
      name: 'mock mode disabled',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'false',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      },
      expectedCode: 'PREVIEW_ISOLATION_FORCE_MOCK_REQUIRED',
    },
    {
      name: 'provider base missing',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'true',
      },
      expectedCode: 'PREVIEW_ISOLATION_OPENAI_BASE_URL_REQUIRED',
    },
    {
      name: 'provider base malformed',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'true',
        OPENAI_BASE_URL: 'not-a-url',
      },
      expectedCode: 'PREVIEW_ISOLATION_OPENAI_BASE_URL_INVALID',
    },
    {
      name: 'external provider host',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'true',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
      expectedCode: 'PREVIEW_ISOLATION_OPENAI_BASE_URL_NOT_LOOPBACK',
    },
    {
      name: 'loopback lookalike host',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'true',
        OPENAI_BASE_URL: 'http://localhost.example.com:9/v1',
      },
      expectedCode: 'PREVIEW_ISOLATION_OPENAI_BASE_URL_NOT_LOOPBACK',
    },
    {
      name: 'credential-bearing loopback URL',
      partialEnv: {
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'true',
        OPENAI_BASE_URL: 'http://user:credential-sentinel@127.0.0.1:9/v1',
      },
      expectedCode: 'PREVIEW_ISOLATION_OPENAI_BASE_URL_CREDENTIALS_FORBIDDEN',
    },
  ])('rejects unsafe preview startup: $name', ({ partialEnv, expectedCode }) => {
    const env = {
      ARCANOS_PREVIEW_ISOLATION: 'true',
      ...partialEnv,
    };

    expect(() => assertPreviewIsolationOrThrow(env)).toThrow(expectedCode);
    try {
      assertPreviewIsolationOrThrow(env);
    } catch (error) {
      const serializedError = String(error);
      expect(serializedError).not.toContain('credential-sentinel');
      expect(serializedError).not.toContain('api.openai.com');
      expect(serializedError).not.toContain('/v1');
    }
  });

  it('uses the first configured provider URL alias and rejects precedence bypasses', () => {
    expect(() => assertPreviewIsolationOrThrow({
      ARCANOS_PREVIEW_ISOLATION: 'true',
      RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
      FORCE_MOCK: 'true',
      OPENAI_BASE_URL: 'https://external.invalid/v1',
      OPENAI_API_BASE_URL: 'http://127.0.0.1:9/v1',
    })).toThrow('PREVIEW_ISOLATION_OPENAI_BASE_URL_NOT_LOOPBACK');

    expect(() => assertPreviewIsolationOrThrow({
      ARCANOS_PREVIEW_ISOLATION: 'true',
      RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
      FORCE_MOCK: 'true',
      RAILWAY_OPENAI_BASE_URL: 'https://railway-external.invalid/v1',
      OPENAI_API_BASE_URL: 'http://127.0.0.1:9/v1',
    })).toThrow('PREVIEW_ISOLATION_OPENAI_BASE_URL_NOT_LOOPBACK');
  });

  it('fails preview preflight before spawning a runtime and omits stack paths', () => {
    const repositoryRoot = process.cwd();
    const result = spawnSync(process.execPath, ['scripts/start-railway-service.mjs'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARCANOS_PROCESS_KIND: 'web',
        ARCANOS_PREVIEW_ISOLATION: 'true',
        RAILWAY_ENVIRONMENT_NAME: 'phase2d-validation-20260717',
        FORCE_MOCK: 'false',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Starting process');
    expect(result.stdout).not.toContain('starting web runtime');
    expect(result.stderr).toContain('PREVIEW_ISOLATION_FORCE_MOCK_REQUIRED');
    expect(result.stderr).not.toContain(repositoryRoot);
    expect(result.stderr).not.toContain('start-railway-service.mjs:');
  });

  it.each([
    {
      name: 'malformed listener',
      processKind: 'web',
      port: 'credential-sentinel-port',
      expectedCode: 'PREVIEW_ISOLATION_LISTENER_INVALID',
    },
    {
      name: 'malformed process kind',
      processKind: 'credential-sentinel-kind',
      port: '8080',
      expectedCode: 'PREVIEW_ISOLATION_PROCESS_KIND_INVALID',
    },
  ])('keeps passive PR startup failures non-sensitive: $name', ({ processKind, port, expectedCode }) => {
    const repositoryRoot = process.cwd();
    const result = spawnSync(process.execPath, ['scripts/start-railway-service.mjs'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARCANOS_PROCESS_KIND: processKind,
        RAILWAY_PROJECT_ID: 'project-id',
        RAILWAY_ENVIRONMENT_ID: 'environment-id',
        RAILWAY_ENVIRONMENT_NAME: 'Arcanos-pr-1395',
        RAILWAY_SERVICE_NAME: 'credential-sentinel-service',
        NODE_ENV: 'credential-sentinel-node-env',
        PORT: port,
      },
      encoding: 'utf8',
    });

    const transcript = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(transcript).toContain(expectedCode);
    expect(transcript).not.toContain('credential-sentinel');
    expect(transcript).not.toContain(repositoryRoot);
    expect(transcript).not.toContain('start-railway-service.mjs:');
    expect(transcript).not.toContain('starting web runtime');
    expect(transcript).not.toContain('starting worker runtime');
  });

  it('resolves one validated worker health listener with Railway-safe defaults', () => {
    expect(resolveHealthListenerConfig({})).toEqual({
      port: 8080,
      host: '0.0.0.0',
    });

    expect(resolveHealthListenerConfig({ PORT: '4123', HOST: '127.0.0.1' })).toEqual({
      port: 4123,
      host: '127.0.0.1',
    });
  });

  it('rejects malformed worker health ports instead of silently rebinding', () => {
    expect(() => resolveHealthListenerConfig({ PORT: 'abc' })).toThrow(/PORT must be an integer/);
    expect(() => resolveHealthListenerConfig({ PORT: '70000' })).toThrow(/PORT must be an integer/);
    expect(() => resolveHealthListenerConfig({ PORT: '08080' })).toThrow(/PORT must be an integer/);
  });

  it('resolves the CLI daemon listener as loopback-only with a required token', () => {
    expect(resolveCliBridgeListenerConfig({
      ARCANOS_CLI_BRIDGE_TOKEN: 'test-token',
    })).toEqual({
      host: '127.0.0.1',
      port: 8765,
      tokenPresent: true,
    });

    expect(resolveCliBridgeListenerConfig({
      ARCANOS_CLI_BRIDGE_URL: 'http://localhost:9999',
      ARCANOS_CLI_BRIDGE_TOKEN: 'test-token',
    })).toEqual({
      host: 'localhost',
      port: 9999,
      tokenPresent: true,
    });

    expect(resolveCliBridgeListenerConfig({
      ARCANOS_CLI_BRIDGE_URL: 'http://[::1]:9876',
      ARCANOS_CLI_BRIDGE_TOKEN: 'test-token',
    })).toEqual({
      host: '::1',
      port: 9876,
      tokenPresent: true,
    });
  });

  it('rejects unsafe CLI daemon listener configuration', () => {
    expect(() => resolveCliBridgeListenerConfig({
      ARCANOS_CLI_BRIDGE_URL: 'http://0.0.0.0:8765',
      ARCANOS_CLI_BRIDGE_TOKEN: 'test-token',
    })).toThrow(/HTTP loopback/);
    expect(() => resolveCliBridgeListenerConfig({
      ARCANOS_CLI_BRIDGE_URL: 'https://127.0.0.1:8765',
      ARCANOS_CLI_BRIDGE_TOKEN: 'test-token',
    })).toThrow(/HTTP loopback/);
    expect(() => resolveCliBridgeListenerConfig({
      ARCANOS_CLI_BRIDGE_URL: 'http://127.0.0.1:8765',
    })).toThrow(/ARCANOS_CLI_BRIDGE_TOKEN/);
  });

  it('keeps worker readiness unavailable until bootstrap evidence is observed', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });

    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: {
        ready: false,
        reason: 'worker_bootstrap_pending',
        checks: {
          bootstrap: 'unknown',
          database: 'unknown',
          provider: 'configured',
        },
      },
    });

    recordWorkerOutput(readiness, 'worker-runtime polling loop started\n');
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine());
    recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);
    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 200,
      body: {
        ready: true,
        reason: null,
        checks: {
          bootstrap: 'ready',
          database: 'ready',
          provider: 'configured',
        },
      },
    });
  });

  it('serves no-store worker readiness across bootstrap, success, and child exit', async () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    const server = createWorkerHealthServer(readiness);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      expect(address && typeof address === 'object').toBe(true);
      const origin = `http://127.0.0.1:${address.port}`;

      const pending = await fetch(`${origin}/readyz`);
      expect(pending.status).toBe(503);
      expect(pending.headers.get('cache-control')).toBe('no-store');
      expect(await pending.json()).toMatchObject({
        ready: false,
        reason: 'worker_bootstrap_pending',
      });

      const pendingHead = await fetch(`${origin}/readyz`, { method: 'HEAD' });
      expect(pendingHead.status).toBe(503);
      expect(pendingHead.headers.get('cache-control')).toBe('no-store');
      expect(await pendingHead.text()).toBe('');

      const liveness = await fetch(`${origin}/health`);
      expect(liveness.status).toBe(200);
      expect(await liveness.text()).toBe('ok');

      recordWorkerOutput(readiness, buildWorkerOperationalStateLine());
      recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);
      const ready = await fetch(`${origin}/readyz`);
      expect(ready.status).toBe(200);
      expect(ready.headers.get('cache-control')).toBe('no-store');
      expect(await ready.json()).toMatchObject({
        ready: true,
        status: 'ready',
        reason: null,
      });

      recordWorkerShutdown(readiness, 'SIGTERM');
      const draining = await fetch(`${origin}/readyz`);
      expect(draining.status).toBe(503);
      expect(draining.headers.get('cache-control')).toBe('no-store');
      expect(await draining.json()).toMatchObject({
        ready: false,
        child: 'draining',
        reason: 'worker_shutdown_requested',
      });

      recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);
      expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);

      recordWorkerExit(readiness, 1, null);
      const exited = await fetch(`${origin}/readyz`);
      expect(exited.status).toBe(503);
      expect(exited.headers.get('cache-control')).toBe('no-store');
      expect(await exited.json()).toMatchObject({
        ready: false,
        child: 'exited',
        reason: 'worker_exited_code_1',
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('detects worker readiness markers split across output chunks', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    const splitIndex = Math.floor(WORKER_BOOTSTRAP_READY_SENTINEL.length / 2);

    recordWorkerOutput(readiness, WORKER_BOOTSTRAP_READY_SENTINEL.slice(0, splitIndex));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);

    recordWorkerOutput(readiness, WORKER_BOOTSTRAP_READY_SENTINEL.slice(splitIndex));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);

    recordWorkerOutput(readiness, '\r\n');
    recordWorkerOutput(readiness, buildWorkerOperationalStateLine());
    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 200,
      body: {
        ready: true,
        reason: null,
        checks: {
          bootstrap: 'ready',
          database: 'ready',
          provider: 'configured',
        },
      },
    });
  });

  it('accepts only the exact stdout readiness protocol line', () => {
    expect(WORKER_BOOTSTRAP_READY_SENTINEL).toBe(JOB_RUNNER_BOOTSTRAP_READY_SENTINEL);

    const embeddedMarkerReadiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    recordWorkerOutput(
      embeddedMarkerReadiness,
      `worker startup failed while discussing ${WORKER_BOOTSTRAP_READY_SENTINEL}\n`,
    );
    expect(buildWorkerReadinessResponse(embeddedMarkerReadiness).statusCode).toBe(503);

    const stderrReadiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    const stderr = new EventEmitter();
    const destination = new EventEmitter();
    destination.write = jest.fn().mockReturnValue(true);
    mirrorAndObserveWorkerOutput(stderr, destination, stderrReadiness, {
      observeReadiness: false,
    });

    stderr.emit('data', Buffer.from(`${WORKER_BOOTSTRAP_READY_SENTINEL}\n`));

    expect(destination.write).toHaveBeenCalled();
    expect(buildWorkerReadinessResponse(stderrReadiness).statusCode).toBe(503);
  });

  it('revokes and restores readiness for shared slot budget, RSS, and dependency states', () => {
    const readiness = createWorkerReadinessState({
      OPENAI_API_KEY: 'sk-test',
      JOB_WORKER_CONCURRENCY: '2',
    });
    const retryAt = '2026-08-30T15:00:00.000Z';

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-1',
    }));
    recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);
    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: {
        ready: false,
        reason: 'worker_claim_acceptance_pending',
        checks: { queueAcceptance: 'unknown' },
      },
    });

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-2',
    }));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(200);

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-2',
      sequence: 2,
      state: 'paused_budget',
      reason: 'ai_calls_per_hour_exceeded:120',
      retryAt,
    }));
    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: {
        ready: false,
        reason: 'ai_calls_per_hour_exceeded:120',
        retryAt,
        checks: { queueAcceptance: 'paused_budget' },
      },
    });

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-2',
      sequence: 1,
      state: 'accepting_claims',
    }));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);
    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-2',
      sequence: 3,
      state: 'accepting_claims',
    }));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(200);

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-1',
      sequence: 2,
      state: 'paused_rss',
      reason: 'rss_mb_limit_exceeded:2048',
    }));
    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: { checks: { queueAcceptance: 'paused_rss' } },
    });
    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-1',
      sequence: 3,
      state: 'accepting_claims',
    }));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(200);

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-1',
      sequence: 4,
      state: 'dependency_failure',
      reason: 'worker_budget_database_unavailable',
    }));
    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: { checks: { queueAcceptance: 'dependency_failure' } },
    });
    recordWorkerOutput(readiness, buildWorkerOperationalStateLine({
      workerId: 'async-queue-slot-1',
      sequence: 5,
      state: 'accepting_claims',
    }));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(200);
  });

  it('uses the runtime positive-integer cascade for the expected worker slot count', () => {
    expect(createWorkerReadinessState({
      OPENAI_API_KEY: 'sk-test',
      JOB_WORKER_CONCURRENCY: '2',
      WORKER_COUNT: '3',
    }).expectedSlotCount).toBe(2);
    expect(createWorkerReadinessState({
      OPENAI_API_KEY: 'sk-test',
      JOB_WORKER_CONCURRENCY: 'invalid',
      WORKER_COUNT: '3',
    }).expectedSlotCount).toBe(3);
    expect(createWorkerReadinessState({
      OPENAI_API_KEY: 'sk-test',
      JOB_WORKER_CONCURRENCY: '0',
      WORKER_COUNT: '-1',
    }).expectedSlotCount).toBe(1);
  });

  it('handles coalesced and split operational messages and ignores malformed protocol lines', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    const acceptingLine = buildWorkerOperationalStateLine();
    const splitAt = Math.floor(acceptingLine.length / 2);

    recordWorkerOutput(readiness, acceptingLine.slice(0, splitAt));
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);
    recordWorkerOutput(
      readiness,
      `${acceptingLine.slice(splitAt)}${WORKER_BOOTSTRAP_READY_SENTINEL}\n`,
    );
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(200);

    recordWorkerOutput(
      readiness,
      `${WORKER_OPERATIONAL_STATE_PREFIX}{"workerId":"slot","sequence":2}\n`,
    );
    recordWorkerOutput(
      readiness,
      `${WORKER_OPERATIONAL_STATE_PREFIX}${'x'.repeat(3_000)}\n`,
    );
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(200);
  });

  it('does not mark worker ready when provider configuration is missing', () => {
    const readiness = createWorkerReadinessState({});

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine());
    recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);

    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: {
        ready: false,
        reason: 'openai_api_key_missing',
        checks: {
          bootstrap: 'ready',
          database: 'ready',
          provider: 'missing',
        },
      },
    });
  });

  it('accepts supported OpenAI key aliases for worker provider readiness', () => {
    const readiness = createWorkerReadinessState({ RAILWAY_OPENAI_API_KEY: 'sk-railway-test' });

    recordWorkerOutput(readiness, buildWorkerOperationalStateLine());
    recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);

    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 200,
      body: {
        ready: true,
        reason: null,
        checks: {
          provider: 'configured',
        },
      },
    });
  });

  it('marks readiness unavailable after worker exit', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);

    recordWorkerExit(readiness, 1, null);

    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: {
        ready: false,
        child: 'exited',
        reason: 'worker_exited_code_1',
      },
    });
  });

  it('keeps worker readiness unavailable when late output arrives after child exit', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });

    recordWorkerExit(readiness, 1, null);
    recordWorkerOutput(readiness, `${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);

    expect(buildWorkerReadinessResponse(readiness)).toMatchObject({
      statusCode: 503,
      body: {
        ready: false,
        child: 'exited',
        reason: 'worker_exited_code_1',
      },
    });
  });

  it('pauses worker output mirroring until the destination drains under backpressure', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });
    const source = new EventEmitter();
    source.pause = jest.fn();
    source.resume = jest.fn();
    const destination = new EventEmitter();
    destination.write = jest.fn().mockReturnValueOnce(false);

    mirrorAndObserveWorkerOutput(source, destination, readiness);
    const chunk = Buffer.from('worker output');
    source.emit('data', chunk);

    expect(destination.write).toHaveBeenCalledWith(chunk);
    expect(source.pause).toHaveBeenCalledTimes(1);
    expect(source.resume).not.toHaveBeenCalled();

    destination.emit('drain');
    expect(source.resume).toHaveBeenCalledTimes(1);
  });

  it('resolves an already-exited child instead of waiting for a replayed exit event', async () => {
    const childProcess = new EventEmitter();
    childProcess.exitCode = 17;
    childProcess.signalCode = null;

    await expect(waitForExit(childProcess)).resolves.toBe(17);
    expect(childProcess.listenerCount('exit')).toBe(0);
    expect(childProcess.listenerCount('error')).toBe(0);
  });
});
