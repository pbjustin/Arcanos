import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { createServer, request as rawHttpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { jest } from '@jest/globals';
import { getRequestAbortSignal, runWithRequestAbortContext } from '@arcanos/runtime';
import type { ChatGptBookerToolName, ChatGptBookerOutput } from '@arcanos/protocol';
import { createChatGptBookerMcpRouter } from '../src/routes/chatgptBookerMcp.js';
import { readBookerAuthConfiguration, hasBookerPermission, bookerPrincipalActorKey,
  type ReadyBookerAuthConfiguration } from '../src/chatgpt/bookerAuth.js';
import type { executeBookerMcp } from '../src/chatgpt/booker.js';
import { hasBookerMcpProviderAdmission } from '../src/chatgpt/bookerRequestAuth.js';
import { BOOKER_MCP_PATH, BOOKER_METADATA_PATH, BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE,
  bookerMcpTools, isBookerMcpOutput } from '../src/shared/chatgpt/bookerMcpContract.js';
import { activateUnsafeCondition, resetSafetyRuntimeStateForTests } from '../src/services/safety/runtimeState.js';

const universeId = 'fixture-universe';
const jobId = '11111111-1111-4111-8111-111111111111';
const env: Record<string, string> = {
  CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: 'https://booker-issuer.invalid/',
  CHATGPT_BOOKER_RESOURCE: 'https://booker-resource.invalid' + BOOKER_MCP_PATH,
  CHATGPT_BOOKER_JWKS_URL: 'https://booker-issuer.invalid/jwks',
  CHATGPT_BOOKER_OWNER_SUBJECT: 'private-booker-owner', CHATGPT_BOOKER_UNIVERSE_ID: universeId,
  CHATGPT_BOOKER_OAUTH_CLIENT_ID: 'private-booker-client',
};
const configuration = readBookerAuthConfiguration(name => env[name]) as ReadyBookerAuthConfiguration;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;
const servers: Server[] = [];
const clients: Client[] = [];
const protectedGeneration = { version: 1, protected: true, protectedGenerationCompleted: true,
  official: true, continuityVerified: true, authority: 'notion', snapshotStatus: 'current_complete',
  fallbackUsed: false, fallbackPermitted: false };
const hrc = { fidelity: 0.9, resilience: 0.8, verdict: 'Consistent' };
const pending: ChatGptBookerOutput = { statusCode: 200, result: {
  jobId, status: 'pending', jobStatus: 'pending', lifecycleStatus: 'queued',
  poll: '/gpt-access/capabilities/v1/backstage-booker/jobs/' + jobId + '/result', result: null, error: null,
} };
const queued: ChatGptBookerOutput = { statusCode: 202, result: {
  ok: true, status: 'queued', jobId, poll: '/gpt-access/capabilities/v1/backstage-booker/jobs/' + jobId + '/result',
} };
function success(action: string, result: Record<string, unknown>): ChatGptBookerOutput {
  return { statusCode: 200, result: { ok: true, result,
    _route: { gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', route: 'backstage-booker',
      action, timestamp: '2026-10-23T00:00:00.000Z' } } };
}
function output(name: ChatGptBookerToolName): ChatGptBookerOutput {
  if (name === 'getBackstageBookerJobResult') return pending;
  if (name === 'generateBooking' || name === 'generateBookingWithHRC') return success(name, {
    universeId, storyline: 'Kay "Spotlight" Morales fixture booking.', protectedGeneration,
    ...(name === 'generateBookingWithHRC' ? { hrc } : {}),
  });
  if (name === 'queryContinuity') return success(name, { universeId, authority: 'notion',
    answer: 'Fixture continuity.', coverage: { status: 'complete', scopeChunks: 1, selectedChunks: 1,
      omittedChunks: 0, promptTruncated: false, exhaustive: true, hasMore: false }, sources: [] });
  if (name === 'simulateMatch') return success(name, { universeId,
    result: { match: 'A vs B', result: 'A wins', via: 'Pinfall', interference: null, rating: '4.2' }, hrc });
  return { statusCode: 503, result: { ok: false, error: { code: 'BACKSTAGE_UNIVERSE_READ_UNAVAILABLE', message: 'Fixture unavailable.' } } };
}
const execute = jest.fn<typeof executeBookerMcp>();
const providerAdmission = jest.fn<RequestHandler>((_req, _res, next) => next());
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'booker-fixture', alg: 'RS256' }] });
});
beforeEach(() => {
  resetSafetyRuntimeStateForTests();
  execute.mockReset();
  execute.mockImplementation(async (_principal, name) => output(name));
  providerAdmission.mockClear();
});
afterEach(async () => {
  resetSafetyRuntimeStateForTests();
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function token(generation = true, claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
    iat: now, exp: now + 300, client_id: configuration.oauthClientId,
    scope: BOOKER_READ_SCOPE + (generation ? ' ' + BOOKER_GENERATE_SCOPE : ''), ...claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'booker-fixture' }).sign(keys.privateKey);
}
function app(options: Parameters<typeof createChatGptBookerMcpRouter>[0] = {}, parentController?: AbortController) {
  const application = express();
  if (parentController) application.use((_req, _res, next) => {
    runWithRequestAbortContext({ controller: parentController, signal: parentController.signal,
      deadlineAt: Date.now() + 5_000, timeoutMs: 5_000 }, next);
  });
  application.use(createChatGptBookerMcpRouter({ configuration,
    verification: { keyResolver, readEnvironmentValue: () => undefined }, execute, providerAdmission, ...options }));
  application.use(express.json());
  application.post('/gpt/legacy-fixture', (req, res) => res.json(req.body));
  return application;
}
const post = (application = app()) => request(application).post(BOOKER_MCP_PATH).set('Accept', 'application/json, text/event-stream');
async function rawPost(body: Buffer, bearer: string, contentType = 'application/json') {
  const server = createServer(app()).listen(0, '127.0.0.1');
  servers.push(server); await once(server, 'listening');
  const address = server.address() as { port: number };
  return new Promise<{ status: number | undefined; body: Record<string, unknown> }>((resolve, reject) => {
    const req = rawHttpRequest({ hostname: '127.0.0.1', port: address.port, path: BOOKER_MCP_PATH, method: 'POST',
      headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json, text/event-stream',
        'Content-Type': contentType, 'Content-Length': body.length } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rpc = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const inputs: Record<ChatGptBookerToolName, Record<string, unknown>> = {
  queryContinuity: { universeId, query: 'List current champions.', retrievalMode: 'complete_scope' },
  generateBooking: { universeId, prompt: 'Book the show.', idempotencyKey: 'fixture-booking' },
  generateBookingWithHRC: { universeId, prompt: 'Book the show.', idempotencyKey: 'fixture-hrc' },
  simulateMatch: { universeId, match: { wrestler1: 'A', wrestler2: 'B', matchType: 'Singles' } },
  getBackstageUniverse: { universeId },
  getBackstageStoryline: { universeId, storylineKey: 'exact-key' },
  getBackstageBookerJobResult: { universeId, jobId, waitForResultMs: 0 },
};

describe('private Booker MCP authentication and discovery', () => {
  it('publishes resource metadata without owner/universe disclosure and authenticates before parsing', async () => {
    const metadata = await request(app()).get(BOOKER_METADATA_PATH);
    expect(metadata.status).toBe(200);
    expect(metadata.headers['cache-control']).toBe('no-store');
    expect(metadata.body).toEqual({ resource: configuration.resource, authorization_servers: [configuration.issuer],
      scopes_supported: [BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE], bearer_methods_supported: ['header'] });
    expect(JSON.stringify(metadata.body)).not.toContain(configuration.ownerSubject);
    expect(JSON.stringify(metadata.body)).not.toContain(universeId);
    const denied = await post().set('Content-Type', 'application/json').send('{bad json');
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toContain(BOOKER_READ_SCOPE);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ status: 'disabled' as const, expected: 404 }, { status: 'misconfigured' as const, expected: 503 }])(
    'keeps $status integrations closed', async ({ status, expected }) => {
      const application = app({ configuration: { status } });
      expect((await request(application).get(BOOKER_METADATA_PATH)).status).toBe(expected);
      expect((await post(application).send(list)).status).toBe(expected);
      expect(execute).not.toHaveBeenCalled();
    });
  it.each([{ sub: 'other-owner' }, { client_id: 'gaming-client' }, { client_id: undefined },
    { aud: 'https://booker-resource.invalid/chatgpt/gaming/mcp' }, { scope: 'arcanos:tutor' }])(
    'rejects signed cross-resource or unauthorized identity %j', async claims => {
      const response = await post().auth(await token(true, claims), { type: 'bearer' }).send(list);
      expect([401, 403]).toContain(response.status);
      expect(providerAdmission).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  it('runs real SDK initialize/list/call with all seven fixed tools and no transport session', async () => {
    const server = createServer(app()).listen(0, '127.0.0.1');
    servers.push(server); await once(server, 'listening');
    const address = server.address() as { port: number };
    const client = new Client({ name: 'booker-migration-fixture', version: '1.0.0' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + BOOKER_MCP_PATH), {
      requestInit: { headers: { Authorization: 'Bearer ' + await token() } },
    });
    await client.connect(transport);
    const catalog = await client.listTools();
    expect(catalog.tools.map(tool => tool.name)).toEqual(bookerMcpTools.map(tool => tool.name));
    expect(catalog.tools).toHaveLength(7);
    expect(transport.sessionId).toBeUndefined();
    expect(catalog.tools.find(tool => tool.name === 'generateBooking')).toMatchObject({
      inputSchema: { additionalProperties: false, required: ['universeId', 'prompt'] },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE] }] },
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    const result = await client.callTool({ name: 'queryContinuity', arguments: inputs.queryContinuity });
    expect(result.structuredContent).toEqual(output('queryContinuity'));
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('advertises only read tools for a reader and denies generation without consuming provider admission', async () => {
    const application = app(); const bearer = await token(false);
    const response = await post(application).auth(bearer, { type: 'bearer' }).send(list);
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'queryContinuity', 'getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult',
    ]);
    for (const name of ['generateBooking', 'generateBookingWithHRC', 'simulateMatch'] as const) {
      const denied = await post(application).auth(bearer, { type: 'bearer' }).send(rpc(name, inputs[name]));
      expect(denied.body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'BOOKER_PERMISSION_DENIED' }] });
      expect(denied.body.result._meta['mcp/www_authenticate'][0]).toContain(BOOKER_GENERATE_SCOPE);
    }
    expect(providerAdmission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects foreign browser origin and unsupported streaming methods', async () => {
    expect((await post().auth(await token(), { type: 'bearer' }).set('Origin', 'https://foreign.invalid').send(list)).status).toBe(403);
    const response = await request(app()).get(BOOKER_MCP_PATH).auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects duplicate Authorization headers instead of accepting the first valid bearer', async () => {
    const authorization = 'Bearer ' + await token();
    const response = await post().set({ Authorization: [authorization, authorization] }).send(list);
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    expect(providerAdmission).not.toHaveBeenCalled();
  });
});

describe('Booker transport scope, validation, and execution', () => {
  it.each(bookerMcpTools.map(tool => tool.name))('blocks a foreign universe before %s execution or provider admission', async name => {
    const response = await post().auth(await token(), { type: 'bearer' }).send(rpc(name, { ...inputs[name], universeId: 'other-universe' }));
    expect(response.body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'BOOKER_UNIVERSE_DENIED' }] });
    expect(providerAdmission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['modules.invoke', 'jobs.get', 'writeBackstageCanon', 'saveStoryline', 'appendCanonBeat',
    'runtime.inspect', 'exec', 'arcanos_tutor', 'arcanos_gaming_query'])(
    'rejects unadvertised operation %s', async name => {
      const response = await post().auth(await token(), { type: 'bearer' }).send(rpc(name, { universeId }));
      expect(response.body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'BOOKER_TOOL_UNAVAILABLE' }] });
      expect(providerAdmission).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  it.each([{ sessionId: 'foreign-session' }, { actorKey: 'forged' }, { principal: { scopes: ['operator:all'] } },
    { action: 'saveStoryline' }, { credentials: 'legacy-secret' }, { executionMode: 'background' }, { confirmStore: true }])(
    'rejects caller authority and write flags %j', async additional => {
      const response = await post().auth(await token(), { type: 'bearer' }).send(rpc('generateBooking', { ...inputs.generateBooking, ...additional }));
      expect(response.body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'BOOKER_INPUT_INVALID' }] });
      expect(providerAdmission).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  it.each(['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch'] as const)(
    'passes %s through once with verified identity and preserved canonical output', async name => {
      const response = await post().auth(await token(), { type: 'bearer' }).send(rpc(name, inputs[name]));
      expect(response.status).toBe(200);
      expect(response.body.result.isError).toBeUndefined();
      expect(response.body.result.structuredContent).toEqual(output(name));
      expect(isBookerMcpOutput(name, response.body.result.structuredContent)).toBe(true);
      expect(providerAdmission).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      const owner = execute.mock.calls[0][0];
      expect(hasBookerPermission(owner, name !== 'queryContinuity', universeId)).toBe(true);
      expect(owner.oauthClientId).toBe(configuration.oauthClientId);
      expect(bookerPrincipalActorKey(owner)).toMatch(/^chatgpt-booker:[0-9a-f]{64}$/u);
      expect(execute.mock.calls[0][2]).toEqual(inputs[name]);
    });
  it('preserves accepted generation and polls the exact job without another inference request', async () => {
    execute.mockImplementation(async (_principal, name) => name === 'getBackstageBookerJobResult' ? pending : queued);
    const application = app(); const bearer = await token();
    const accepted = await post(application).auth(bearer, { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(accepted.body.result.structuredContent).toEqual(queued);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await post(application).auth(bearer, { type: 'bearer' }).send(rpc('getBackstageBookerJobResult', inputs.getBackstageBookerJobResult));
      expect(result.body.result.structuredContent).toEqual(pending);
    }
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      'generateBooking', 'getBackstageBookerJobResult', 'getBackstageBookerJobResult', 'getBackstageBookerJobResult',
    ]);
    expect(providerAdmission).toHaveBeenCalledTimes(1);
  });
  it('does not charge provider admission for discovery, durable reads or job continuation', async () => {
    const application = app(); const bearer = await token(false);
    await post(application).auth(bearer, { type: 'bearer' }).send(list);
    for (const name of ['getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult'] as const) {
      const result = await post(application).auth(bearer, { type: 'bearer' }).send(rpc(name, inputs[name]));
      expect(result.status).toBe(200);
      expect(result.body.result.structuredContent).toEqual(output(name));
    }
    expect(providerAdmission).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('keeps accepted-job continuation and durable reads available during a runtime safety hold', async () => {
    activateUnsafeCondition({ code: 'PATTERN_INTEGRITY_FAILURE', source: 'booker-mcp-fixture', message: 'Fixture hold' });
    const application = app(); const bearer = await token();
    const discovered = await post(application).auth(bearer, { type: 'bearer' }).send(list);
    expect(discovered.body.result.tools).toHaveLength(7);
    for (const name of ['getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult'] as const) {
      const result = await post(application).auth(bearer, { type: 'bearer' }).send(rpc(name, inputs[name]));
      expect(result.body.result.structuredContent).toEqual(output(name));
    }
    for (const name of ['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch'] as const) {
      const result = await post(application).auth(bearer, { type: 'bearer' }).send(rpc(name, inputs[name]));
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: 'BOOKER_UNAVAILABLE' });
    }
    expect(execute.mock.calls.map(call => call[1])).toEqual(['getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult']);
    expect(providerAdmission).not.toHaveBeenCalled();
  });
  it('hands successful provider admission to the canonical adapter only within that call', async () => {
    const admissions: Array<{ name: string; admitted: boolean }> = [];
    execute.mockImplementation(async (_principal, name) => {
      admissions.push({ name, admitted: hasBookerMcpProviderAdmission() });
      return output(name);
    });
    const application = app(); const bearer = await token();
    await post(application).auth(bearer, { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    await post(application).auth(bearer, { type: 'bearer' }).send(rpc('getBackstageBookerJobResult', inputs.getBackstageBookerJobResult));
    expect(admissions).toEqual([{ name: 'generateBooking', admitted: true }, { name: 'getBackstageBookerJobResult', admitted: false }]);
    expect(hasBookerMcpProviderAdmission()).toBe(false);
    expect(providerAdmission).toHaveBeenCalledTimes(1);
  });
  it('binds shared provider admission to the same stable OAuth actor across token renewal', async () => {
    const actorKeys: Array<string | undefined> = [];
    const admission = jest.fn<RequestHandler>((req, _res, next) => { actorKeys.push(req.authenticatedActorKey); next(); });
    const application = app({ providerAdmission: admission });
    for (const jti of ['original', 'renewed']) {
      const response = await post(application).auth(await token(true, { jti }), { type: 'bearer' })
        .send(rpc('generateBooking', inputs.generateBooking));
      expect(response.status).toBe(200);
    }
    expect(actorKeys[0]).toMatch(/^chatgpt-booker:[0-9a-f]{64}$/u);
    expect(actorKeys[0]).toBe(actorKeys[1]);
    expect(admission).toHaveBeenCalledTimes(2);
  });
  it('does not create an admission handoff or call execution when provider admission fails', async () => {
    const deniedAdmission = jest.fn<RequestHandler>((_req, _res, next) => next(new Error('private store diagnostic')));
    const response = await post(app({ providerAdmission: deniedAdmission })).auth(await token(), { type: 'bearer' })
      .send(rpc('generateBooking', inputs.generateBooking));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'BOOKER_UNAVAILABLE' });
    expect(execute).not.toHaveBeenCalled();
    expect(hasBookerMcpProviderAdmission()).toBe(false);
  });
  it('preserves protected backend failure without exposing a replacement draft or retrying execution', async () => {
    const failure: ChatGptBookerOutput = { statusCode: 503, result: {
      ok: false, result: null, error: { code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE', message: 'Protected Backstage generation did not complete.' },
      protected: true, protectedGenerationCompleted: false, official: false, continuityVerified: false,
      authority: 'none', snapshotStatus: 'not_applicable', fallbackUsed: false, fallbackPermitted: false,
    } };
    execute.mockResolvedValue(failure);
    const response = await post().auth(await token(), { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(response.body.result).toMatchObject({ isError: true, structuredContent: failure });
    expect(response.body.result.structuredContent.result.result).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('redacts execution exceptions and refuses invalid backend success instead of returning it', async () => {
    execute.mockRejectedValueOnce(new Error('provider secret and private continuity'));
    const first = await post().auth(await token(), { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(first.body.result).toEqual({ isError: true, content: [{ type: 'text', text: 'BOOKER_UNAVAILABLE' }] });
    execute.mockResolvedValueOnce({ statusCode: 200, result: { ok: true, draft: 'fabricated fallback' } });
    const second = await post().auth(await token(), { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(second.body.result).toEqual({ isError: true, content: [{ type: 'text', text: 'BOOKER_OUTPUT_INVALID' }] });
    expect(JSON.stringify([first.body, second.body])).not.toContain('fabricated fallback');
  });
  it('rejects batches, malformed and oversized JSON before execution', async () => {
    const bearer = await token();
    expect((await post().auth(bearer, { type: 'bearer' }).send([rpc('generateBooking', inputs.generateBooking)])).status).toBe(400);
    expect((await post().auth(bearer, { type: 'bearer' }).set('Content-Type', 'application/json').send('{invalid')).status).toBe(400);
    expect((await post().auth(bearer, { type: 'bearer' }).send({ payload: 'x'.repeat(262_144) })).status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'queryContinuity' as const, field: 'query', invalidBytes: [0xff] },
    { name: 'generateBooking' as const, field: 'prompt', invalidBytes: [0xc3] },
    { name: 'generateBookingWithHRC' as const, field: 'prompt', invalidBytes: [0xc0, 0xaf] },
    { name: 'getBackstageStoryline' as const, field: 'storylineKey', invalidBytes: [0xed, 0xa0, 0x80] },
  ])('rejects malformed UTF-8 in $name before provider admission or execution', async ({ name, field, invalidBytes }) => {
    const serialized = JSON.stringify(rpc(name, { ...inputs[name], [field]: 'raw-byte-sentinel' }));
    const [prefix, suffix] = serialized.split('raw-byte-sentinel');
    const response = await rawPost(Buffer.concat([Buffer.from(prefix), Buffer.from(invalidBytes), Buffer.from(suffix)]), await token());
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'BOOKER_REQUEST_INVALID' });
    expect(providerAdmission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects UTF-16 JSON before provider admission or execution', async () => {
    const body = Buffer.from(JSON.stringify(rpc('queryContinuity', inputs.queryContinuity)), 'utf16le');
    const response = await rawPost(body, await token(), 'application/json; charset=utf-16le');
    expect(response.status).toBe(415);
    expect(response.body).toEqual({ error: 'BOOKER_REQUEST_INVALID' });
    expect(providerAdmission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects an empty raw body before provider admission or execution', async () => {
    const response = await rawPost(Buffer.alloc(0), await token());
    expect(response.status).toBe(400);
    expect(providerAdmission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'queryContinuity' as const, field: 'query' },
    { name: 'getBackstageStoryline' as const, field: 'storylineKey' },
  ])('preserves valid multibyte UTF-8 exactly in $name', async ({ name, field }) => {
    const input = { ...inputs[name], [field]: 'Événement / 🎤 – 東京' };
    const response = await rawPost(Buffer.from(JSON.stringify(rpc(name, input))), await token(),
      name === 'queryContinuity' ? 'Application/JSON; charset="UTF-8"' : 'application/json');
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2]).toEqual(input);
    expect(providerAdmission).toHaveBeenCalledTimes(name === 'queryContinuity' ? 1 : 0);
  });
  it('bounds principal requests across renewed tokens and preserves unrelated legacy routes', async () => {
    const application = app();
    for (let index = 0; index < 30; index += 1) {
      const response = await post(application).auth(await token(true, { jti: String(index) }), { type: 'bearer' }).send(list);
      expect(response.status).toBe(200);
    }
    const denied = await post(application).auth(await token(true, { jti: 'renewed' }), { type: 'bearer' }).send(list);
    expect(denied.status).toBe(429);
    expect(denied.headers['x-ratelimit-bucket']).toBe('chatgpt-booker-owner');
    const legacy = await request(application).post('/gpt/legacy-fixture').send({ prompt: 'preserved' });
    expect(legacy.body).toEqual({ prompt: 'preserved' });
    expect(providerAdmission).not.toHaveBeenCalled();
  });
  it('aborts a timed-out call cooperatively and does not retry generation', async () => {
    let observedAbort = false;
    execute.mockImplementation(async () => new Promise((_resolve, reject) => {
      getRequestAbortSignal()!.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); }, { once: true });
    }));
    const response = await post(app({ timeoutMs: 5 })).auth(await token(), { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(response.body.result).toEqual({ isError: true, content: [{ type: 'text', text: 'BOOKER_TIMEOUT' }] });
    expect(observedAbort).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('propagates an inherited cancellation signal without replacement generation', async () => {
    const controller = new AbortController();
    execute.mockImplementation(async () => new Promise((_resolve, reject) => {
      const signal = getRequestAbortSignal()!;
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      controller.abort();
    }));
    const response = await post(app({}, controller)).auth(await token(), { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(response.body.result).toEqual({ isError: true, content: [{ type: 'text', text: 'BOOKER_CANCELLED' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('bounds an in-flight operation by OAuth token expiry and aborts without retrying generation', async () => {
    let observedAbort = false;
    execute.mockImplementation(async () => new Promise((_resolve, reject) => {
      getRequestAbortSignal()!.addEventListener('abort', () => { observedAbort = true; reject(new Error('expired')); }, { once: true });
    }));
    const exp = Math.floor(Date.now() / 1_000) + 2;
    const response = await post().auth(await token(true, { exp }), { type: 'bearer' }).send(rpc('generateBooking', inputs.generateBooking));
    expect(response.body.result).toEqual({ isError: true, content: [{ type: 'text', text: 'BOOKER_TIMEOUT' }] });
    expect(observedAbort).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
