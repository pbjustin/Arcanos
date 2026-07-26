import type { Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  authenticateDaemonPlaneRequest,
  extractDaemonAccessToken,
  requireDaemonPlaneAuth,
} from '../src/transport/http/middleware/daemonPlaneAuth.js';
import {
  resolveConfiguredDaemonAccessToken,
} from '../src/shared/security/daemonAccessCredential.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  type PurposeBoundCredentialEnvironmentReader,
  type PurposeBoundCredentialEnvName,
} from '../src/shared/security/purposeBoundCredential.js';

const daemonEnvironmentName = 'ARCANOS_DAEMON_ACCESS_TOKEN';
const daemonToken = 'daemon-plane-access-token-1234567890';
const rotatedDaemonToken = 'rotated-daemon-access-token-1234567890';

const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);

function requestWithHeaders(
  headers: Record<string, unknown>,
  rawHeaders?: unknown[]
): Request {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    headers: normalizedHeaders,
    rawHeaders: rawHeaders ?? Object.entries(normalizedHeaders).flatMap(
      ([name, value]) => [name, typeof value === 'string' ? value : '']
    ),
    header: (name: string) => {
      const value = normalizedHeaders[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    },
  } as unknown as Request;
}

function environmentReader(
  values: Partial<Record<PurposeBoundCredentialEnvName, string>>
): PurposeBoundCredentialEnvironmentReader {
  return (environmentName) => values[environmentName];
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

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

describe('daemon-plane HTTP authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPurposeBoundCredentialEnvironment();
  });

  it.each([
    'd'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH),
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH),
  ])('accepts an exact configured token at a supported length boundary', (token) => {
    expect(resolveConfiguredDaemonAccessToken(environmentReader({
      [daemonEnvironmentName]: token,
    }))).toBe(token);
  });

  it.each([
    undefined,
    '',
    'x'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH - 1),
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1),
    ` ${daemonToken}`,
    `${daemonToken} `,
    `${daemonToken} extra`,
    'change-me',
    'placeholder',
    '<daemon-access-token>',
    'replace-with-a-distinct-strong-token',
  ])('rejects an invalid configured daemon token: %p', (token) => {
    expect(resolveConfiguredDaemonAccessToken(environmentReader({
      ...(token === undefined ? {} : { [daemonEnvironmentName]: token }),
    }))).toBeNull();
  });

  it.each(
    PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.filter(
      (environmentName) => environmentName !== daemonEnvironmentName
    )
  )('rejects daemon-token reuse by the %s credential', (environmentName) => {
    expect(resolveConfiguredDaemonAccessToken(environmentReader({
      [daemonEnvironmentName]: daemonToken,
      [environmentName]: daemonToken,
    }))).toBeNull();
  });

  it('extracts one exact custom-header token', () => {
    expect(extractDaemonAccessToken(requestWithHeaders({
      'x-arcanos-daemon-token': daemonToken,
    }))).toBe(daemonToken);
  });

  it.each([
    ['missing', requestWithHeaders({})],
    ['empty', requestWithHeaders({ 'x-arcanos-daemon-token': '' })],
    ['short', requestWithHeaders({ 'x-arcanos-daemon-token': 's'.repeat(31) })],
    [
      'oversized',
      requestWithHeaders({
        'x-arcanos-daemon-token': 'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1),
      }),
    ],
    ['leading whitespace', requestWithHeaders({ 'x-arcanos-daemon-token': ` ${daemonToken}` })],
    ['trailing whitespace', requestWithHeaders({ 'x-arcanos-daemon-token': `${daemonToken} ` })],
    ['internal whitespace', requestWithHeaders({ 'x-arcanos-daemon-token': `${daemonToken} extra` })],
    ['non-string', requestWithHeaders({ 'x-arcanos-daemon-token': 123 })],
    ['array-valued', requestWithHeaders({ 'x-arcanos-daemon-token': [daemonToken] })],
    [
      'duplicate',
      requestWithHeaders(
        { 'x-arcanos-daemon-token': daemonToken },
        [
          'X-Arcanos-Daemon-Token',
          daemonToken,
          'x-arcanos-daemon-token',
          daemonToken,
        ]
      ),
    ],
  ])('rejects a %s custom-header value', (_label, req) => {
    expect(extractDaemonAccessToken(req)).toBeNull();
  });

  it('accepts only an exact, case-sensitive custom-header credential', () => {
    const configured = environmentReader({
      [daemonEnvironmentName]: daemonToken,
    });

    expect(authenticateDaemonPlaneRequest(
      requestWithHeaders({ 'x-arcanos-daemon-token': daemonToken }),
      configured
    )).toEqual({ ok: true });
    expect(authenticateDaemonPlaneRequest(
      requestWithHeaders({ 'x-arcanos-daemon-token': daemonToken.toUpperCase() }),
      configured
    )).toEqual({ ok: false, reason: 'invalid_auth' });
  });

  it('never promotes alternative carriers into daemon authority', () => {
    const configured = environmentReader({
      [daemonEnvironmentName]: daemonToken,
    });
    const alternativeCarriers = [
      requestWithHeaders({ authorization: `Bearer ${daemonToken}` }),
      requestWithHeaders({ cookie: `daemon_token=${daemonToken}` }),
      requestWithHeaders({ 'x-gpt-id': daemonToken }),
    ];

    for (const request of alternativeCarriers) {
      expect(authenticateDaemonPlaneRequest(request, configured)).toEqual({
        ok: false,
        reason: 'missing_auth',
      });
    }

    expect(authenticateDaemonPlaneRequest(
      requestWithHeaders({
        authorization: 'Bearer test-unrelated-backend-token-1234567890',
        'x-arcanos-daemon-token': daemonToken,
      }),
      configured
    )).toEqual({ ok: true });
  });

  it.each([
    [
      'missing request token',
      requestWithHeaders({}),
      401,
      'DAEMON_AUTH_REQUIRED',
      'warn',
    ],
    [
      'wrong request token',
      requestWithHeaders({ 'x-arcanos-daemon-token': rotatedDaemonToken }),
      401,
      'DAEMON_AUTH_REQUIRED',
      'warn',
    ],
  ] as const)('maps %s to a credential-free no-store denial', (
    label,
    req,
    expectedStatus,
    expectedCode,
    logLevel
  ) => {
    process.env[daemonEnvironmentName] = daemonToken;
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    req.logger = logger as Request['logger'];
    const { res, status, json, setHeader } = responseRecorder();
    const next = jest.fn();

    requireDaemonPlaneAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: expectedCode,
        message: 'A valid daemon-plane access token is required.',
      },
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
    expect(logger[logLevel]).toHaveBeenCalledWith('daemon_plane.http_auth.denied', {
      reason: label === 'missing request token' ? 'missing_auth' : 'invalid_auth',
      statusCode: expectedStatus,
    });
    expect(JSON.stringify(logger[logLevel].mock.calls)).not.toContain(daemonToken);
    expect(JSON.stringify(logger[logLevel].mock.calls)).not.toContain(rotatedDaemonToken);
  });

  it('maps unavailable configuration to a no-store 503 response', () => {
    const req = requestWithHeaders({ 'x-arcanos-daemon-token': daemonToken });
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    req.logger = logger as Request['logger'];
    const { res, status, json, setHeader } = responseRecorder();
    const next = jest.fn();

    requireDaemonPlaneAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'DAEMON_AUTH_UNAVAILABLE',
        message: 'Daemon-plane authentication is unavailable.',
      },
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
    expect(logger.error).toHaveBeenCalledWith('daemon_plane.http_auth.denied', {
      reason: 'configuration_unavailable',
      statusCode: 503,
    });
  });

  it('resolves configuration on every request so rotation and revocation are immediate', () => {
    process.env[daemonEnvironmentName] = daemonToken;
    const oldRequest = requestWithHeaders({
      'x-arcanos-daemon-token': daemonToken,
    });
    const firstResponse = responseRecorder();
    const firstNext = jest.fn();

    requireDaemonPlaneAuth(oldRequest, firstResponse.res, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(oldRequest.daemonToken).toBeUndefined();

    process.env[daemonEnvironmentName] = rotatedDaemonToken;
    const revokedResponse = responseRecorder();
    const revokedNext = jest.fn();
    requireDaemonPlaneAuth(oldRequest, revokedResponse.res, revokedNext);
    expect(revokedNext).not.toHaveBeenCalled();
    expect(revokedResponse.status).toHaveBeenCalledWith(401);

    delete process.env[daemonEnvironmentName];
    const unavailableResponse = responseRecorder();
    requireDaemonPlaneAuth(
      requestWithHeaders({ 'x-arcanos-daemon-token': rotatedDaemonToken }),
      unavailableResponse.res,
      jest.fn()
    );
    expect(unavailableResponse.status).toHaveBeenCalledWith(503);
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
});
