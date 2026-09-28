import { createHash } from 'node:crypto';
import { getEnv } from '@platform/runtime/env.js';
import { GAMING_MCP_PATH, GAMING_METADATA_PATH, GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE } from '@shared/chatgpt/gamingMcpContract.js';
import { createScopedChatGptTokenVerifier, hasVerifiedChatGptPermission, readHttpsIdentifier,
  type ReadyChatGptAuthConfiguration, type ChatGptPrincipal } from './auth.js';

export interface ReadyGamingAuthConfiguration extends ReadyChatGptAuthConfiguration {
  readonly ownerSubject: string;
  readonly autoStoreApproved: boolean;
}
export type GamingAuthConfiguration = { status: 'disabled' | 'misconfigured' } | ReadyGamingAuthConfiguration;

/** This private resource is unavailable until one exact owner is configured server-side. */
export function readGamingAuthConfiguration(read = getEnv): GamingAuthConfiguration {
  if (read('CHATGPT_GAMING_ENABLED') !== 'true') return { status: 'disabled' };
  const issuer = readHttpsIdentifier(read('CHATGPT_GAMING_ISSUER'));
  const resource = readHttpsIdentifier(read('CHATGPT_GAMING_RESOURCE'));
  const jwksUrl = readHttpsIdentifier(read('CHATGPT_GAMING_JWKS_URL'));
  const ownerSubject = read('CHATGPT_GAMING_OWNER_SUBJECT');
  if (!issuer || !resource || !jwksUrl || resource !== new URL(resource).origin + GAMING_MCP_PATH
    || !ownerSubject || ownerSubject !== ownerSubject.trim() || ownerSubject.length > 256
    || /[\u0000-\u001f\u007f]/u.test(ownerSubject)) return { status: 'misconfigured' };
  return Object.freeze({ status: 'ready', issuer, resource, jwksUrl, ownerSubject,
    metadataUrl: new URL(GAMING_METADATA_PATH, resource).href,
    autoStoreApproved: read('CHATGPT_GAMING_AUTO_STORE_APPROVED') === 'true' });
}

export function createGamingTokenVerifier(config: ReadyGamingAuthConfiguration,
  options: Parameters<typeof createScopedChatGptTokenVerifier>[2] = {}) {
  return createScopedChatGptTokenVerifier(config, {
    requiredScope: GAMING_QUERY_SCOPE, allowedScopes: [GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE], ownerSubject: config.ownerSubject,
  }, options);
}
export function hasGamingPermission(principal: ChatGptPrincipal | undefined, write = false): boolean {
  return Boolean(principal && hasVerifiedChatGptPermission(principal, GAMING_QUERY_SCOPE)
    && principal.resource === new URL(principal.resource).origin + GAMING_MCP_PATH
    && (!write || hasVerifiedChatGptPermission(principal, GAMING_WRITE_SCOPE)));
}
export function gamingPrincipalActorKey(principal: ChatGptPrincipal): string {
  if (!hasGamingPermission(principal)) throw new Error('GAMING_PERMISSION_DENIED');
  // Stable across token renewal. Never bridges into the legacy bearer actor namespace.
  return 'chatgpt-gaming:' + createHash('sha256').update(JSON.stringify([principal.issuer, principal.subject])).digest('hex');
}
export function gamingProtectedResourceMetadata(config: ReadyGamingAuthConfiguration) {
  return { resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: [GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE], bearer_methods_supported: ['header'] };
}
export function gamingAuthChallenge(config: ReadyGamingAuthConfiguration, write = false, error?: 'invalid_token' | 'insufficient_scope') {
  return `Bearer resource_metadata="${config.metadataUrl}", scope="${GAMING_QUERY_SCOPE}${write ? ' ' + GAMING_WRITE_SCOPE : ''}"`
    + (error ? `, error="${error}", error_description="Connect the authorized private Gaming owner account."` : '');
}
