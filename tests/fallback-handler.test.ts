import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  Reflect.set(process.env, name, value);
}

function createMockRequest(path: string): Request {
  return {
    path,
    body: {
      action: 'diagnostics'
    }
  } as Request;
}

function createMockResponse(): Response {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn()
  };
  response.status.mockReturnValue(response);
  return response as unknown as Response;
}

describe('fallback health-check middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalRailwayOpenAiApiKey = process.env.RAILWAY_OPENAI_API_KEY;
  const originalApiKey = process.env.API_KEY;
  const originalOpenAiKey = process.env.OPENAI_KEY;

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    restoreEnvVar('NODE_ENV', originalNodeEnv);
    restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvVar('RAILWAY_OPENAI_API_KEY', originalRailwayOpenAiApiKey);
    restoreEnvVar('API_KEY', originalApiKey);
    restoreEnvVar('OPENAI_KEY', originalOpenAiKey);
  });

  it('does not preempt canonical GPT dispatcher paths in strict production mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = '';
    process.env.RAILWAY_OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    process.env.OPENAI_KEY = '';
    jest.resetModules();

    const { createHealthCheckMiddleware } = await import(
      '../src/transport/http/middleware/fallbackHandler.js'
    );
    const middleware = createHealthCheckMiddleware();
    const req = createMockRequest('/gpt/arcanos-core');
    const res = createMockResponse();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith(
      'x-ai-degraded-reason',
      'fallback_handler_preemptive'
    );
  });

  it.each([
    '/gpt/arcanos-gaming',
    '/gpt/arcanos-gaming/evidence-retry',
    '/gpt/gaming',
    '/gpt/ARCANOS-GAMING/',
    '/gpt/Gaming/'
  ])('does not replace %s route errors with a generic degraded response', async (path) => {
    const { createFallbackMiddleware } = await import(
      '../src/transport/http/middleware/fallbackHandler.js'
    );
    const middleware = createFallbackMiddleware();
    const req = createMockRequest(path);
    const res = createMockResponse();
    const next = jest.fn() as NextFunction;
    const error = Object.assign(new Error('provider timeout'), { status: 504 });

    middleware(error, req, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each([
    '/gpt/arcanos-gaming/evidence-retry/extra',
    '/gpt/arcanos-gaming/unrelated'
  ])('does not broaden the Gaming fallback bypass to %s', async (path) => {
    const { createFallbackMiddleware } = await import(
      '../src/transport/http/middleware/fallbackHandler.js'
    );
    const middleware = createFallbackMiddleware();
    const req = createMockRequest(path);
    const res = createMockResponse();
    const next = jest.fn() as NextFunction;
    const error = Object.assign(new Error('provider timeout'), { status: 504 });

    middleware(error, req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('preserves degraded fallback handling for non-Gaming GPT route errors', async () => {
    const { createFallbackMiddleware } = await import(
      '../src/transport/http/middleware/fallbackHandler.js'
    );
    const middleware = createFallbackMiddleware();
    const req = createMockRequest('/gpt/arcanos-core');
    const res = createMockResponse();
    const next = jest.fn() as NextFunction;
    const error = Object.assign(new Error('provider timeout'), { status: 504 });

    middleware(error, req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'degraded',
      fallbackMode: expect.any(String)
    }));
  });
});
