import type { Request } from 'express';
import { describe, expect, it } from '@jest/globals';

import {
  extractWorkerHelperCredential,
} from '../src/transport/http/middleware/workerHelperPrivilegedAuth.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  type PurposeBoundCredentialEnvironmentReader,
  type PurposeBoundCredentialEnvName,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  resolveConfiguredWorkerHelperToken,
} from '../src/shared/security/workerHelperCredential.js';

const workerHelperEnvironmentName = 'ARCANOS_WORKER_HELPER_TOKEN';
const workerHelperToken = 'worker-helper-auth-token-1234567890';

function requestWithHeaders(
  headers: Record<string, unknown>,
  rawHeaders: unknown[] = []
): Request {
  return {
    headers,
    rawHeaders,
  } as unknown as Request;
}

function environmentReader(
  values: Partial<Record<PurposeBoundCredentialEnvName, string>>
): PurposeBoundCredentialEnvironmentReader {
  return (environmentName) => values[environmentName];
}

describe('worker-helper credential boundary', () => {
  it.each([
    [
      'custom header',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': workerHelperToken,
      }),
    ],
    [
      'Bearer header',
      requestWithHeaders({
        authorization: `Bearer ${workerHelperToken}`,
      }),
    ],
    [
      'case-insensitive Bearer scheme',
      requestWithHeaders({
        authorization: `bearer ${workerHelperToken}`,
      }),
    ],
    [
      'empty custom header with Bearer fallback',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': '',
        authorization: `Bearer ${workerHelperToken}`,
      }),
    ],
  ])('extracts one exact %s credential', (_label, req) => {
    expect(extractWorkerHelperCredential(req)).toBe(workerHelperToken);
  });

  it.each([
    [
      'minimum-length custom credential',
      'm'.repeat(32),
      (credential: string) => requestWithHeaders({
        'x-arcanos-worker-helper-token': credential,
      }),
    ],
    [
      'maximum-length custom credential',
      'c'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH),
      (credential: string) => requestWithHeaders({
        'x-arcanos-worker-helper-token': credential,
      }),
    ],
    [
      'maximum-length Bearer credential',
      'b'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH),
      (credential: string) => requestWithHeaders({
        authorization: `Bearer ${credential}`,
      }),
    ],
  ])('accepts an exact %s', (_label, credential, buildRequest) => {
    expect(extractWorkerHelperCredential(buildRequest(credential))).toBe(credential);
  });

  it.each([
    ['missing carriers', requestWithHeaders({})],
    [
      'both carriers',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': workerHelperToken,
        authorization: `Bearer ${workerHelperToken}`,
      }),
    ],
    [
      'valid custom credential with malformed non-empty Authorization',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': workerHelperToken,
        authorization: `Basic ${workerHelperToken}`,
      }),
    ],
    [
      'custom leading whitespace',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': ` ${workerHelperToken}`,
      }),
    ],
    [
      'custom trailing whitespace',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': `${workerHelperToken} `,
      }),
    ],
    [
      'custom internal whitespace',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': `${workerHelperToken} extra`,
      }),
    ],
    [
      'Bearer extra separator whitespace',
      requestWithHeaders({
        authorization: `Bearer  ${workerHelperToken}`,
      }),
    ],
    [
      'Bearer trailing whitespace',
      requestWithHeaders({
        authorization: `Bearer ${workerHelperToken} `,
      }),
    ],
    [
      'unsupported authorization scheme',
      requestWithHeaders({
        authorization: `Basic ${workerHelperToken}`,
      }),
    ],
    [
      'short custom credential',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': 's'.repeat(31),
      }),
    ],
    [
      'oversized custom credential',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': 'x'.repeat(
          MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1
        ),
      }),
    ],
    [
      'oversized Bearer credential',
      requestWithHeaders({
        authorization: `Bearer ${'x'.repeat(
          MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1
        )}`,
      }),
    ],
    [
      'non-string custom credential',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': 123,
      }),
    ],
    [
      'array-valued custom credential',
      requestWithHeaders({
        'x-arcanos-worker-helper-token': [workerHelperToken],
      }),
    ],
    [
      'array-valued authorization',
      requestWithHeaders({
        authorization: [`Bearer ${workerHelperToken}`],
      }),
    ],
    [
      'duplicate custom headers',
      requestWithHeaders(
        { 'x-arcanos-worker-helper-token': workerHelperToken },
        [
          'X-Arcanos-Worker-Helper-Token',
          workerHelperToken,
          'x-arcanos-worker-helper-token',
          workerHelperToken,
        ]
      ),
    ],
    [
      'duplicate Authorization headers',
      requestWithHeaders(
        { authorization: `Bearer ${workerHelperToken}` },
        [
          'Authorization',
          `Bearer ${workerHelperToken}`,
          'authorization',
          `Bearer ${workerHelperToken}`,
        ]
      ),
    ],
  ])('rejects %s', (_label, req) => {
    expect(extractWorkerHelperCredential(req)).toBeNull();
  });

  it('accepts an exact, bounded, purpose-bound configuration value', () => {
    expect(resolveConfiguredWorkerHelperToken(environmentReader({
      [workerHelperEnvironmentName]: workerHelperToken,
    }))).toBe(workerHelperToken);
  });

  it.each([
    undefined,
    '',
    'short-token',
    ` ${workerHelperToken}`,
    `${workerHelperToken} `,
    `${workerHelperToken} extra`,
    'change-me',
    'placeholder',
    '<worker-helper-token>',
    'replace-with-a-distinct-strong-token',
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1),
  ])('rejects missing, weak, normalized, placeholder, or oversized configuration: %p', (value) => {
    expect(resolveConfiguredWorkerHelperToken(environmentReader({
      ...(value === undefined
        ? {}
        : { [workerHelperEnvironmentName]: value }),
    }))).toBeNull();
  });

  it.each(
    PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.filter(
      (environmentName) => environmentName !== workerHelperEnvironmentName
    )
  )('rejects reuse of the %s purpose-bound credential', (environmentName) => {
    expect(resolveConfiguredWorkerHelperToken(environmentReader({
      [workerHelperEnvironmentName]: workerHelperToken,
      [environmentName]: workerHelperToken,
    }))).toBeNull();
  });

  it('rejects credential reuse after normalizing the other variable for collision detection', () => {
    expect(resolveConfiguredWorkerHelperToken(environmentReader({
      [workerHelperEnvironmentName]: workerHelperToken,
      ARCANOS_AUTOMATION_SECRET: `  ${workerHelperToken}  `,
    }))).toBeNull();
  });
});
