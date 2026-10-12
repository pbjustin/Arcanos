import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  getRequestAuthenticatedActorKey,
  getRequestClientAddress,
} from '../src/platform/runtime/security.js';

function createMockRequest(
  ip: string,
  options: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    authUser?: Request['authUser'];
    authenticatedActorKey?: string;
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
    authenticatedActorKey: options.authenticatedActorKey,
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

  it('ignores untrusted forwarding headers instead of changing the client identity', async () => {
    jest.useRealTimers();
    const app = express();
    app.get('/identity', (req, res) => {
      res.json({ address: getRequestClientAddress(req), expressAddress: req.ip });
    });

    const result = await request(app).get('/identity')
      .set('X-Forwarded-For', '198.51.100.77, 10.0.0.2')
      .set('X-Real-IP', '198.51.100.78')
      .set('Forwarded', 'for=198.51.100.79');

    expect(result.body.address).toBe(result.body.expressAddress);
    expect(result.body.address).not.toBe('198.51.100.77');
  });

  it('uses the first untrusted hop from an explicitly trusted proxy chain', async () => {
    jest.useRealTimers();
    const app = express();
    app.set('trust proxy', (address: string) => (
      ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.2'].includes(address)
    ));
    app.get('/identity', (req, res) => res.json({ address: getRequestClientAddress(req) }));

    const result = await request(app).get('/identity')
      .set('X-Forwarded-For', '198.51.100.77, 203.0.113.21, 10.0.0.2');

    expect(result.body.address).toBe('203.0.113.21');
  });

  it('does not let session, credential, or forwarding-header rotation bypass the default ceiling', () => {
    const middleware = createRateLimitMiddleware(1, 1000);
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;
    for (let index = 0; index < 3; index += 1) {
      middleware(createMockRequest('203.0.113.10', {
        body: { sessionId: `session-${index}` },
        query: { sessionId: `query-session-${index}` },
        headers: {
          authorization: `Bearer invalid-credential-${index}`,
          'x-session-id': `header-session-${index}`,
          'mcp-session-id': `mcp-session-${index}`,
          'x-forwarded-for': `198.51.100.${index + 1}`,
        },
      }), res, next);
    }

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('keeps the authenticated identity stable across sessions and addresses', () => {
    const middleware = createRateLimitMiddleware(1, 1000);
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;
    middleware(createMockRequest('203.0.113.10', {
      authenticatedActorKey: 'principal:verified-a',
      headers: { 'x-session-id': 'session-a' },
    }), res, next);
    middleware(createMockRequest('203.0.113.11', {
      authenticatedActorKey: 'principal:verified-a',
      headers: { 'x-session-id': 'session-b' },
    }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledTimes(1);
    middleware(createMockRequest('203.0.113.10', {
      authenticatedActorKey: 'principal:verified-b',
      headers: { 'x-session-id': 'session-a' },
    }), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledTimes(1);
  });

  it('fails closed at the active-entry cap without evicting an exhausted actor and recovers after expiry', () => {
    const options = { maxRequests: 1, windowMs: 1000, maxEntries: 2 };
    const middleware = createRateLimitMiddleware(options);
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware(createMockRequest('203.0.113.1'), res, next);
    middleware(createMockRequest('203.0.113.2'), res, next);
    middleware(createMockRequest('203.0.113.3'), res, next);
    middleware(createMockRequest('203.0.113.1'), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledTimes(2);
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Retry-After': '1' }));

    jest.advanceTimersByTime(1000);
    middleware(createMockRequest('203.0.113.3'), res, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('reports retained counter expiry when a full map cannot recover at the next cleanup', () => {
    const startedAt = Date.now();
    const middleware = createRateLimitMiddleware({
      maxRequests: 1,
      windowMs: 15 * 60 * 1000,
      maxEntries: 2,
    });
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;
    const overflow = createMockRequest('203.0.113.3');

    middleware(createMockRequest('203.0.113.1'), res, next);
    middleware(createMockRequest('203.0.113.2'), res, next);
    middleware(overflow, res, next);

    expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({
      'Retry-After': '900',
      'X-RateLimit-Reset': new Date(startedAt + 900_000).toISOString(),
    }));
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ retryAfter: 900 }));

    jest.advanceTimersByTime(60_000);
    middleware(overflow, res, next);
    expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({ 'Retry-After': '840' }));
    middleware(createMockRequest('203.0.113.1'), res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledTimes(3);

    jest.advanceTimersByTime(840_000);
    middleware(overflow, res, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('uses the earliest varied window and waits for eligible cleanup before reusing capacity', () => {
    const startedAt = Date.now();
    const middleware = createRateLimitMiddleware({
      maxRequests: 1,
      windowMs: 15 * 60 * 1000,
      maxEntries: 2,
      policyResolver: (req, policy) => ({
        ...policy,
        windowMs: req.body.windowMs ?? policy.windowMs,
      }),
    });
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;
    const overflow = createMockRequest('203.0.113.3');

    middleware(createMockRequest('203.0.113.1'), res, next);
    middleware(createMockRequest('203.0.113.2', { body: { windowMs: 90_000 } }), res, next);
    middleware(overflow, res, next);
    expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({
      'Retry-After': '90',
      'X-RateLimit-Reset': new Date(startedAt + 90_000).toISOString(),
    }));

    jest.advanceTimersByTime(60_000);
    middleware(overflow, res, next);
    jest.advanceTimersByTime(30_000);
    middleware(overflow, res, next);
    expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({
      'Retry-After': '30',
      'X-RateLimit-Reset': new Date(startedAt + 120_000).toISOString(),
    }));
    expect(next).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30_000);
    middleware(overflow, res, next);
    expect(next).toHaveBeenCalledTimes(3);
    middleware(createMockRequest('203.0.113.4'), res, next);
    expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({
      'Retry-After': '780',
      'X-RateLimit-Reset': new Date(startedAt + 900_000).toISOString(),
    }));
    middleware(createMockRequest('203.0.113.1'), res, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('recomputes an extended earliest expiry once and reuses it across repeated overflow', () => {
    const startedAt = Date.now();
    const middleware = createRateLimitMiddleware({
      maxRequests: 1,
      windowMs: 15 * 60 * 1000,
      maxEntries: 2,
      policyResolver: (req, policy) => ({
        ...policy,
        windowMs: req.body.windowMs ?? policy.windowMs,
      }),
    });
    const res = createMockResponse();
    const next = jest.fn() as unknown as NextFunction;
    middleware(createMockRequest('203.0.113.1', { body: { windowMs: 1000 } }), res, next);
    middleware(createMockRequest('203.0.113.2'), res, next);
    middleware(createMockRequest('203.0.113.3'), res, next);
    expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({ 'Retry-After': '60' }));

    jest.advanceTimersByTime(1000);
    middleware(createMockRequest('203.0.113.1'), res, next);
    const mapValuesSpy = jest.spyOn(Map.prototype, 'values');
    try {
      for (let index = 0; index < 20; index += 1) {
        middleware(createMockRequest(`198.51.100.${index + 1}`), res, next);
        expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({
          'Retry-After': '899',
          'X-RateLimit-Reset': new Date(startedAt + 900_000).toISOString(),
        }));
      }
      expect(mapValuesSpy).toHaveBeenCalledTimes(1);
    } finally {
      mapValuesSpy.mockRestore();
    }
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('retains only bounded hashes for oversized custom actor keys', () => {
    const middleware = createRateLimitMiddleware({
      keyGenerator: () => 'x'.repeat(100_000),
    });
    const mapSetSpy = jest.spyOn(Map.prototype, 'set');
    middleware(createMockRequest('203.0.113.1'), createMockResponse(), jest.fn());
    const storedKeys = mapSetSpy.mock.calls
      .filter(([, value]) => value && typeof value === 'object' && 'resetTime' in value)
      .map(([key]) => key);
    mapSetSpy.mockRestore();

    expect(storedKeys).toHaveLength(1);
    expect(String(storedKeys[0]).length).toBe(64);
    expect(storedKeys[0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('preserves explicitly selected session-scoped compatibility buckets', () => {
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

  it('binds authenticated actors to credentials before caller-selected sessions', () => {
    const firstSession = createMockRequest('203.0.113.11', {
      headers: {
        authorization: 'Bearer preview-credential',
        'x-session-id': 'caller-selected-a'
      }
    });
    const secondSession = createMockRequest('203.0.113.12', {
      headers: {
        authorization: 'Bearer preview-credential',
        'x-session-id': 'caller-selected-b'
      }
    });

    const firstKey = getRequestAuthenticatedActorKey(firstSession);
    expect(firstKey).toBe(getRequestAuthenticatedActorKey(secondSession));
    expect(firstKey).toMatch(/^auth:[a-f0-9]{16}$/u);
    expect(firstKey).not.toContain('preview-credential');
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
