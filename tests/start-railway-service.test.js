import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  buildWorkerReadinessResponse,
  createWorkerReadinessState,
  mirrorAndObserveWorkerOutput,
  recordWorkerExit,
  recordWorkerOutput,
  assertPreviewIsolationOrThrow,
  resolveCliBridgeListenerConfig,
  resolveHealthListenerConfig,
} from '../scripts/start-railway-service.mjs';

describe('start-railway-service launcher helpers', () => {
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

    recordWorkerOutput(readiness, 'worker-runtime polling loop started');
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);

    recordWorkerOutput(readiness, '{"msg":"worker.bootstrap.completed"}');
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

  it('detects worker readiness markers split across output chunks', () => {
    const readiness = createWorkerReadinessState({ OPENAI_API_KEY: 'sk-test' });

    recordWorkerOutput(readiness, 'worker.boot');
    expect(buildWorkerReadinessResponse(readiness).statusCode).toBe(503);

    recordWorkerOutput(readiness, 'strap.completed');
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

  it('does not mark worker ready when provider configuration is missing', () => {
    const readiness = createWorkerReadinessState({});

    recordWorkerOutput(readiness, 'worker.bootstrap.completed');

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

    recordWorkerOutput(readiness, 'worker.bootstrap.completed');

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
    recordWorkerOutput(readiness, 'worker.bootstrap.completed');

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
    recordWorkerOutput(readiness, 'worker.bootstrap.completed');

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
});
