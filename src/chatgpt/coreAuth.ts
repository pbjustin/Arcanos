import { createHash } from 'node:crypto';
import { getEnv } from '@platform/runtime/env.js';
import {
  CORE_MCP_PATH, CORE_METADATA_PATH, CORE_QUERY_SCOPE, CORE_SCOPES, type CoreScope,
} from '@shared/chatgpt/coreMcpContract.js';
import {
  createScopedChatGptTokenVerifier, hasVerifiedChatGptPermission, readHttpsIdentifier,
  type ChatGptPrincipal, type EnvironmentReader, type ReadyChatGptAuthConfiguration,
} from './auth.js';

export interface ReadyCoreAuthConfiguration extends ReadyChatGptAuthConfiguration {
  readonly ownerSubject: string;
  readonly oauthClientId: string;
}

export type CoreAuthConfiguration = { status: 'disabled' | 'misconfigured' } | ReadyCoreAuthConfiguration;

const verifiedCoreOwners = new WeakSet<ChatGptPrincipal>();
const ownerIdentifier = /^[^\u0000-\u001f\u007f]{1,256}$/u;

/** Core is unavailable until its exact resource, private owner and OAuth client are configured. */
export function readCoreAuthConfiguration(read: EnvironmentReader = getEnv): CoreAuthConfiguration {
  if (read('CHATGPT_CORE_ENABLED') !== 'true') return { status: 'disabled' };
  const issuer = readHttpsIdentifier(read('CHATGPT_CORE_ISSUER'));
  const resource = readHttpsIdentifier(read('CHATGPT_CORE_RESOURCE'));
  const jwksUrl = readHttpsIdentifier(read('CHATGPT_CORE_JWKS_URL'));
  const ownerSubject = read('CHATGPT_CORE_OWNER_SUBJECT');
  const oauthClientId = read('CHATGPT_CORE_OAUTH_CLIENT_ID');
  if (!issuer || !resource || !jwksUrl || resource !== new URL(resource).origin + CORE_MCP_PATH
    || !ownerSubject || ownerSubject !== ownerSubject.trim() || !ownerIdentifier.test(ownerSubject)
    || !oauthClientId || oauthClientId !== oauthClientId.trim() || !ownerIdentifier.test(oauthClientId)) {
    return { status: 'misconfigured' };
  }
  return Object.freeze({
    status: 'ready', issuer, resource, jwksUrl, ownerSubject, oauthClientId,
    metadataUrl: new URL(CORE_METADATA_PATH, resource).href,
  });
}

export function createCoreTokenVerifier(
  config: ReadyCoreAuthConfiguration,
  options: Parameters<typeof createScopedChatGptTokenVerifier>[2] = {},
) {
  const verify = createScopedChatGptTokenVerifier(config, {
    requiredScope: CORE_QUERY_SCOPE,
    allowedScopes: CORE_SCOPES,
    ownerSubject: config.ownerSubject,
    oauthClientId: config.oauthClientId,
    singleAudience: true,
  }, options);
  return async (authorization: string | undefined) => {
    const result = await verify(authorization);
    if (result.ok) verifiedCoreOwners.add(result.principal);
    return result;
  };
}

export function hasCorePermission(principal: ChatGptPrincipal | undefined, scope: CoreScope = CORE_QUERY_SCOPE): boolean {
  return Boolean(principal && verifiedCoreOwners.has(principal)
    && hasVerifiedChatGptPermission(principal, CORE_QUERY_SCOPE)
    && hasVerifiedChatGptPermission(principal, scope));
}

/** Stable across OAuth token renewal and separate from every legacy actor namespace. */
export function corePrincipalActorKey(principal: ChatGptPrincipal): string {
  if (!hasCorePermission(principal)) throw new Error('CORE_PERMISSION_DENIED');
  return 'chatgpt-core:' + createHash('sha256').update(JSON.stringify([principal.issuer, principal.subject])).digest('hex');
}

export function coreProtectedResourceMetadata(config: ReadyCoreAuthConfiguration) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...CORE_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export function coreAuthChallenge(
  config: ReadyCoreAuthConfiguration,
  scope: CoreScope,
  error: 'invalid_token' | 'insufficient_scope',
) {
  const scopes = scope === CORE_QUERY_SCOPE ? scope : `${CORE_QUERY_SCOPE} ${scope}`;
  return `Bearer resource_metadata="${config.metadataUrl}", scope="${scopes}"`
    + `, error="${error}", error_description="Connect the authorized private Core owner account."`;
}
