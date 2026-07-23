import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { DependencyUnavailableError } from '../src/platform/runtime/dependencyLifecycle.js';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';

function buildApp(path: string) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'req-redis-gate';
    req.traceId = 'trace-redis-gate';
    next();
  });
  app.get(path, () => {
    const error = new DependencyUnavailableError(
      'redis',
      'REDIS_DEPENDENCY_UNAVAILABLE',
      'Redis dependency is unavailable.'
    ) as DependencyUnavailableError & { cause?: Error };
    error.cause = new Error('redis://user:secret@private.internal:6379');
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe('dependency unavailable HTTP semantics', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a stable sanitized 503 without logging a stack or raw cause', async () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await request(buildApp('/redis-required')).get('/redis-required');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Service Unavailable',
      code: 'REDIS_DEPENDENCY_UNAVAILABLE',
      requestId: 'req-redis-gate',
      traceId: 'trace-redis-gate'
    });
    const serializedLogs = JSON.stringify(consoleLog.mock.calls);
    expect(serializedLogs).not.toContain('private.internal');
    expect(serializedLogs).not.toContain('secret');
    expect(serializedLogs).not.toContain('dependency-unavailable-http.test');
  });

  it('preserves the public GPT error envelope with the same stable code', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await request(buildApp('/gpt/arcanos-core')).get('/gpt/arcanos-core');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      requestId: 'req-redis-gate',
      traceId: 'trace-redis-gate',
      error: {
        code: 'REDIS_DEPENDENCY_UNAVAILABLE',
        message: 'Redis dependency is unavailable.'
      }
    });
  });
});
