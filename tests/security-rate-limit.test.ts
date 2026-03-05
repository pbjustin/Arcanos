import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { createRateLimitMiddleware } from '../src/platform/runtime/security.js';

function createMockRequest(ip: string): Request {
  return {
    ip,
    connection: { remoteAddress: ip },
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

  it('purges expired entries via interval cleanup instead of request-path sweeps', () => {
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
});
