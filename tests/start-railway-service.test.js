import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  buildWorkerReadinessResponse,
  createWorkerReadinessState,
  mirrorAndObserveWorkerOutput,
  recordWorkerExit,
  recordWorkerOutput,
  resolveHealthListenerConfig,
} from '../scripts/start-railway-service.mjs';

describe('start-railway-service launcher helpers', () => {
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
