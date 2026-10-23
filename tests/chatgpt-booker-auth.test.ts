import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import { jest } from '@jest/globals';
import {
  readBookerAuthConfiguration, createBookerTokenVerifier, hasBookerPermission,
  bookerPrincipalActorKey, bookerPrincipalUniverseId, type ReadyBookerAuthConfiguration,
} from '../src/chatgpt/bookerAuth.js';
import { BOOKER_MCP_PATH, BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE } from '../src/shared/chatgpt/bookerMcpContract.js';
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
  ])('binds the independently registered OAuth client from signed claims %j', async claims => {
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
