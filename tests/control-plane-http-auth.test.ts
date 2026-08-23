import type { Request, Response } from 'express';
import { describe, expect, it, jest } from '@jest/globals';

import {
  authenticateControlPlaneHttpRequest,
  CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  controlPlaneHttpAuthenticationMiddleware,
  createControlPlaneHttpAuthenticationMiddleware,
  extractControlPlaneBearerToken,
  requireControlPlaneOperator,
} from '../src/services/controlPlane/httpAuth.js';

const accessToken = 'test-control-plane-http-auth-token-1234567890';

function requestWithAuthorization(value?: string, duplicate = false): Request {
  const rawHeaders = value
    ? duplicate
      ? ['Authorization', value, 'authorization', value]
      : ['Authorization', value]
    : [];

  return {
    rawHeaders,
    header: (name: string) => name.toLowerCase() === 'authorization' ? value : undefined,
  } as unknown as Request;
}

function configuredEnvironment(): NodeJS.ProcessEnv {
  return {
    ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: accessToken,
    ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:control-plane',
    ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read, railway:deploy,railway:read',
  };
}

function responseRecorder(): {
  res: Response;
  status: ReturnType<typeof jest.fn>;
  json: ReturnType<typeof jest.fn>;
  setHeader: ReturnType<typeof jest.fn>;
} {
  const setHeader = jest.fn();
  const json = jest.fn();
  const status = jest.fn();
  const res = {
    setHeader,
    status,
    json,
  } as unknown as Response;
  status.mockReturnValue(res);
  json.mockReturnValue(res);
  return { res, status, json, setHeader };
}

describe('HTTP control-plane authentication', () => {
  it('preserves three-argument Express middleware arity for default and injected authentication', () => {
    const injectedMiddleware = createControlPlaneHttpAuthenticationMiddleware(
      configuredEnvironment()
    );

    expect(controlPlaneHttpAuthenticationMiddleware).toHaveLength(3);
    expect(injectedMiddleware).toHaveLength(3);
  });

  it('maps the purpose-bound credential to a credential-free server principal', () => {
    const result = authenticateControlPlaneHttpRequest(
      requestWithAuthorization(`Bearer ${accessToken}`),
      configuredEnvironment()
    );

    expect(result).toEqual({
      ok: true,
      principal: {
        audience: 'control-plane-http',
        role: 'operator',
        principalId: 'operator:control-plane',
        scopes: ['railway:read', 'railway:deploy'],
      },
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it.each([
    undefined,
    '',
    `bearer ${accessToken}`,
    `Bearer  ${accessToken}`,
    `Bearer ${accessToken} `,
    `Basic ${accessToken}`,
    `Bearer ${accessToken}\nextra`,
    `Bearer ${'ü'.repeat(40)}`,
  ])('rejects a missing or malformed authorization boundary', (value) => {
    expect(extractControlPlaneBearerToken(requestWithAuthorization(value))).toBeNull();
  });

  it('rejects duplicate Authorization headers', () => {
    expect(extractControlPlaneBearerToken(
      requestWithAuthorization(`Bearer ${accessToken}`, true)
    )).toBeNull();
  });

  it('parses a valid header when the raw header collection is unavailable', () => {
    const req = {
      header: (name: string) => name.toLowerCase() === 'authorization'
        ? `Bearer ${accessToken}`
        : undefined,
    } as unknown as Request;

    expect(extractControlPlaneBearerToken(req)).toBe(accessToken);
  });

  it('ignores non-string raw header names', () => {
    const req = {
      rawHeaders: [42, 'ignored'],
      header: (name: string) => name.toLowerCase() === 'authorization'
        ? `Bearer ${accessToken}`
        : undefined,
    } as unknown as Request;

    expect(extractControlPlaneBearerToken(req)).toBe(accessToken);
  });

  it('distinguishes missing and invalid request credentials without exposing them', () => {
    expect(authenticateControlPlaneHttpRequest(
      requestWithAuthorization(),
      configuredEnvironment()
    )).toEqual({
      ok: false,
      reason: 'missing_auth',
    });

    expect(authenticateControlPlaneHttpRequest(
      requestWithAuthorization(`Bearer ${'x'.repeat(40)}`),
      configuredEnvironment()
    )).toEqual({
      ok: false,
      reason: 'invalid_auth',
    });

    expect(authenticateControlPlaneHttpRequest(
      requestWithAuthorization(`Basic ${accessToken}`),
      configuredEnvironment()
    )).toEqual({
      ok: false,
      reason: 'invalid_auth',
    });
  });

  it.each([
    {},
    {
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: accessToken,
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'invalid principal',
      ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read',
    },
    {
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: 'replace-with-a-distinct-strong-token',
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:control-plane',
      ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read',
    },
    {
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: accessToken,
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:control-plane',
      ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read,,railway:deploy',
    },
    {
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: accessToken,
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:control-plane',
      ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read',
      ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN: accessToken,
    },
    {
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN:
        'control-plane-token-with interior-whitespace-1234567890',
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:control-plane',
      ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read',
    },
    {
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN:
        'control-plane-token-with-unicode-üüüüüüüüüüüüüüüü',
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:control-plane',
      ARCANOS_CONTROL_PLANE_SCOPES: 'railway:read',
    },
  ])('fails closed for missing, invalid, or overlapping server configuration', (env) => {
    expect(authenticateControlPlaneHttpRequest(
      requestWithAuthorization(`Bearer ${accessToken}`),
      env
    )).toEqual({
      ok: false,
      reason: 'configuration_unavailable',
    });
  });

  it.each([
    'scope'.repeat(1_000),
    Array.from({ length: 65 }, (_value, index) => `scope:${index}`).join(','),
  ])('rejects oversized control-plane scope configuration', (scopes) => {
    const env = configuredEnvironment();
    env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;

    expect(authenticateControlPlaneHttpRequest(
      requestWithAuthorization(`Bearer ${accessToken}`),
      env
    )).toEqual({
      ok: false,
      reason: 'configuration_unavailable',
    });
  });

  it.each(CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES)(
    'rejects reuse of the %s purpose-bound credential',
    (environmentName) => {
      const env = configuredEnvironment();
      env[environmentName] = accessToken;

      expect(authenticateControlPlaneHttpRequest(
        requestWithAuthorization(`Bearer ${accessToken}`),
        env
      )).toEqual({
        ok: false,
        reason: 'configuration_unavailable',
      });
    }
  );

  it('rejects credential reuse after normalizing surrounding whitespace', () => {
    const env = configuredEnvironment();
    env.ARCANOS_AUTOMATION_SECRET = `  ${accessToken}  `;

    expect(authenticateControlPlaneHttpRequest(
      requestWithAuthorization(`Bearer ${accessToken}`),
      env
    )).toEqual({
      ok: false,
      reason: 'configuration_unavailable',
    });
  });

  it.each([
    {},
    {
      controlPlanePrincipal: {
        audience: 'control-plane-http',
        role: 'viewer',
        principalId: 'operator:wrong-role',
        scopes: [],
      },
    },
  ])('fails closed when operator authorization lacks a valid operator principal', (requestState) => {
    const req = requestState as unknown as Request;
    const { res, status, json, setHeader } = responseRecorder();
    const next = jest.fn();

    requireControlPlaneOperator(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'CONTROL_PLANE_FORBIDDEN',
        message: 'Control-plane operation is not permitted.',
      },
    });
  });

  it('logs authentication denial without recording the credential', () => {
    const originalEnvironment = process.env;
    const testEnvironment = { ...originalEnvironment };
    for (const environmentName of CONTROL_PLANE_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      delete testEnvironment[environmentName];
    }
    Object.assign(testEnvironment, configuredEnvironment());
    process.env = testEnvironment;

    try {
      const logger = {
        warn: jest.fn(),
        error: jest.fn(),
      };
      const req = requestWithAuthorization(`Basic ${accessToken}`);
      req.logger = logger as Request['logger'];
      const { res, status } = responseRecorder();
      const next = jest.fn();

      controlPlaneHttpAuthenticationMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(401);
      expect(logger.warn).toHaveBeenCalledWith('control_plane.http_auth.denied', {
        reason: 'invalid_auth',
        statusCode: 401,
      });
      expect(logger.error).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(accessToken);

      delete process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;
      const unavailableResponse = responseRecorder();
      const unavailableRequest = requestWithAuthorization(`Bearer ${accessToken}`);
      unavailableRequest.logger = logger as Request['logger'];
      controlPlaneHttpAuthenticationMiddleware(
        unavailableRequest,
        unavailableResponse.res,
        next
      );

      expect(unavailableResponse.status).toHaveBeenCalledWith(503);
      expect(logger.error).toHaveBeenCalledWith('control_plane.http_auth.denied', {
        reason: 'configuration_unavailable',
        statusCode: 503,
      });
    } finally {
      process.env = originalEnvironment;
    }
  });
});
