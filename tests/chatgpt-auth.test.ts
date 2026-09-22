import { jest } from '@jest/globals';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  CHATGPT_RESOURCE_METADATA_PATH,
  CHATGPT_TUTOR_SCOPE,
  buildChatGptAuthChallenge,
  buildChatGptProtectedResourceMetadata,
  createChatGptTokenVerifier,
  hasChatGptTutorPermission,
  readChatGptAuthConfiguration,
  type ChatGptPrincipal,
  type ReadyChatGptAuthConfiguration,
} from '../src/chatgpt/auth.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

const fixtureEnvironment: Record<string, string> = {
  CHATGPT_MCP_ENABLED: 'true',
  CHATGPT_MCP_RESOURCE: 'https://tutor-resource.invalid/chatgpt/mcp',
  CHATGPT_MCP_ISSUER: 'https://isolated-issuer.invalid/',
  CHATGPT_MCP_JWKS_URL: 'https://isolated-issuer.invalid/jwks',
};
const config = readChatGptAuthConfiguration((name) => fixtureEnvironment[name]) as ReadyChatGptAuthConfiguration;
const invalidToken = { ok: false, status: 401, error: 'invalid_token' };
const insufficientScope = { ok: false, status: 403, error: 'insufficient_scope' };
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let otherPair: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: JWTVerifyGetKey;
let publicJwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };

beforeAll(async () => {
  [keyPair, otherPair] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
  const publicKey = { ...await exportJWK(keyPair.publicKey), kid: 'isolated-tutor-key', alg: 'RS256', use: 'sig' };
  publicJwks = { keys: [publicKey] };
  keyResolver = createLocalJWKSet(publicJwks);
});

function fixtureClaims(): JWTPayload {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: config.issuer,
    sub: 'isolated-user-one',
    aud: config.resource,
    iat: now,
    exp: now + 300,
    scope: CHATGPT_TUTOR_SCOPE,
  };
}

function signFixture(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signingKey = keyPair.privateKey,
): Promise<string> {
  return new SignJWT({ ...fixtureClaims(), ...overrides } as JWTPayload)
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'isolated-tutor-key', ...header })
    .sign(signingKey);
}

function verifier(environment: Record<string, string> = {}) {
  return createChatGptTokenVerifier(config, {
    keyResolver,
    readEnvironmentValue: (name) => environment[name],
  });
}

describe('ChatGPT Tutor resource configuration and discovery', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', ' true '])('is disabled unless explicitly enabled (%s)', enabled => {
    expect(readChatGptAuthConfiguration(name => name === 'CHATGPT_MCP_ENABLED' ? enabled : undefined))
      .toEqual({ status: 'disabled' });
  });

  it.each(['CHATGPT_MCP_RESOURCE', 'CHATGPT_MCP_ISSUER', 'CHATGPT_MCP_JWKS_URL'])(
    'fails incomplete configuration closed without throwing (%s)', missing => {
      expect(readChatGptAuthConfiguration(name => name === missing ? undefined : fixtureEnvironment[name]))
        .toEqual({ status: 'misconfigured' });
    },
  );

  it.each([
    ['CHATGPT_MCP_RESOURCE', 'http://tutor-resource.invalid/chatgpt/mcp'],
    ['CHATGPT_MCP_RESOURCE', 'https://tutor-resource.invalid/mcp'],
    ['CHATGPT_MCP_RESOURCE', 'https://tutor-resource.invalid/chatgpt/mcp/'],
    ['CHATGPT_MCP_RESOURCE', 'https://tutor-resource.invalid/other/../chatgpt/mcp'],
    ['CHATGPT_MCP_RESOURCE', 'https://tutor-resource.invalid/chatgpt/mcp?'],
    ['CHATGPT_MCP_RESOURCE', 'https://tutor-resource.invalid/chatgpt/mcp#'],
    ['CHATGPT_MCP_RESOURCE', 'https://user:secret@tutor-resource.invalid/chatgpt/mcp'],
    ['CHATGPT_MCP_ISSUER', 'https:isolated-issuer.invalid'],
    ['CHATGPT_MCP_ISSUER', 'https://isolated-issuer.invalid/?tenant=other'],
    ['CHATGPT_MCP_JWKS_URL', 'http://127.0.0.1/keys'],
    ['CHATGPT_MCP_JWKS_URL', ' https://isolated-issuer.invalid/jwks'],
    ['CHATGPT_MCP_JWKS_URL', 'https://isolated-issuer.invalid\\jwks'],
  ])('rejects an unsafe or mismatched %s URL', (field, value) => {
    expect(readChatGptAuthConfiguration(name => name === field ? value : fixtureEnvironment[name]))
      .toEqual({ status: 'misconfigured' });
  });

  it('freezes valid config and advertises only the exact resource, issuer and Tutor permission', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.metadataUrl).toBe(`https://tutor-resource.invalid${CHATGPT_RESOURCE_METADATA_PATH}`);
    expect(buildChatGptProtectedResourceMetadata(config)).toEqual({
      resource: fixtureEnvironment.CHATGPT_MCP_RESOURCE,
      authorization_servers: [fixtureEnvironment.CHATGPT_MCP_ISSUER],
      scopes_supported: ['arcanos:tutor'],
      bearer_methods_supported: ['header'],
    });
    expect(buildChatGptAuthChallenge(config)).toBe(
      `Bearer resource_metadata="${config.metadataUrl}", scope="arcanos:tutor"`,
    );
    expect(buildChatGptAuthChallenge(config, 'invalid_token')).toContain(
      'error="invalid_token", error_description="Connect or reconnect an authorized Tutor account."',
    );
    expect(buildChatGptAuthChallenge(config, 'insufficient_scope')).toContain('error="insufficient_scope"');
  });
});

describe('ChatGPT Tutor actual asymmetric access-token verification', () => {
  it('derives immutable identity from signed credentials and grants only Tutor permission', async () => {
    const token = await signFixture({ scope: 'arcanos:tutor operator:admin', role: 'operator', privateClaim: 'hidden' });
    const result = await verifier()(`Bearer ${token}`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid isolated fixture');
    expect(result.principal).toEqual({
      issuer: config.issuer,
      subject: 'isolated-user-one',
      resource: config.resource,
      scopes: ['arcanos:tutor'],
      expiresAt: expect.any(Number),
    });
    expect(Object.isFrozen(result.principal)).toBe(true);
    expect(Object.isFrozen(result.principal.scopes)).toBe(true);
    expect(hasChatGptTutorPermission(result.principal)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(JSON.stringify(result)).not.toContain('operator');
  });

  it.each([undefined, '', 'Basic abc', 'Bearer test-operator-token', 'Bearer a.b.c ', 'Bearer  a.b.c', 'Bearer a.b', 'Bearer a.b.c\nextra', `Bearer ${'a'.repeat(16_385)}.b.c`])(
    'rejects missing or malformed authorization before key resolution', async authorization => {
      const resolveKey = jest.fn<JWTVerifyGetKey>(keyResolver);
      const verify = createChatGptTokenVerifier(config, { keyResolver: resolveKey, readEnvironmentValue: () => undefined });
      expect(await verify(authorization)).toEqual(invalidToken);
      expect(resolveKey).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['issuer', { iss: 'https://other-issuer.invalid/' }],
    ['issuer trailing slash', { iss: 'https://isolated-issuer.invalid' }],
    ['audience', { aud: 'https://other-resource.invalid/chatgpt/mcp' }],
    ['missing audience', { aud: undefined }],
    ['missing issuer', { iss: undefined }],
    ['missing subject', { sub: undefined }],
    ['blank subject', { sub: ' ' }],
    ['long subject', { sub: 'a'.repeat(257) }],
    ['missing issued-at', { iat: undefined }],
    ['missing expiration', { exp: undefined }],
    ['invalid issued-at', { iat: 'yesterday' }],
    ['invalid expiration', { exp: 'tomorrow' }],
    ['noninteger issued-at', { iat: 1.5 }],
  ] as const)('rejects %s', async (_label, claims) => {
    expect(await verifier()(`Bearer ${await signFixture(claims)}`)).toEqual(invalidToken);
  });

  it.each(['expired', 'not-yet-valid', 'future-issued-at', 'expiration-before-issued-at'])(
    'rejects temporal invalidity: %s', async kind => {
      const now = Math.floor(Date.now() / 1_000);
      const claims = kind === 'expired' ? { iat: now - 300, exp: now - 1 }
        : kind === 'not-yet-valid' ? { nbf: now + 60 }
          : kind === 'future-issued-at' ? { iat: now + 60 }
            : { iat: now, exp: now - 1 };
      expect(await verifier()(`Bearer ${await signFixture(claims)}`)).toEqual(invalidToken);
    },
  );

  it.each([undefined, 'JWT', 'id+jwt'])('rejects a missing or non-access-token type (%s)', async typ => {
    expect(await verifier()(`Bearer ${await signFixture({}, { typ })}`)).toEqual(invalidToken);
  });

  it('rejects a validly encoded token signed by another issuer key', async () => {
    expect(await verifier()(`Bearer ${await signFixture({}, {}, otherPair.privateKey)}`)).toEqual(invalidToken);
  });

  it('rejects symmetric signing even when the claims match', async () => {
    const token = await new SignJWT(fixtureClaims())
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .sign(new Uint8Array(32).fill(7));
    expect(await verifier()(`Bearer ${token}`)).toEqual(invalidToken);
  });

  it('accepts the other explicitly permitted asymmetric algorithm', async () => {
    const pair = await generateKeyPair('ES256');
    const jwk = { ...await exportJWK(pair.publicKey), alg: 'ES256', use: 'sig', kid: 'isolated-es-key' };
    const token = await new SignJWT(fixtureClaims())
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid }).sign(pair.privateKey);
    const verify = createChatGptTokenVerifier(config, {
      keyResolver: createLocalJWKSet({ keys: [jwk] }),
      readEnvironmentValue: () => undefined,
    });
    expect((await verify(`Bearer ${token}`)).ok).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['operator', 'operator:admin'],
    ['scope-prefix confusion', 'arcanos:tutor:admin'],
    ['array', ['arcanos:tutor']],
    ['newline', 'arcanos:tutor\noperator:admin'],
    ['leading space', ' arcanos:tutor'],
    ['extra delimiter', 'arcanos:tutor  other:scope'],
    ['oversized', 'a'.repeat(2_049)],
  ])(
    'rejects missing, malformed or insufficient Tutor scope (%s)', async (_label, scope) => {
      expect(await verifier()(`Bearer ${await signFixture({ scope })}`)).toEqual(insufficientScope);
    },
  );

  it.each(PURPOSE_BOUND_CREDENTIAL_ENV_NAMES)('rejects a signed token reused as legacy %s', async name => {
    const token = await signFixture();
    expect(await verifier({ [name]: token })(`Bearer ${token}`)).toEqual(invalidToken);
  });

  it('does not follow a token-supplied key endpoint', async () => {
    const token = await signFixture({}, { jku: 'https://untrusted.invalid/jwks', x5u: 'https://untrusted.invalid/cert' });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect((await verifier()(`Bearer ${token}`)).ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sanitizes key-resolution errors without returning or logging private diagnostics', async () => {
    const token = await signFixture();
    const logSpy = jest.spyOn(console, 'error');
    const warnSpy = jest.spyOn(console, 'warn');
    const verify = createChatGptTokenVerifier(config, {
      keyResolver: async () => { throw new Error(`private issuer diagnostics ${token}`); },
      readEnvironmentValue: () => undefined,
    });
    expect(await verify(`Bearer ${token}`)).toEqual(invalidToken);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects copied and caller-created principals and rechecks expiration at execution', async () => {
    const token = await signFixture();
    const result = await verifier()(`Bearer ${token}`);
    if (!result.ok) throw new Error('Expected valid isolated fixture');
    expect(hasChatGptTutorPermission({ ...result.principal })).toBe(false);
    expect(hasChatGptTutorPermission({ scopes: ['arcanos:tutor'], expiresAt: Infinity } as ChatGptPrincipal)).toBe(false);
    expect(hasChatGptTutorPermission(undefined)).toBe(false);
    jest.spyOn(Date, 'now').mockReturnValue(result.principal.expiresAt * 1_000);
    expect(hasChatGptTutorPermission(result.principal)).toBe(false);
  });

  it('keeps principals distinct across subjects and repeated signed requests', async () => {
    const verify = verifier();
    const first = await verify(`Bearer ${await signFixture({ sub: 'principal-one' })}`);
    const second = await verify(`Bearer ${await signFixture({ sub: 'principal-two' })}`);
    if (!first.ok || !second.ok) throw new Error('Expected valid isolated fixtures');
    expect(first.principal.subject).toBe('principal-one');
    expect(second.principal.subject).toBe('principal-two');
    expect(first.principal).not.toBe(second.principal);
    expect(hasChatGptTutorPermission(first.principal)).toBe(true);
    expect(hasChatGptTutorPermission(second.principal)).toBe(true);
  });

  it('retrieves and caches signing keys through the production remote JWKS verifier using isolated loopback transport', async () => {
    let requests = 0;
    const fixtureServer = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(publicJwks));
    });
    fixtureServer.listen(0, '127.0.0.1');
    await once(fixtureServer, 'listening');
    const address = fixtureServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address');
    const originalFetch = globalThis.fetch;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      expect(String(input)).toBe(config.jwksUrl);
      expect(init?.redirect).toBe('manual');
      return originalFetch(`http://127.0.0.1:${address.port}/jwks`, init);
    });
    try {
      const verify = createChatGptTokenVerifier(config, { readEnvironmentValue: () => undefined });
      expect(requests).toBe(0);
      expect((await verify(`Bearer ${await signFixture()}`)).ok).toBe(true);
      expect((await verify(`Bearer ${await signFixture({ sub: 'second-loopback-user' })}`)).ok).toBe(true);
      expect(requests).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      fixtureServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rejects a JWKS redirect without following the unconfigured destination', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://untrusted-key-host.invalid/jwks' },
    }));
    const verify = createChatGptTokenVerifier(config, { readEnvironmentValue: () => undefined });
    expect(await verify(`Bearer ${await signFixture()}`)).toEqual(invalidToken);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(config.jwksUrl);
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('bounds stalled JWKS retrieval with the production timeout and returns a sanitized failure', async () => {
    let aborted = false;
    jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected bounded JWKS signal');
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    const verify = createChatGptTokenVerifier(config, { readEnvironmentValue: () => undefined });
    expect(await verify(`Bearer ${await signFixture()}`)).toEqual(invalidToken);
    expect(aborted).toBe(true);
  }, 10_000);
});
