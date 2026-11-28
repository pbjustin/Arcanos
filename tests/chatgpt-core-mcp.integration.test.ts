import express, { type RequestHandler } from 'express';
import { once } from 'node:events';
import { jest } from '@jest/globals';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getProtocolSchemaCatalog } from '@arcanos/protocol';
import { getRequestAbortSignal } from '@arcanos/runtime/requestAbort';
import { corePrincipalActorKey, readCoreAuthConfiguration, type ReadyCoreAuthConfiguration } from '../src/chatgpt/coreAuth.js';
import type { executeCoreMcp } from '../src/chatgpt/core.js';
import { createChatGptCoreMcpRouter } from '../src/routes/chatgptCoreMcp.js';
import {
  CORE_MCP_PATH, CORE_METADATA_PATH, CORE_SCOPES, CORE_QUERY_SCOPE, CORE_MEMORY_READ_SCOPE,
  CORE_MEMORY_WRITE_SCOPE, CORE_DIAGNOSTICS_SCOPE, CORE_PRODUCTIVITY_READ_SCOPE,
  coreMcpTools, type CoreMcpToolName,
} from '../src/shared/chatgpt/coreMcpContract.js';

const env: Record<string, string> = {
  CHATGPT_CORE_ENABLED: 'true',
  CHATGPT_CORE_ISSUER: 'https://core-issuer.invalid/',
  CHATGPT_CORE_RESOURCE: 'https://core-resource.invalid' + CORE_MCP_PATH,
  CHATGPT_CORE_JWKS_URL: 'https://core-issuer.invalid/jwks',
  CHATGPT_CORE_OWNER_SUBJECT: 'core-fixture-owner',
  CHATGPT_CORE_OAUTH_CLIENT_ID: 'core-fixture-client',
};
const configuration = readCoreAuthConfiguration(name => env[name]) as ReadyCoreAuthConfiguration;
const sessionId = 'a'.repeat(64);
const jobId = '11111111-1111-4111-8111-111111111111';
const challengeId = '22222222-2222-4222-8222-222222222222';
const query = { prompt: 'Explain the tradeoff.\nShow the consequence.', idempotencyKey: 'fixture-core-query' };
const write = { sessionId, text: 'A note approved for this fixture.', idempotencyKey: 'fixture-core-note' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'core-fixture', version: '1.0.0' },
} };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const call = (name: string, args: unknown) => ({
  jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args },
});

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;
const execute = jest.fn<typeof executeCoreMcp>();
const admit = jest.fn<RequestHandler>((_req, _res, next) => next());
const pending = { ok: true, status: 'pending', jobId } as const;

beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'core-fixture', alg: 'ES256' }] });
});

beforeEach(() => {
  admit.mockClear();
  execute.mockReset().mockResolvedValue(pending);
});

async function token(claims: JWTPayload = {}, typ = 'at+jwt') {
  const iat = Math.floor(Date.now() / 1_000);
  return new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
    iat, exp: iat + 300, client_id: configuration.oauthClientId, scope: CORE_SCOPES.join(' '), ...claims })
    .setProtectedHeader({ alg: 'ES256', typ, kid: 'core-fixture' }).sign(keys.privateKey);
}

function app(options: Parameters<typeof createChatGptCoreMcpRouter>[0] = {}) {
  const application = express();
  application.use(createChatGptCoreMcpRouter({
    configuration, verification: { keyResolver, readEnvironmentValue: () => undefined },
    execute, providerAdmission: admit, isUnsafe: () => false, ...options,
  }));
  application.use(express.json());
  return application;
}

function post(bearer?: string, application = app()) {
  const send = request(application).post(CORE_MCP_PATH).set('Accept', 'application/json, text/event-stream');
  return bearer ? send.auth(bearer, { type: 'bearer' }) : send;
}

describe('private Core MCP transport', () => {
  it('advertises the configured resource and scopes and authenticates before parsing', async () => {
    const response = await request(app()).get(CORE_METADATA_PATH).set('X-Forwarded-Host', 'untrusted.invalid').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ resource: configuration.resource, authorization_servers: [configuration.issuer],
      scopes_supported: CORE_SCOPES, bearer_methods_supported: ['header'] });
    expect(response.text).not.toContain(configuration.ownerSubject);
    expect(response.text).not.toContain(configuration.oauthClientId);
    const denied = await post().type('application/json').send('{malformed').expect(401);
    expect(denied.headers['www-authenticate']).toContain(configuration.metadataUrl);
    expect(denied.body).toEqual({ error: 'CORE_AUTHORIZATION_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([{ status: 'disabled' as const, http: 404 }, { status: 'misconfigured' as const, http: 503 }])(
    'keeps $status Core resources closed', async ({ status, http }) => {
      const application = app({ configuration: { status } });
      await request(application).get(CORE_METADATA_PATH).expect(http, { error: 'CORE_INTEGRATION_UNAVAILABLE' });
      await post(undefined, application).type('application/json').send('{malformed').expect(http);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(['CHATGPT_CORE_ISSUER', 'CHATGPT_CORE_RESOURCE', 'CHATGPT_CORE_JWKS_URL', 'CHATGPT_CORE_OWNER_SUBJECT',
    'CHATGPT_CORE_OAUTH_CLIENT_ID'])('requires explicit %s configuration', missing => {
    expect(readCoreAuthConfiguration(name => name === missing ? undefined : env[name])).toEqual({ status: 'misconfigured' });
  });

  it.each([
    [{ iss: 'https://another-issuer.invalid/' }, 401],
    [{ sub: 'different-owner' }, 401],
    [{ aud: 'https://core-resource.invalid/chatgpt/booker/mcp' }, 401],
    [{ aud: [configuration.resource, 'https://cross-resource.invalid'] }, 401],
    [{ client_id: undefined }, 401],
    [{ client_id: 'different-client' }, 401],
    [{ azp: 'different-client' }, 401],
    [{ iat: 1, exp: 2 }, 401],
    [{ scope: CORE_MEMORY_WRITE_SCOPE }, 403],
  ] as const)('rejects a signed credential with unauthorized claims %j', async (claims, status) => {
    await post(await token({ ...claims, ...('aud' in claims && Array.isArray(claims.aud) ? { aud: [...claims.aud] } : {}) }))
      .send(list).expect(status, { error: 'CORE_AUTHORIZATION_REQUIRED' });
    expect(admit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects ID tokens, configured operator credentials and an untrusted Origin', async () => {
    await post(await token({}, 'JWT')).send(list).expect(401);
    const operatorCredential = await token();
    await post(operatorCredential, app({ verification: {
      keyResolver, readEnvironmentValue: name => name === 'MCP_BEARER_TOKEN' ? operatorCredential : undefined,
    } })).send(list).expect(401);
    await post(await token()).set('Origin', 'https://untrusted.invalid').send(list).expect(403, { error: 'CORE_ORIGIN_DENIED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('initializes stateless SDK transport and advertises only the catalog and effects authorized for the owner', async () => {
    const full = await token();
    const handshake = await post(full).send(initialize).expect(200);
    expect(handshake.headers['mcp-session-id']).toBeUndefined();
    expect(handshake.body.result.serverInfo.name).toBe('arcanos-core-private');
    const catalog = (await post(full).send(list).expect(200)).body.result.tools;
    expect(catalog).toEqual(coreMcpTools);
    const toolSchemas = getProtocolSchemaCatalog().tools;
    for (const tool of coreMcpTools) {
      expect(tool.inputSchema).toEqual(toolSchemas[tool.name].input);
      expect(tool.outputSchema).toEqual(toolSchemas[tool.name].output);
    }
    expect(catalog.find((tool: { name: CoreMcpToolName }) => tool.name === 'coreAsk').annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
    expect(catalog.find((tool: { name: CoreMcpToolName }) => tool.name === 'writeCoreMemory')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [CORE_QUERY_SCOPE, CORE_MEMORY_WRITE_SCOPE] }] },
    });
    expect(catalog.find((tool: { name: CoreMcpToolName }) => tool.name === 'inspectCoreDiagnostics')).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [CORE_QUERY_SCOPE, CORE_DIAGNOSTICS_SCOPE] }] },
    });
    const queryOnly = await token({ scope: CORE_QUERY_SCOPE });
    const limited = (await post(queryOnly).send(list).expect(200)).body.result.tools;
    expect(limited.map((tool: { name: string }) => tool.name)).toEqual(['coreAsk', 'getCoreJobResult']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a real SDK client discover and consume the closed output schemas', async () => {
    const bearer = await token();
    const server = app().listen(0, '127.0.0.1');
    const client = new Client({ name: 'core-sdk-fixture', version: '1.0.0' });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture listener missing.');
      const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + CORE_MCP_PATH), {
        requestInit: { headers: { Authorization: 'Bearer ' + bearer } },
      });
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(coreMcpTools.map(tool => tool.name));
      const result = await client.callTool({ name: 'coreAsk', arguments: query });
      expect(result.structuredContent).toEqual(pending);
      expect(admit).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('blocks out-of-scope capabilities and session use before provider or executor admission', async () => {
    const queryOnly = await token({ scope: CORE_QUERY_SCOPE });
    for (const [name, input] of [
      ['readCoreMemory', { sessionId }],
      ['writeCoreMemory', write],
      ['startCoreSession', { idempotencyKey: 'fixture-start' }],
      ['inspectCoreDiagnostics', { area: 'queue' }],
      ['readCoreProductivity', { view: 'focus' }],
      ['coreAsk', { ...query, sessionId }],
    ] as const) {
      const result = (await post(queryOnly).send(call(name, input)).expect(200)).body.result;
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'CORE_PERMISSION_DENIED' }] });
      expect(result._meta['mcp/www_authenticate'][0]).toContain('insufficient_scope');
    }
    const readOnlyMemory = await token({ scope: [CORE_QUERY_SCOPE, CORE_MEMORY_READ_SCOPE].join(' ') });
    const missingWrite = (await post(readOnlyMemory).send(call('coreAsk', { ...query, sessionId })).expect(200)).body.result;
    expect(missingWrite._meta['mcp/www_authenticate'][0]).toContain(CORE_MEMORY_WRITE_SCOPE);
    expect(admit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['coreAsk', { ...query, gptId: 'arcanos-gaming' }, 'CORE_INPUT_INVALID'],
    ['coreAsk', { ...query, answerMode: 'audit' }, 'CORE_INPUT_INVALID'],
    ['coreAsk', { ...query, prompt: ' \r\n' }, 'CORE_INPUT_INVALID'],
    ['coreAsk', { ...query, idempotencyKey: 'fixture-core-query\n' }, 'CORE_INPUT_INVALID'],
    ['coreAsk', { ...query, prompt: 'x'.repeat(12_001) }, 'CORE_INPUT_INVALID'],
    ['getCoreJobResult', { jobId, owner: 'injected' }, 'CORE_INPUT_INVALID'],
    ['writeCoreMemory', { ...write, confirmGate: true }, 'CORE_INPUT_INVALID'],
    ['inspectCoreDiagnostics', { area: 'queue', filters: { includePayload: true } }, 'CORE_INPUT_INVALID'],
    ['readCoreProductivity', { view: 'summary', workspaceId: 'somewhere' }, 'CORE_INPUT_INVALID'],
    ['execute_action_plan', {}, 'CORE_TOOL_UNAVAILABLE'],
    ['constructor', {}, 'CORE_TOOL_UNAVAILABLE'],
  ])('rejects input outside the closed Core catalog for %s', async (name, input, code) => {
    const result = (await post(await token()).send(call(name, input)).expect(200)).body.result;
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: code }] });
    expect(execute).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('bounds authenticated body allocation and rejects non-POST MCP methods and batches', async () => {
    const bearer = await token();
    await post(bearer).send([list]).expect(400, { error: 'CORE_BATCH_UNSUPPORTED' });
    await post(bearer).type('text/plain').send('wrong content type').expect(415, { error: 'CORE_REQUEST_INVALID' });
    await post(bearer).type('application/json').send('{malformed').expect(400, { error: 'CORE_REQUEST_INVALID' });
    await post(bearer).send({ padding: 'x'.repeat(196_609) }).expect(413, { error: 'CORE_REQUEST_INVALID' });
    await request(app()).get(CORE_MCP_PATH).auth(bearer, { type: 'bearer' }).expect('Allow', 'POST').expect(405);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps unsupported protocol versions and malformed SDK input out of errors', async () => {
    const bearer = await token();
    await post(bearer).set('MCP-Protocol-Version', 'fixture-sensitive-version')
      .send(list).expect(400, { error: 'CORE_PROTOCOL_UNSUPPORTED' });
    await post(bearer).send(call('coreAsk', 'fixture-sensitive-input')).expect(400, { error: 'CORE_REQUEST_INVALID' });
    expect(admit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes pending and completed answers and admits only the initial Core query to the provider budget', async () => {
    const bearer = await token({ jti: 'first' });
    const first = (await post(bearer).send(call('coreAsk', query)).expect(200)).body.result;
    expect(first.structuredContent).toEqual(pending);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.any(Object), 'coreAsk', query, expect.any(Object));
    const firstOwner = corePrincipalActorKey(execute.mock.calls[0][0]);
    const answer = { ok: true, status: 'completed', jobId, answer: 'Fixture answer.' } as const;
    execute.mockResolvedValue(answer);
    const renewed = await token({ jti: 'renewed' });
    const polled = (await post(renewed).send(call('getCoreJobResult', { jobId })).expect(200)).body.result;
    expect(polled.structuredContent).toEqual(answer);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(corePrincipalActorKey(execute.mock.calls[1][0])).toBe(firstOwner);
  });

  it('validates diagnostic and productivity output and confines a write confirmation token to structured content', async () => {
    const bearer = await token();
    const injectedOutput = {
      ok: true, area: 'queue', queue: { status: 'unavailable', connectionUrl: 'fixture-sensitive' },
    } as const;
    execute.mockResolvedValueOnce(injectedOutput);
    const invalid = await post(bearer).send(call('inspectCoreDiagnostics', { area: 'queue' })).expect(200);
    expect(invalid.body.result).toEqual({ isError: true, content: [{ type: 'text', text: 'CORE_OUTPUT_INVALID' }] });
    expect(invalid.text).not.toContain('fixture-sensitive');

    const focus = { ok: true, view: 'focus', generatedAt: '2026-11-27T00:00:00.000Z', recommended: [], candidateCount: 0 } as const;
    execute.mockResolvedValueOnce({ ...focus, recommended: [] });
    const productivity = await post(await token({ scope: CORE_QUERY_SCOPE + ' ' + CORE_PRODUCTIVITY_READ_SCOPE }))
      .send(call('readCoreProductivity', { view: 'focus' })).expect(200);
    expect(productivity.body.result.structuredContent).toEqual(focus);

    execute.mockResolvedValueOnce({
      ok: false, error: { code: 'CORE_CONFIRMATION_REQUIRED', message: 'Confirm this exact Core memory save, then return the issued confirmation token.' },
      confirmationToken: challengeId, confirmationExpiresAt: '2026-11-27T00:01:00.000Z',
    });
    const confirmation = (await post(bearer).send(call('writeCoreMemory', write)).expect(200)).body.result;
    expect(confirmation.isError).toBe(true);
    expect(confirmation.structuredContent.confirmationToken).toBe(challengeId);
    expect(confirmation.content[0].text).not.toContain(challengeId);
    expect(admit).not.toHaveBeenCalled();
  });

  it('allows bounded reads while unsafe and blocks mutations before execution', async () => {
    const bearer = await token();
    const application = app({ isUnsafe: () => true });
    await post(bearer, application).send(call('coreAsk', query)).expect(503, { error: 'CORE_UNAVAILABLE' });
    const mutation = (await post(bearer, application).send(call('writeCoreMemory', write)).expect(200)).body.result;
    expect(mutation.content[0].text).toBe('CORE_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ ok: true, area: 'runtime', runtime: { status: 'ok', uptimeSeconds: 10 } });
    const read = (await post(bearer, application).send(call('inspectCoreDiagnostics', { area: 'runtime' })).expect(200)).body.result;
    expect(read.structuredContent.runtime.status).toBe('ok');
  });

  it('redacts dependency exceptions and aborts execution at the request deadline', async () => {
    const bearer = await token();
    execute.mockRejectedValueOnce(new Error('fixture-secret: database url, request body and bearer'));
    const failure = await post(bearer).send(call('coreAsk', query)).expect(200);
    expect(failure.body.result.content[0].text).toBe('CORE_UNAVAILABLE');
    expect(failure.text).not.toContain('fixture-secret');

    let signal: AbortSignal | undefined;
    execute.mockImplementationOnce(async () => {
      signal = getRequestAbortSignal();
      return new Promise(() => {});
    });
    const timeout = (await post(bearer, app({ timeoutMs: 10 })).send(call('coreAsk', query)).expect(200)).body.result;
    expect(timeout.content[0].text).toBe('CORE_TIMEOUT');
    expect(signal?.aborted).toBe(true);
  });
});
