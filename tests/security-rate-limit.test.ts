import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import {
  createRateLimitMiddleware,
  getRequestActorKey
} from '../src/platform/runtime/security.js';

function createMockRequest(
  ip: string,
  options: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    authUser?: Request['authUser'];
  } = {}
): Request {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip,
    connection: { remoteAddress: ip },
    body: options.body ?? {},
    params: options.params ?? {},
    query: options.query ?? {},
    authUser: options.authUser,
    header: jest.fn((name: string) => normalizedHeaders[name.toLowerCase()]),
  } as unknown as Request;
}

function createMockResponse(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('createRateLimitMiddleware', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('returns 429 when request count exceeds the configured window limit', () => {
    const middleware = createRateLimitMiddleware(2, 1000);
    const req = createMockRequest('127.0.0.1');
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware(req, res, next);
    middleware(req, res, next);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Rate limit exceeded',
      })
    );
  });

  it('purges expired entries opportunistically on later requests without background timers', () => {
    const middleware = createRateLimitMiddleware(1, 1000);
    const req = createMockRequest('10.0.0.1');
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware(req, res, next);
    jest.advanceTimersByTime(1001);

    middleware(req, res, next);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('does not register background cleanup intervals when middleware is created', () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');

    createRateLimitMiddleware(1, 1000);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('uses session-aware keys so separate sessions on the same IP do not collide', () => {
    const middleware = createRateLimitMiddleware({
      bucketName: 'ask-route',
      maxRequests: 1,
      windowMs: 1000,
      keyGenerator: (req) => `${getRequestActorKey(req)}:route:ask`
    });
    const firstSessionRequest = createMockRequest('203.0.113.10', {
      body: { sessionId: 'session-a' }
    });
    const secondSessionRequest = createMockRequest('203.0.113.10', {
      body: { sessionId: 'session-b' }
    });
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware(firstSessionRequest, res, next);
    middleware(secondSessionRequest, res, next);
    middleware(firstSessionRequest, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('can isolate DAG monitoring buckets per run id for the same actor', () => {
    const middleware = createRateLimitMiddleware({
      bucketName: 'api-arcanos-dag-status',
      maxRequests: 1,
      windowMs: 1000,
      keyGenerator: (req) => `${getRequestActorKey(req)}:run:${req.params.runId}`
    });
    const runARequest = createMockRequest('198.51.100.22', {
      body: { sessionId: 'session-shared' },
      params: { runId: 'run-a' }
    });
    const runBRequest = createMockRequest('198.51.100.22', {
      body: { sessionId: 'session-shared' },
      params: { runId: 'run-b' }
    });
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware(runARequest, res, next);
    middleware(runBRequest, res, next);
    middleware(runARequest, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
