import type { Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  authenticateMemoryPlaneRequest,
  extractMemoryAccessToken,
  requireMemoryPlaneAuth,
} from '../src/transport/http/middleware/memoryPlaneAuth.js';
import {
  resolveConfiguredMemoryAccessToken,
} from '../src/shared/security/memoryAccessCredential.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  type PurposeBoundCredentialEnvironmentReader,
  type PurposeBoundCredentialEnvName,
} from '../src/shared/security/purposeBoundCredential.js';

const memoryEnvironmentName = 'ARCANOS_MEMORY_ACCESS_TOKEN';
const memoryToken = 'memory-plane-access-token-1234567890';
const rotatedMemoryToken = 'rotated-memory-access-token-1234567890';

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

describe('memory-plane HTTP authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPurposeBoundCredentialEnvironment();
  });

  it.each([
    'm'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH),
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH),
  ])('accepts an exact configured token at a supported length boundary', (token) => {
    expect(resolveConfiguredMemoryAccessToken(environmentReader({
      [memoryEnvironmentName]: token,
    }))).toBe(token);
  });

  it.each([
    undefined,
    '',
    'x'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH - 1),
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1),
    ` ${memoryToken}`,
    `${memoryToken} `,
    `${memoryToken} extra`,
    'change-me',
    'placeholder',
    '<memory-access-token>',
    'replace-with-a-distinct-strong-token',
  ])('rejects an invalid configured memory token: %p', (token) => {
    expect(resolveConfiguredMemoryAccessToken(environmentReader({
      ...(token === undefined ? {} : { [memoryEnvironmentName]: token }),
    }))).toBeNull();
  });

  it.each(
    PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.filter(
      (environmentName) => environmentName !== memoryEnvironmentName
    )
  )('rejects memory-token reuse by the %s credential', (environmentName) => {
    expect(resolveConfiguredMemoryAccessToken(environmentReader({
      [memoryEnvironmentName]: memoryToken,
      [environmentName]: memoryToken,
    }))).toBeNull();
  });

  it.each([
    'h'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH),
    memoryToken,
    'h'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH),
  ])('extracts one exact custom-header token: %p', (token) => {
    expect(extractMemoryAccessToken(requestWithHeaders({
      'x-arcanos-memory-token': token,
    }))).toBe(token);
  });

  it.each([
    ['missing', requestWithHeaders({})],
    ['empty', requestWithHeaders({ 'x-arcanos-memory-token': '' })],
    ['short', requestWithHeaders({ 'x-arcanos-memory-token': 's'.repeat(31) })],
    [
      'oversized',
      requestWithHeaders({
        'x-arcanos-memory-token': 'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1),
      }),
    ],
    ['leading whitespace', requestWithHeaders({ 'x-arcanos-memory-token': ` ${memoryToken}` })],
    ['trailing whitespace', requestWithHeaders({ 'x-arcanos-memory-token': `${memoryToken} ` })],
    ['internal whitespace', requestWithHeaders({ 'x-arcanos-memory-token': `${memoryToken} extra` })],
    ['non-string', requestWithHeaders({ 'x-arcanos-memory-token': 123 })],
    ['array-valued', requestWithHeaders({ 'x-arcanos-memory-token': [memoryToken] })],
    [
      'duplicate',
      requestWithHeaders(
        { 'x-arcanos-memory-token': memoryToken },
        [
          'X-Arcanos-Memory-Token',
          memoryToken,
          'x-arcanos-memory-token',
          memoryToken,
        ]
      ),
    ],
  ])('rejects a %s custom-header value', (_label, req) => {
    expect(extractMemoryAccessToken(req)).toBeNull();
  });

  it('accepts only an exact, case-sensitive custom-header credential', () => {
    const configured = environmentReader({
      [memoryEnvironmentName]: memoryToken,
    });

    expect(authenticateMemoryPlaneRequest(
      requestWithHeaders({ 'x-arcanos-memory-token': memoryToken }),
      configured
    )).toEqual({ ok: true });
    expect(authenticateMemoryPlaneRequest(
      requestWithHeaders({ 'x-arcanos-memory-token': memoryToken.toUpperCase() }),
      configured
    )).toEqual({ ok: false, reason: 'invalid_auth' });
  });

  it('does not treat Authorization as a memory credential carrier', () => {
    const configured = environmentReader({
      [memoryEnvironmentName]: memoryToken,
    });

    expect(authenticateMemoryPlaneRequest(
      requestWithHeaders({ authorization: `Bearer ${memoryToken}` }),
      configured
    )).toEqual({ ok: false, reason: 'missing_auth' });
    expect(authenticateMemoryPlaneRequest(
      requestWithHeaders({
        authorization: 'Bearer test-unrelated-gateway-token-1234567890',
        'x-arcanos-memory-token': memoryToken,
      }),
      configured
    )).toEqual({ ok: true });
  });

  it('returns credential-free missing, invalid, and unavailable decisions', () => {
    const configured = environmentReader({
      [memoryEnvironmentName]: memoryToken,
    });
    const decisions = [
      authenticateMemoryPlaneRequest(requestWithHeaders({}), configured),
      authenticateMemoryPlaneRequest(
        requestWithHeaders({ 'x-arcanos-memory-token': rotatedMemoryToken }),
        configured
      ),
      authenticateMemoryPlaneRequest(
        requestWithHeaders({ 'x-arcanos-memory-token': memoryToken }),
        environmentReader({})
      ),
    ];

    expect(decisions).toEqual([
      { ok: false, reason: 'missing_auth' },
      { ok: false, reason: 'invalid_auth' },
      { ok: false, reason: 'configuration_unavailable' },
    ]);
    expect(JSON.stringify(decisions)).not.toContain(memoryToken);
    expect(JSON.stringify(decisions)).not.toContain(rotatedMemoryToken);
  });

  it.each([
    [
      'missing request token',
      requestWithHeaders({}),
      401,
      'MEMORY_AUTH_REQUIRED',
      'warn',
    ],
    [
      'wrong request token',
      requestWithHeaders({ 'x-arcanos-memory-token': rotatedMemoryToken }),
      401,
      'MEMORY_AUTH_REQUIRED',
      'warn',
    ],
  ] as const)('maps %s to a no-store denial', (_label, req, expectedStatus, expectedCode, logLevel) => {
    process.env[memoryEnvironmentName] = memoryToken;
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    req.logger = logger as Request['logger'];
    const { res, status, json, setHeader } = responseRecorder();
    const next = jest.fn();

    requireMemoryPlaneAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: expectedCode,
        message: 'A valid memory-plane access token is required.',
      },
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
    expect(logger[logLevel]).toHaveBeenCalledWith('memory_plane.http_auth.denied', {
      reason: _label === 'missing request token' ? 'missing_auth' : 'invalid_auth',
      statusCode: expectedStatus,
    });
    expect(JSON.stringify(logger[logLevel].mock.calls)).not.toContain(memoryToken);
    expect(JSON.stringify(logger[logLevel].mock.calls)).not.toContain(rotatedMemoryToken);
  });

  it('maps unavailable configuration to a no-store 503 response', () => {
    const req = requestWithHeaders({ 'x-arcanos-memory-token': memoryToken });
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    req.logger = logger as Request['logger'];
    const { res, status, json, setHeader } = responseRecorder();
    const next = jest.fn();

    requireMemoryPlaneAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'MEMORY_AUTH_UNAVAILABLE',
        message: 'Memory-plane authentication is unavailable.',
      },
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
    expect(logger.error).toHaveBeenCalledWith('memory_plane.http_auth.denied', {
      reason: 'configuration_unavailable',
      statusCode: 503,
    });
  });

  it('resolves configuration on every request so token rotation is immediate', () => {
    process.env[memoryEnvironmentName] = memoryToken;
    const oldRequest = requestWithHeaders({ 'x-arcanos-memory-token': memoryToken });
    const oldResponse = responseRecorder();
    const firstNext = jest.fn();

    requireMemoryPlaneAuth(oldRequest, oldResponse.res, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(oldResponse.status).not.toHaveBeenCalled();
    expect(oldResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');

    process.env[memoryEnvironmentName] = rotatedMemoryToken;
    const revokedResponse = responseRecorder();
    const revokedNext = jest.fn();
    requireMemoryPlaneAuth(oldRequest, revokedResponse.res, revokedNext);
    expect(revokedNext).not.toHaveBeenCalled();
    expect(revokedResponse.status).toHaveBeenCalledWith(401);

    const rotatedRequest = requestWithHeaders({
      authorization: 'Bearer test-unrelated-gateway-token-1234567890',
      'x-arcanos-memory-token': rotatedMemoryToken,
    });
    const rotatedResponse = responseRecorder();
    const rotatedNext = jest.fn();
    requireMemoryPlaneAuth(rotatedRequest, rotatedResponse.res, rotatedNext);
    expect(rotatedNext).toHaveBeenCalledTimes(1);
    expect(rotatedResponse.status).not.toHaveBeenCalled();
    expect(rotatedResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
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
