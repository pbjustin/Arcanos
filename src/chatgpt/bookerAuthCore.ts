import { createHash } from 'node:crypto';
import {
  BOOKER_MCP_PATH, BOOKER_METADATA_PATH, BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE,
} from '@shared/chatgpt/bookerMcpContract.js';
import {
  createScopedChatGptTokenVerifierCore, hasVerifiedChatGptPermission, readHttpsIdentifier,
  type ReadyChatGptAuthConfiguration, type ChatGptPrincipal, type EnvironmentReader,
} from './authCore.js';

export interface ReadyBookerAuthConfiguration extends ReadyChatGptAuthConfiguration {
  readonly ownerSubject: string;
  readonly universeId: string;
  readonly oauthClientId: string;
}
export type BookerAuthConfiguration = { status: 'disabled' | 'misconfigured' } | ReadyBookerAuthConfiguration;

const authorizedUniverses = new WeakMap<ChatGptPrincipal, string>();
const universeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** One private OAuth owner maps to one exact universe through server configuration. */
export function readBookerAuthConfigurationCore(read: EnvironmentReader): BookerAuthConfiguration {
  if (read('CHATGPT_BOOKER_ENABLED') !== 'true') return { status: 'disabled' };
  const issuer = readHttpsIdentifier(read('CHATGPT_BOOKER_ISSUER'));
  const resource = readHttpsIdentifier(read('CHATGPT_BOOKER_RESOURCE'));
  const jwksUrl = readHttpsIdentifier(read('CHATGPT_BOOKER_JWKS_URL'));
  const ownerSubject = read('CHATGPT_BOOKER_OWNER_SUBJECT');
  const universeId = read('CHATGPT_BOOKER_UNIVERSE_ID');
  const oauthClientId = read('CHATGPT_BOOKER_OAUTH_CLIENT_ID');
  if (!issuer || !resource || !jwksUrl || resource !== new URL(resource).origin + BOOKER_MCP_PATH
    || !ownerSubject || ownerSubject !== ownerSubject.trim() || ownerSubject.length > 256
    || /[\u0000-\u001f\u007f]/u.test(ownerSubject) || !universeId || !universeIdPattern.test(universeId)
    || !oauthClientId || oauthClientId !== oauthClientId.trim() || oauthClientId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(oauthClientId)) {
    return { status: 'misconfigured' };
  }
  return Object.freeze({ status: 'ready', issuer, resource, jwksUrl, ownerSubject, universeId, oauthClientId,
    metadataUrl: new URL(BOOKER_METADATA_PATH, resource).href });
}

/** Signed identity selects the configured membership; tool/token claims cannot widen it. */
export function createBookerTokenVerifierCore(config: ReadyBookerAuthConfiguration,
  options: Parameters<typeof createScopedChatGptTokenVerifierCore>[2]) {
  const verify = createScopedChatGptTokenVerifierCore(config, {
    requiredScope: BOOKER_READ_SCOPE, allowedScopes: [BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE],
    ownerSubject: config.ownerSubject, oauthClientId: config.oauthClientId, singleAudience: true,
  }, options);
  return async (authorization: string | undefined) => {
    const result = await verify(authorization);
    if (result.ok) authorizedUniverses.set(result.principal, config.universeId);
    return result;
  };
}

export function hasBookerPermission(principal: ChatGptPrincipal | undefined, generation = false, universeId?: unknown): boolean {
  if (!principal || !hasVerifiedChatGptPermission(principal, BOOKER_READ_SCOPE)
    || principal.resource !== new URL(principal.resource).origin + BOOKER_MCP_PATH) return false;
  const authorizedUniverse = authorizedUniverses.get(principal);
  return Boolean(authorizedUniverse && (universeId === undefined || universeId === authorizedUniverse)
    && (!generation || hasVerifiedChatGptPermission(principal, BOOKER_GENERATE_SCOPE)));
}

export function bookerPrincipalUniverseId(principal: ChatGptPrincipal): string | null {
  return hasBookerPermission(principal) ? authorizedUniverses.get(principal)! : null;
}

/** Stable through renewal; disjoint from managed-bearer, Tutor, and Gaming identities. */
export function bookerPrincipalActorKey(principal: ChatGptPrincipal, universeId?: string): string {
  if (!hasBookerPermission(principal, false, universeId)) throw new Error('BOOKER_PERMISSION_DENIED');
  return 'chatgpt-booker:' + createHash('sha256')
    .update(JSON.stringify([principal.issuer, principal.subject, authorizedUniverses.get(principal)]))
    .digest('hex');
}

export function bookerProtectedResourceMetadata(config: ReadyBookerAuthConfiguration) {
  return { resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: [BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE], bearer_methods_supported: ['header'] };
}

export function bookerAuthChallenge(config: ReadyBookerAuthConfiguration, generation = false,
  error?: 'invalid_token' | 'insufficient_scope') {
  return `Bearer resource_metadata="${config.metadataUrl}", scope="${BOOKER_READ_SCOPE}${generation ? ' ' + BOOKER_GENERATE_SCOPE : ''}"`
    + (error ? `, error="${error}", error_description="Connect the authorized private Booker owner account."` : '');
}
