import { buildAuthenticatedCredentialActorKey, timingSafeEqualOpaqueSecret } from './opaqueSecret.js';
import { hasConfiguredPurposeBoundCredentialCollision } from './purposeBoundCredential.js';

const BRIDGE_SECRET_ENVIRONMENT_NAME = 'OPENAI_ACTION_SHARED_SECRET';

export interface CustomGptBridgeCredentialInput {
  authorization?: string | null;
  actionSecret?: string | null;
  env?: NodeJS.ProcessEnv;
}

export type CustomGptBridgeCredentialResult =
  | {
      ok: true;
      statusCode: 200;
      actorKey: string;
    }
  | {
      ok: false;
      statusCode: 401 | 503;
      reason: 'invalid' | 'unconfigured';
    };

export function resolveConfiguredCustomGptBridgeSecret(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env[BRIDGE_SECRET_ENVIRONMENT_NAME]?.trim();
  return value
    && !hasConfiguredPurposeBoundCredentialCollision({
      credential: value,
      ownEnvironmentName: BRIDGE_SECRET_ENVIRONMENT_NAME,
      readEnvironmentValue: environmentName => env[environmentName],
    })
    ? value
    : null;
}

function extractBearerToken(authorization?: string | null): string | null {
  if (!authorization) {
    return null;
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return null;
  }

  const token = rest.join(' ').trim();
  return token ? token : null;
}

/**
 * Authenticate either supported Custom GPT bridge credential carrier and
 * return one canonical actor regardless of carrier, whitespace, or casing.
 */
export function validateCustomGptBridgeCredential(
  input: CustomGptBridgeCredentialInput
): CustomGptBridgeCredentialResult {
  const expectedSecret = resolveConfiguredCustomGptBridgeSecret(input.env);
  if (!expectedSecret) {
    return {
      ok: false,
      statusCode: 503,
      reason: 'unconfigured',
    };
  }

  const providedSecret =
    extractBearerToken(input.authorization)
    ?? input.actionSecret?.trim()
    ?? null;
  if (!providedSecret || !timingSafeEqualOpaqueSecret(providedSecret, expectedSecret)) {
    return {
      ok: false,
      statusCode: 401,
      reason: 'invalid',
    };
  }

  return {
    ok: true,
    statusCode: 200,
    actorKey: buildAuthenticatedCredentialActorKey(
      'custom-gpt-bridge',
      expectedSecret
    ),
  };
}
