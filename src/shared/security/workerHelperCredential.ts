import {
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
} from './purposeBoundCredential.js';

export const WORKER_HELPER_TOKEN_ENV_NAME = 'ARCANOS_WORKER_HELPER_TOKEN';
export const WORKER_HELPER_TOKEN_HEADER_NAME = 'x-arcanos-worker-helper-token';

/**
 * Resolve the strict WH-01 worker-control credential without depending on an
 * environment, HTTP, or Express implementation.
 */
export function resolveConfiguredWorkerHelperToken(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader
): string | null {
  const configuredToken = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: WORKER_HELPER_TOKEN_ENV_NAME,
    readEnvironmentValue,
  });

  return configuredToken && !/\s/u.test(configuredToken)
    ? configuredToken
    : null;
}
