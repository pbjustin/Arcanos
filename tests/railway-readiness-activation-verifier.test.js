import { describe, expect, it, jest } from '@jest/globals';

import {
  resolveReadinessTarget,
  verifyReadinessActivation,
} from '../scripts/verify-railway-readiness-activation.mjs';

const EXPECTED_IDENTITY = Object.freeze({
  projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  environmentName: 'production',
  serviceId: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
});

function buildVariables(overrides = {}) {
  return {
    RAILWAY_PROJECT_ID: EXPECTED_IDENTITY.projectId,
    RAILWAY_ENVIRONMENT_NAME: EXPECTED_IDENTITY.environmentName,
    RAILWAY_SERVICE_ID: EXPECTED_IDENTITY.serviceId,
    ARCANOS_PROCESS_KIND: 'web',
    RAILWAY_PUBLIC_DOMAIN: 'arcanos-production.up.railway.app',
    ...overrides,
  };
}

function webReadyResponse(overrides = {}) {
  return {
    ready: true,
    status: 'healthy',
    checks: [
      { name: 'openai', healthy: true },
      { name: 'database', healthy: true },
      { name: 'redis', healthy: true },
      { name: 'startup', healthy: true },
    ],
    ...overrides,
  };
}

function response(status, body, headers = {}) {
  return new Response(
    status === 204 ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...headers,
      },
    },
  );
}

describe('Railway readiness activation verifier', () => {
  it('binds a public web readiness request to the exact Railway identity', async () => {
    const fetchImpl = jest.fn(async () => response(200, webReadyResponse()));

    const result = await verifyReadinessActivation({
      variables: buildVariables({
        RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '60',
      }),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl,
      requestTimeoutMs: 500,
    });

    expect(result).toEqual({
      mode: 'direct',
      role: 'web',
      status: 'ready',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://arcanos-production.up.railway.app/readyz',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
      }),
    );
  });

  it('accepts the exact public worker readiness contract', async () => {
    const fetchImpl = jest.fn(async () => response(200, {
      ready: true,
      status: 'ready',
      child: 'running',
      checks: {
        bootstrap: 'ready',
        database: 'ready',
        provider: 'configured',
      },
      reason: null,
    }));

    const result = await verifyReadinessActivation({
      variables: buildVariables({
        ARCANOS_PROCESS_KIND: 'worker',
        RAILWAY_SERVICE_ID: '1765befb-b805-4051-9af9-28634e986886',
        RAILWAY_PUBLIC_DOMAIN: 'arcanos-worker-production.up.railway.app',
      }),
      expectedIdentity: {
        ...EXPECTED_IDENTITY,
        serviceId: '1765befb-b805-4051-9af9-28634e986886',
      },
      fetchImpl,
      requestTimeoutMs: 500,
    });

    expect(result).toEqual({
      mode: 'direct',
      role: 'worker',
      status: 'ready',
    });
  });

  it('uses Railway activation evidence for a private worker without exposing a domain', async () => {
    const fetchImpl = jest.fn();

    const result = await verifyReadinessActivation({
      variables: buildVariables({
        ARCANOS_PROCESS_KIND: 'worker',
        RAILWAY_PUBLIC_DOMAIN: '',
      }),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl,
      requestTimeoutMs: 500,
    });

    expect(result).toEqual({
      mode: 'platform',
      role: 'worker',
      status: 'ready',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['http://arcanos-production.up.railway.app', 'scheme'],
    ['user@arcanos-production.up.railway.app', 'userinfo'],
    ['arcanos-production.up.railway.app/other', 'path'],
    ['arcanos-production.up.railway.app?target=other', 'query'],
    ['arcanos-production.up.railway.app#other', 'fragment'],
    ['localhost', 'non-Railway host'],
  ])('rejects a non-canonical public domain containing %s', (domain) => {
    expect(() => resolveReadinessTarget(buildVariables({
      RAILWAY_PUBLIC_DOMAIN: domain,
    }), EXPECTED_IDENTITY)).toThrow('RAILWAY_READINESS_TARGET_INVALID');
  });

  it('fails closed when a web service has no public readiness target', () => {
    expect(() => resolveReadinessTarget(buildVariables({
      RAILWAY_PUBLIC_DOMAIN: '',
    }), EXPECTED_IDENTITY)).toThrow('RAILWAY_WEB_READINESS_TARGET_MISSING');
  });

  it('rejects Railway identity drift before making a request', async () => {
    const fetchImpl = jest.fn();

    await expect(verifyReadinessActivation({
      variables: buildVariables({
        RAILWAY_SERVICE_ID: '00000000-0000-4000-8000-000000000000',
      }),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl,
      requestTimeoutMs: 500,
    })).rejects.toThrow('RAILWAY_READINESS_IDENTITY_MISMATCH');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a live provider-native drain override before making a request', async () => {
    const fetchImpl = jest.fn();

    await expect(verifyReadinessActivation({
      variables: buildVariables({
        RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '0',
      }),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl,
      requestTimeoutMs: 500,
    })).rejects.toThrow('RAILWAY_READINESS_DRAIN_OVERRIDE_MISMATCH');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [204, webReadyResponse()],
    [200, { ready: true, status: 'healthy', checks: [{ name: 'lookalike', healthy: true }] }],
    [200, webReadyResponse({ ready: false })],
    [200, '{not-json'],
  ])('rejects weak readiness evidence with status %s', async (status, body) => {
    await expect(verifyReadinessActivation({
      variables: buildVariables(),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl: jest.fn(async () => response(status, body)),
      requestTimeoutMs: 500,
    })).rejects.toThrow('RAILWAY_READINESS_RESPONSE_INVALID');
  });

  it.each([
    ['content-type', 'not-application/json-garbage'],
    ['cache-control', 'private="no-store-false"'],
  ])('rejects a lookalike %s header', async (headerName, headerValue) => {
    await expect(verifyReadinessActivation({
      variables: buildVariables(),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl: jest.fn(async () => response(
        200,
        webReadyResponse(),
        { [headerName]: headerValue },
      )),
      requestTimeoutMs: 500,
    })).rejects.toThrow('RAILWAY_READINESS_RESPONSE_INVALID');
  });

  it('bounds the readiness response body', async () => {
    await expect(verifyReadinessActivation({
      variables: buildVariables(),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl: jest.fn(async () => response(200, 'x'.repeat(70_000))),
      requestTimeoutMs: 500,
    })).rejects.toThrow('RAILWAY_READINESS_RESPONSE_TOO_LARGE');
  });

  it('keeps the request timeout active while the response body is being read', async () => {
    const encodedBody = new TextEncoder().encode(JSON.stringify(webReadyResponse()));
    const fetchImpl = jest.fn(async (_url, options) => new Response(
      new ReadableStream({
        start(controller) {
          const delayedBody = setTimeout(() => {
            controller.enqueue(encodedBody);
            controller.close();
          }, 100);
          options.signal.addEventListener('abort', () => {
            clearTimeout(delayedBody);
            controller.error(new DOMException('Request aborted', 'AbortError'));
          }, { once: true });
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    ));

    await expect(verifyReadinessActivation({
      variables: buildVariables(),
      expectedIdentity: EXPECTED_IDENTITY,
      fetchImpl,
      requestTimeoutMs: 10,
    })).rejects.toThrow('RAILWAY_READINESS_REQUEST_FAILED');
  });
});
