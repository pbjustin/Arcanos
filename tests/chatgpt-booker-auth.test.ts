import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import { jest } from '@jest/globals';
import {
  readBookerAuthConfiguration, createBookerTokenVerifier, hasBookerPermission,
  bookerPrincipalActorKey, bookerPrincipalUniverseId, type ReadyBookerAuthConfiguration,
} from '../src/chatgpt/bookerAuth.js';
import {
  CHATGPT_MCP_PATH, CHATGPT_TUTOR_SCOPE, readChatGptAuthConfiguration, createChatGptTokenVerifier,
  hasChatGptTutorPermission, type ReadyChatGptAuthConfiguration,
} from '../src/chatgpt/auth.js';
import {
  readGamingAuthConfiguration, createGamingTokenVerifier, hasGamingPermission, type ReadyGamingAuthConfiguration,
} from '../src/chatgpt/gamingAuth.js';
import { BOOKER_MCP_PATH, BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE } from '../src/shared/chatgpt/bookerMcpContract.js';
import { GAMING_MCP_PATH, GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE } from '../src/shared/chatgpt/gamingMcpContract.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

const env: Record<string, string> = {
  CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: 'https://booker-issuer.invalid/',
  CHATGPT_BOOKER_RESOURCE: 'https://booker-resource.invalid' + BOOKER_MCP_PATH,
  CHATGPT_BOOKER_JWKS_URL: 'https://booker-issuer.invalid/jwks',
  CHATGPT_BOOKER_OWNER_SUBJECT: 'private-booker-owner', CHATGPT_BOOKER_UNIVERSE_ID: 'wwe-2k26',
  CHATGPT_BOOKER_OAUTH_CLIENT_ID: 'private-booker-client',
};
const configuration = readBookerAuthConfiguration(name => env[name]) as ReadyBookerAuthConfiguration;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'booker-fixture', alg: 'RS256' }] });
});
afterEach(() => jest.restoreAllMocks());
async function token(claims: JWTPayload = {}, typ = 'at+jwt') {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
    iat: now, exp: now + 300, scope: BOOKER_READ_SCOPE, client_id: configuration.oauthClientId, ...claims })
    .setProtectedHeader({ alg: 'RS256', typ, kid: 'booker-fixture' }).sign(keys.privateKey);
}
async function principal(claims: JWTPayload = {}, config = configuration) {
  const result = await createBookerTokenVerifier(config, { keyResolver, readEnvironmentValue: () => undefined })(
    'Bearer ' + await token(claims));
  if (!result.ok) throw new Error('Invalid signed fixture');
  return result.principal;
}

describe('private Booker OAuth configuration', () => {
  it('is disabled by default and does not enable through a truthy value', () => {
    expect(readBookerAuthConfiguration(() => undefined)).toEqual({ status: 'disabled' });
    expect(readBookerAuthConfiguration(name => name === 'CHATGPT_BOOKER_ENABLED' ? '1' : env[name])).toEqual({ status: 'disabled' });
  });
  it.each(['CHATGPT_BOOKER_ISSUER', 'CHATGPT_BOOKER_RESOURCE', 'CHATGPT_BOOKER_JWKS_URL',
    'CHATGPT_BOOKER_OWNER_SUBJECT', 'CHATGPT_BOOKER_UNIVERSE_ID', 'CHATGPT_BOOKER_OAUTH_CLIENT_ID'])(
    'fails closed without %s', name => {
      expect(readBookerAuthConfiguration(key => key === name ? undefined : env[key])).toEqual({ status: 'misconfigured' });
    });
  it.each([
    ['CHATGPT_BOOKER_RESOURCE', 'https://booker-resource.invalid/chatgpt/mcp'],
    ['CHATGPT_BOOKER_RESOURCE', 'https://booker-resource.invalid/chatgpt/gaming/mcp'],
    ['CHATGPT_BOOKER_RESOURCE', 'https://booker-resource.invalid/chatgpt/booker/mcp?extra=1'],
    ['CHATGPT_BOOKER_ISSUER', 'http://booker-issuer.invalid/'],
    ['CHATGPT_BOOKER_JWKS_URL', 'https://user:pass@booker-issuer.invalid/jwks'],
    ['CHATGPT_BOOKER_OWNER_SUBJECT', ' private-booker-owner'],
    ['CHATGPT_BOOKER_OWNER_SUBJECT', 'owner\n'],
    ['CHATGPT_BOOKER_OAUTH_CLIENT_ID', ' private-booker-client'],
    ['CHATGPT_BOOKER_OAUTH_CLIENT_ID', 'client\n'],
    ['CHATGPT_BOOKER_UNIVERSE_ID', '*'], ['CHATGPT_BOOKER_UNIVERSE_ID', 'wwe/other'],
    ['CHATGPT_BOOKER_UNIVERSE_ID', 'wwe-2k26 '], ['CHATGPT_BOOKER_UNIVERSE_ID', 'a'.repeat(129)],
  ])('rejects invalid %s (%#)', (name, value) => {
    expect(readBookerAuthConfiguration(key => key === name ? value : env[key])).toEqual({ status: 'misconfigured' });
  });
  it('keeps the configured mapping immutable and exact', () => {
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(configuration.universeId).toBe('wwe-2k26');
    expect(configuration.resource).toBe(env.CHATGPT_BOOKER_RESOURCE);
  });
});

describe('signed Booker identity and exact universe membership', () => {
  it.each([
    { sub: 'other-owner' }, { iss: 'https://another-issuer.invalid/' },
    { aud: 'https://booker-resource.invalid/chatgpt/mcp' },
    { aud: 'https://booker-resource.invalid/chatgpt/gaming/mcp' },
    { aud: [env.CHATGPT_BOOKER_RESOURCE, 'https://booker-resource.invalid/chatgpt/gaming/mcp'] },
    { aud: [env.CHATGPT_BOOKER_RESOURCE] },
    { scope: 'arcanos:tutor' }, { scope: 'arcanos:gaming:query' },
    { scope: BOOKER_GENERATE_SCOPE }, { scope: 'operator:all' }, { exp: 1 },
    { iat: Math.floor(Date.now() / 1_000) + 3_600 },
    { client_id: undefined }, { client_id: 'another-client' },
    { client_id: 'private-booker-client', azp: 'another-client' },
    { client_id: 'another-client', azp: 'private-booker-client' },
  ])('rejects invalid signed claims %j', async claims => {
    const verify = createBookerTokenVerifier(configuration, { keyResolver, readEnvironmentValue: () => undefined });
    expect((await verify('Bearer ' + await token(claims))).ok).toBe(false);
  });
  it.each(['Basic abc', 'Bearer mock-managed-action-token', 'Bearer mock-operator-token', 'Bearer mock-malformed.jwt.token',
    'Bearer token token', '', undefined])('rejects non-OAuth authorization %s', async authorization => {
    expect((await createBookerTokenVerifier(configuration, { keyResolver })(authorization)).ok).toBe(false);
  });
  it('rejects an ID token even when its claims and signature otherwise match', async () => {
    expect((await createBookerTokenVerifier(configuration, { keyResolver })('Bearer ' + await token({}, 'JWT'))).ok).toBe(false);
  });
  it.each(PURPOSE_BOUND_CREDENTIAL_ENV_NAMES)('rejects reusing a purpose-bound token: %s', async name => {
    const signed = await token();
    const verify = createBookerTokenVerifier(configuration, { keyResolver,
      readEnvironmentValue: key => key === name ? signed : undefined });
    expect((await verify('Bearer ' + signed)).ok).toBe(false);
  });
  it('separates generation grants, immutable verified identity, and exact universe access', async () => {
    const reader = await principal();
    const writer = await principal({ scope: BOOKER_READ_SCOPE + ' ' + BOOKER_GENERATE_SCOPE });
    expect(hasBookerPermission(reader)).toBe(true);
    expect(hasBookerPermission(reader, true)).toBe(false);
    expect(hasBookerPermission(writer, true, 'wwe-2k26')).toBe(true);
    expect(hasBookerPermission(writer, true, 'WWE-2k26')).toBe(false);
    expect(hasBookerPermission(writer, false, 'other-universe')).toBe(false);
    expect(hasBookerPermission({ ...writer }, true, 'wwe-2k26')).toBe(false);
    expect(bookerPrincipalUniverseId(writer)).toBe('wwe-2k26');
    expect(bookerPrincipalUniverseId({ ...writer })).toBeNull();
    expect(Object.isFrozen(writer)).toBe(true);
    expect(Object.isFrozen(writer.scopes)).toBe(true);
  });
  it('ignores asserted membership and filters unrelated scopes instead of granting them', async () => {
    const owner = await principal({ universes: ['other-universe'], universeId: 'other-universe',
      scope: BOOKER_READ_SCOPE + ' arcanos:tutor operator:all' });
    expect(owner.scopes).toEqual([BOOKER_READ_SCOPE]);
    expect(hasBookerPermission(owner, false, 'other-universe')).toBe(false);
    expect(bookerPrincipalUniverseId(owner)).toBe('wwe-2k26');
  });
  it.each([
    { client_id: 'private-booker-client' },
    { client_id: undefined, azp: 'private-booker-client' },
    { client_id: 'private-booker-client', azp: 'private-booker-client' },
  ])('binds the configured OAuth client from signed claims %j', async claims => {
    const owner = await principal(claims);
    expect(owner.oauthClientId).toBe('private-booker-client');
  });
  it('keeps actors stable across renewal and isolates owner, issuer and universe bindings', async () => {
    const first = await principal({ jti: 'first' });
    const renewed = await principal({ jti: 'renewed', scope: BOOKER_READ_SCOPE + ' ' + BOOKER_GENERATE_SCOPE });
    const otherUniverse = await principal({}, { ...configuration, universeId: 'aew' });
    const otherOwnerConfig = { ...configuration, ownerSubject: 'second-owner' };
    const otherOwner = await principal({ sub: 'second-owner' }, otherOwnerConfig);
    const otherIssuerConfig = { ...configuration, issuer: 'https://second-issuer.invalid/' };
    const otherIssuer = await principal({ iss: otherIssuerConfig.issuer }, otherIssuerConfig);
    expect(bookerPrincipalActorKey(first)).toBe(bookerPrincipalActorKey(renewed));
    expect(bookerPrincipalActorKey(first)).toMatch(/^chatgpt-booker:[0-9a-f]{64}$/u);
    expect(bookerPrincipalActorKey(first)).not.toBe(bookerPrincipalActorKey(otherUniverse));
    expect(bookerPrincipalActorKey(first)).not.toBe(bookerPrincipalActorKey(otherOwner));
    expect(bookerPrincipalActorKey(first)).not.toBe(bookerPrincipalActorKey(otherIssuer));
    expect(() => bookerPrincipalActorKey(first, 'aew')).toThrow('BOOKER_PERMISSION_DENIED');
    expect(bookerPrincipalActorKey(first)).not.toContain(first.subject);
    expect(bookerPrincipalActorKey(first)).not.toBe('backstage-booker-access:principal:v1');
  });
  it('rechecks expiry at execution after successful request admission', async () => {
    const owner = await principal();
    jest.spyOn(Date, 'now').mockReturnValue(owner.expiresAt * 1_000);
    expect(hasBookerPermission(owner)).toBe(false);
    expect(bookerPrincipalUniverseId(owner)).toBeNull();
    expect(() => bookerPrincipalActorKey(owner)).toThrow('BOOKER_PERMISSION_DENIED');
  });
});

describe('shared Auth0 tenant, signing infrastructure and OAuth client compatibility', () => {
  // Synthetic identifiers and the local JWKS above; no Auth0 or other live service is contacted.
  const issuer = 'https://arcanos-tenant.auth0.invalid/';
  const jwksUrl = issuer + '.well-known/jwks.json';
  const ownerSubject = 'auth0|synthetic-arcanos-owner';
  const oauthClientId = 'shared-arcanos-oauth-client';
  const origin = 'https://arcanos-resource.invalid';
  const environment: Record<string, string> = {
    CHATGPT_MCP_ENABLED: 'true', CHATGPT_MCP_ISSUER: issuer, CHATGPT_MCP_JWKS_URL: jwksUrl,
    CHATGPT_MCP_RESOURCE: origin + CHATGPT_MCP_PATH,
    CHATGPT_GAMING_ENABLED: 'true', CHATGPT_GAMING_ISSUER: issuer, CHATGPT_GAMING_JWKS_URL: jwksUrl,
    CHATGPT_GAMING_RESOURCE: origin + GAMING_MCP_PATH, CHATGPT_GAMING_OWNER_SUBJECT: ownerSubject,
    CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: issuer, CHATGPT_BOOKER_JWKS_URL: jwksUrl,
    CHATGPT_BOOKER_RESOURCE: origin + BOOKER_MCP_PATH, CHATGPT_BOOKER_OWNER_SUBJECT: ownerSubject,
    CHATGPT_BOOKER_OAUTH_CLIENT_ID: oauthClientId, CHATGPT_BOOKER_UNIVERSE_ID: 'wwe-2k26',
  };
  const configs = {
    tutor: readChatGptAuthConfiguration(name => environment[name]) as ReadyChatGptAuthConfiguration,
    gaming: readGamingAuthConfiguration(name => environment[name]) as ReadyGamingAuthConfiguration,
    booker: readBookerAuthConfiguration(name => environment[name]) as ReadyBookerAuthConfiguration,
  };
  const allScopes = [CHATGPT_TUTOR_SCOPE, GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE,
    BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE].join(' ');
  function verifiers() {
    const options = { keyResolver, readEnvironmentValue: () => undefined };
    return {
      tutor: createChatGptTokenVerifier(configs.tutor, options),
      gaming: createGamingTokenVerifier(configs.gaming, options),
      booker: createBookerTokenVerifier(configs.booker, options),
    };
  }
  async function sharedToken(claims: JWTPayload = {}, typ = 'at+jwt') {
    return 'Bearer ' + await token({ iss: issuer, aud: configs.booker.resource, sub: ownerSubject,
      client_id: oauthClientId, scope: BOOKER_READ_SCOPE + ' ' + BOOKER_GENERATE_SCOPE, ...claims }, typ);
  }

  it('accepts explicit shared issuer/JWKS and owner configuration while preserving the Booker resource and client binding', () => {
    for (const config of Object.values(configs)) {
      expect(config).toMatchObject({ status: 'ready', issuer, jwksUrl });
    }
    expect(configs.booker).toMatchObject({ ownerSubject, oauthClientId, universeId: 'wwe-2k26' });
    expect(configs.gaming.ownerSubject).toBe(ownerSubject);
    expect(new Set(Object.values(configs).map(config => config.resource)).size).toBe(3);
  });

  it.each([
    ['tutor', [CHATGPT_TUTOR_SCOPE]],
    ['gaming', [GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE]],
    ['booker', [BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE]],
  ] as const)('accepts its own %s audience from the shared signing key/client and retains only its permissions', async (resource, scopes) => {
    const result = await verifiers()[resource](await sharedToken({ aud: configs[resource].resource, scope: allScopes }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid shared OAuth fixture');
    expect(result.principal.scopes).toEqual(scopes);
    expect(result.principal.subject).toBe(ownerSubject);
    expect(hasChatGptTutorPermission(result.principal)).toBe(resource === 'tutor');
    expect(hasGamingPermission(result.principal, true)).toBe(resource === 'gaming');
    expect(hasBookerPermission(result.principal, true, 'wwe-2k26')).toBe(resource === 'booker');
  });

  it.each([
    ['tutor', 'booker'], ['gaming', 'booker'], ['booker', 'tutor'],
    ['booker', 'gaming'], ['tutor', 'gaming'], ['gaming', 'tutor'],
  ] as const)('rejects a %s-audience token at %s even with the same owner, client, key and all scopes', async (source, target) => {
    expect(await verifiers()[target](await sharedToken({ aud: configs[source].resource, scope: allScopes })))
      .toEqual({ ok: false, error: 'invalid_token', status: 401 });
  });

  it.each([
    ['default Auth0 JWT token profile', {}, 'JWT'],
    ['OIDC resource plus userinfo audiences', { aud: [configs.booker.resource, issuer + 'userinfo'] }, 'at+jwt'],
  ] as const)('rejects incompatible Auth0 issuance: %s', async (_label, claims, typ) => {
    expect(await verifiers().booker(await sharedToken(claims, typ)))
      .toEqual({ ok: false, error: 'invalid_token', status: 401 });
  });

  it.each([
    { client_id: oauthClientId },
    { client_id: undefined, azp: oauthClientId },
    { client_id: oauthClientId, azp: oauthClientId },
  ])('accepts independently issued Booker grants with the reused client in signed claims %j', async claims => {
    const result = await verifiers().booker(await sharedToken({ ...claims, universeId: 'other-universe' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid shared OAuth fixture');
    expect(result.principal.oauthClientId).toBe(oauthClientId);
    expect(hasBookerPermission(result.principal, true, 'wwe-2k26')).toBe(true);
    expect(hasBookerPermission(result.principal, false, 'other-universe')).toBe(false);
    expect(bookerPrincipalUniverseId(result.principal)).toBe('wwe-2k26');
  });

  it.each([
    ['wrong owner', { sub: 'auth0|another-owner' }, 'invalid_token', 401],
    ['wrong client', { client_id: 'another-client' }, 'invalid_token', 401],
    ['missing client', { client_id: undefined }, 'invalid_token', 401],
    ['conflicting authorized party', { azp: 'another-client' }, 'invalid_token', 401],
    ['multi-resource audience', { aud: [configs.booker.resource, configs.tutor.resource] }, 'invalid_token', 401],
    ['Tutor scope alone', { scope: CHATGPT_TUTOR_SCOPE }, 'insufficient_scope', 403],
    ['Gaming scopes alone', { scope: GAMING_QUERY_SCOPE + ' ' + GAMING_WRITE_SCOPE }, 'insufficient_scope', 403],
    ['generation without read', { scope: BOOKER_GENERATE_SCOPE }, 'insufficient_scope', 403],
    ['scope suffix', { scope: BOOKER_READ_SCOPE + ':extra' }, 'insufficient_scope', 403],
  ] as const)('keeps Booker authorization closed for %s with a shared issuer/client', async (_label, claims, error, status) => {
    expect(await verifiers().booker(await sharedToken(claims))).toEqual({ ok: false, error, status });
  });
});
