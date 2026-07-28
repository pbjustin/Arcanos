import {
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
} from './purposeBoundCredential.js';

export const DAEMON_ACCESS_TOKEN_ENV_NAME = 'ARCANOS_DAEMON_ACCESS_TOKEN';
export const DAEMON_ACCESS_TOKEN_HEADER_NAME = 'x-arcanos-daemon-token';

/**
 * Resolve the deployment-wide daemon transport credential without coupling the
 * credential contract to Express or process.env.
 */
export function resolveConfiguredDaemonAccessToken(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader
): string | null {
  const configuredToken = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: DAEMON_ACCESS_TOKEN_ENV_NAME,
    readEnvironmentValue,
  });

  return configuredToken && !/\s/u.test(configuredToken)
    ? configuredToken
    : null;
}
