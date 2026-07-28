import {
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
} from './purposeBoundCredential.js';

export const MEMORY_ACCESS_TOKEN_ENV_NAME = 'ARCANOS_MEMORY_ACCESS_TOKEN';
export const MEMORY_ACCESS_TOKEN_HEADER_NAME = 'x-arcanos-memory-token';

/**
 * Resolve the deployment-wide memory-plane credential without depending on an
 * environment, HTTP, or Express implementation.
 */
export function resolveConfiguredMemoryAccessToken(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader
): string | null {
  const configuredToken = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: MEMORY_ACCESS_TOKEN_ENV_NAME,
    readEnvironmentValue,
  });

  return configuredToken && !/\s/u.test(configuredToken)
    ? configuredToken
    : null;
}
