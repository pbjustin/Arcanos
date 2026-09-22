import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getEnv } from '@platform/runtime/env.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '@shared/security/purposeBoundCredential.js';

export const CHATGPT_TUTOR_SCOPE = 'arcanos:tutor';
export const CHATGPT_MCP_PATH = '/chatgpt/mcp';
export const CHATGPT_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/chatgpt/mcp';

type EnvironmentReader = (name: string) => string | undefined;

export interface ReadyChatGptAuthConfiguration {
  readonly status: 'ready';
  readonly issuer: string;
  readonly resource: string;
  readonly jwksUrl: string;
  readonly metadataUrl: string;
}

export type ChatGptAuthConfiguration =
  | { status: 'disabled' }
  | { status: 'misconfigured' }
  | ReadyChatGptAuthConfiguration;

export interface ChatGptPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export type ChatGptAuthenticationResult =
  | { ok: true; principal: ChatGptPrincipal }
  | { ok: false; error: 'invalid_token'; status: 401 }
  | { ok: false; error: 'insufficient_scope'; status: 403 };

export type ChatGptTokenVerifier = (
  authorizationHeader: string | undefined,
) => Promise<ChatGptAuthenticationResult>;

// Only this module's verified, immutable identities can authorize execution.
// A structurally identical object from a tool argument is never sufficient.
const verifiedPrincipals = new WeakSet<ChatGptPrincipal>();
const INVALID_TOKEN = Object.freeze({ ok: false, error: 'invalid_token', status: 401 } as const);
const INSUFFICIENT_SCOPE = Object.freeze({ ok: false, error: 'insufficient_scope', status: 403 } as const);
const MAX_TOKEN_LENGTH = 16_384;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

/** Validate configured URLs without normalizing security-sensitive identifiers. */
function readHttpsIdentifier(value: string | undefined): string | null {
  if (!value || value.length > 2_048 || value !== value.trim() || !value.startsWith('https://')) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || /[\s\\?#]/u.test(value)
    ) return null;
    return value;
  } catch {
    return null;
  }
}

/** Incomplete optional integration configuration never aborts application startup. */
export function readChatGptAuthConfiguration(
  readEnvironmentValue: EnvironmentReader = getEnv,
): ChatGptAuthConfiguration {
  if (readEnvironmentValue('CHATGPT_MCP_ENABLED') !== 'true') {
    return { status: 'disabled' };
  }
  const issuer = readHttpsIdentifier(readEnvironmentValue('CHATGPT_MCP_ISSUER'));
  const resource = readHttpsIdentifier(readEnvironmentValue('CHATGPT_MCP_RESOURCE'));
  const jwksUrl = readHttpsIdentifier(readEnvironmentValue('CHATGPT_MCP_JWKS_URL'));
  if (!issuer || !resource || !jwksUrl || resource !== new URL(resource).origin + CHATGPT_MCP_PATH) {
    return { status: 'misconfigured' };
  }
  return Object.freeze({
    status: 'ready' as const,
    issuer,
    resource,
    jwksUrl,
    metadataUrl: new URL(CHATGPT_RESOURCE_METADATA_PATH, resource).href,
  });
}

/** RFC 9728 metadata describes only the dedicated resource and Tutor scope. */
export function buildChatGptProtectedResourceMetadata(config: ReadyChatGptAuthConfiguration) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [CHATGPT_TUTOR_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

/** Constant/sanitized challenge fields; URLs come only from validated server configuration. */
export function buildChatGptAuthChallenge(
  config: ReadyChatGptAuthConfiguration,
  error?: 'invalid_token' | 'insufficient_scope',
): string {
  const description = error === 'insufficient_scope'
    ? 'Authorize the Tutor permission to continue.'
    : 'Connect or reconnect an authorized Tutor account.';
  return `Bearer resource_metadata="${config.metadataUrl}", scope="${CHATGPT_TUTOR_SCOPE}"`
    + (error ? `, error="${error}", error_description="${description}"` : '');
}

/** Recheck the trusted identity at execution, including expiry after request admission. */
export function hasChatGptTutorPermission(principal: ChatGptPrincipal | undefined): boolean {
  return Boolean(
    principal
    && verifiedPrincipals.has(principal)
    && principal.expiresAt > Math.floor(Date.now() / 1_000)
    && principal.scopes.includes(CHATGPT_TUTOR_SCOPE),
  );
}

/**
 * Construct the resource-server verifier, without a network request at startup.
 * The optional key resolver supports isolated signed-token tests; there is no
 * HTTP, environment or tool-input route to override production verification.
 */
export function createChatGptTokenVerifier(
  config: ReadyChatGptAuthConfiguration,
  options: {
    keyResolver?: JWTVerifyGetKey;
    readEnvironmentValue?: EnvironmentReader;
  } = {},
): ChatGptTokenVerifier {
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  const readEnvironmentValue = options.readEnvironmentValue ?? getEnv;

  return async (authorizationHeader) => {
    if (!authorizationHeader || authorizationHeader.length > MAX_TOKEN_LENGTH + 7) return INVALID_TOKEN;
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(authorizationHeader);
    if (!match) return INVALID_TOKEN;
    const token = match[1];

    // Purpose-bound credentials cannot become OAuth credentials even if an
    // operator accidentally configures one to contain a valid signed JWT.
    if (PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.some((name) => (
      timingSafeEqualOpaqueSecret(token, readEnvironmentValue(name))
    ))) return INVALID_TOKEN;

    try {
      const { payload } = await jwtVerify(token, keyResolver, {
        algorithms: ['RS256', 'ES256'],
        issuer: config.issuer,
        audience: config.resource,
        typ: 'at+jwt',
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp'],
        clockTolerance: 0,
      });
      const now = Math.floor(Date.now() / 1_000);
      if (
        typeof payload.sub !== 'string'
        || payload.sub.length === 0
        || payload.sub.length > 256
        || payload.sub !== payload.sub.trim()
        || typeof payload.iat !== 'number'
        || !Number.isSafeInteger(payload.iat)
        || payload.iat > now
        || typeof payload.exp !== 'number'
        || !Number.isSafeInteger(payload.exp)
        || payload.exp <= now
        || payload.exp <= payload.iat
      ) return INVALID_TOKEN;

      if (typeof payload.scope !== 'string' || payload.scope.length > 2_048) return INSUFFICIENT_SCOPE;
      const scopes = payload.scope.split(' ');
      if (scopes.some((scope) => !SCOPE_TOKEN_PATTERN.test(scope))) return INSUFFICIENT_SCOPE;
      if (!scopes.includes(CHATGPT_TUTOR_SCOPE)) return INSUFFICIENT_SCOPE;

      const principal: ChatGptPrincipal = Object.freeze({
        issuer: config.issuer,
        subject: payload.sub,
        resource: config.resource,
        scopes: Object.freeze([CHATGPT_TUTOR_SCOPE]),
        expiresAt: payload.exp,
      });
      verifiedPrincipals.add(principal);
      return { ok: true, principal };
    } catch {
      // Do not return/log token material, provider errors, JWKS diagnostics or claims.
      return INVALID_TOKEN;
    }
  };
}
