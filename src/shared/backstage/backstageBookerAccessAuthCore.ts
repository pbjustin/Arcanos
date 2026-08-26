import { buildAuthenticatedCredentialActorKey } from '@platform/runtime/security.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
} from '@shared/security/purposeBoundCredential.js';

export const BACKSTAGE_BOOKER_ACCESS_TOKEN_ENV_NAME =
  'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN';

export const BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY =
  'backstage-booker-access:principal:v1';

const BACKSTAGE_BOOKER_ACCESS_BEARER_PATTERN = /^[\x21-\x7E]+$/u;

export type BackstageBookerAccessAuthenticationResult =
  | {
      ok: true;
      credential: string;
    }
  | {
      ok: false;
      reason: 'configuration_unavailable' | 'missing_auth' | 'invalid_auth';
    };

export interface BackstageBookerAccessAuthenticationInput {
  authorizationHeader: string | undefined;
  authorizationHeaderCount: number;
  authorizationHeaderPresented: boolean;
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader;
}

export interface BackstageBookerAccessActorIdentity {
  principalActorKey: typeof BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY;
  legacyActorKey: string;
}

function readConfiguredBackstageBookerAccessToken(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader
): string | null {
  const credential = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: BACKSTAGE_BOOKER_ACCESS_TOKEN_ENV_NAME,
    readEnvironmentValue,
  });

  return credential
    && BACKSTAGE_BOOKER_ACCESS_BEARER_PATTERN.test(credential)
    ? credential
    : null;
}

/** Resolve configuration through an explicit reader without ambient process access. */
export function isBackstageBookerAccessAuthenticationConfiguredCore(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader
): boolean {
  return readConfiguredBackstageBookerAccessToken(readEnvironmentValue) !== null;
}

/** Parse exactly one dedicated Backstage Booker opaque bearer credential. */
export function extractBackstageBookerAccessBearerTokenCore(input: {
  authorizationHeader: string | undefined;
  authorizationHeaderCount: number;
}): string | null {
  if (input.authorizationHeaderCount > 1) {
    return null;
  }

  const authorization = input.authorizationHeader;
  if (
    typeof authorization !== 'string'
    || authorization.length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 7
  ) {
    return null;
  }

  const match = /^Bearer ([\x21-\x7E]+)$/u.exec(authorization);
  if (
    !match
    || match[1].length === 0
    || match[1].length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
  ) {
    return null;
  }

  return match[1];
}

/** Authenticate one explicit header snapshot against an explicit config reader. */
export function authenticateBackstageBookerAccessCore(
  input: BackstageBookerAccessAuthenticationInput
): BackstageBookerAccessAuthenticationResult {
  const expectedToken = readConfiguredBackstageBookerAccessToken(
    input.readEnvironmentValue
  );
  if (!expectedToken) {
    return {
      ok: false,
      reason: 'configuration_unavailable',
    };
  }

  const bearerToken = extractBackstageBookerAccessBearerTokenCore(input);
  if (!bearerToken) {
    return {
      ok: false,
      reason: input.authorizationHeaderPresented
        ? 'invalid_auth'
        : 'missing_auth',
    };
  }

  if (!timingSafeEqualOpaqueSecret(bearerToken, expectedToken)) {
    return {
      ok: false,
      reason: 'invalid_auth',
    };
  }

  return {
    ok: true,
    credential: bearerToken,
  };
}

/** Derive the stable principal and the compatibility actor from an authenticated token. */
export function buildBackstageBookerAccessActorIdentity(
  credential: string
): BackstageBookerAccessActorIdentity {
  return {
    principalActorKey: BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY,
    legacyActorKey: buildAuthenticatedCredentialActorKey(
      'backstage-booker-access',
      credential
    ),
  };
}
