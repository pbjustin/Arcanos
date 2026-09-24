import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getRequestAbortSignal } from '@arcanos/runtime';
import { createChatGptMcpRouter } from '../src/routes/chatgptMcp.js';
import { readChatGptAuthConfiguration } from '../src/chatgpt/auth.js';
import type { ChatGptTutorOutput } from '@arcanos/protocol';
import { config as runtimeConfig } from '../src/platform/runtime/config.js';
import { createPublicProviderRateLimitMiddleware } from '../src/transport/http/middleware/publicProviderAdmission.js';
import { activateUnsafeCondition, resetSafetyRuntimeStateForTests } from '../src/services/safety/runtimeState.js';

const values: Record<string, string> = {
  CHATGPT_MCP_ENABLED: 'true',
  CHATGPT_MCP_ISSUER: 'https://issuer.example.test',
  CHATGPT_MCP_RESOURCE: 'https://resource.example.test/chatgpt/mcp',
  CHATGPT_MCP_JWKS_URL: 'https://issuer.example.test/jwks',
};
const configuration = readChatGptAuthConfiguration(name => values[name]);
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let keyResolver: ReturnType<typeof createLocalJWKSet>;
const servers: Server[] = [];
const clients: Client[] = [];
const output: ChatGptTutorOutput = {
  answer: 'A fraction represents part of a whole.',
  metadata: { module: 'ARCANOS:TUTOR', execution: 'synchronous', memory: 'unavailable', generation: 'model' },
};
const execute = jest.fn(async () => output);
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture' }] });
});
beforeEach(() => {
  // Runtime safety loads persisted state at import. Every fixture must start
  // clean, including the first case after a different suite persisted a block.
  resetSafetyRuntimeStateForTests();
});
afterEach(async () => {
  resetSafetyRuntimeStateForTests();
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  execute.mockClear();
});
async function token(subject = 'learner-a', scope = 'arcanos:tutor', audience = values.CHATGPT_MCP_RESOURCE, tokenId?: string) {
  return new SignJWT({ scope, ...(tokenId ? { jti: tokenId } : {}) }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' })
    .setIssuer(values.CHATGPT_MCP_ISSUER).setAudience(audience).setSubject(subject)
    .setIssuedAt().setExpirationTime('2m').sign(key);
}
function app(options: Partial<Parameters<typeof createChatGptMcpRouter>[0]> = {}) {
  const result = express();
  result.use(createChatGptMcpRouter({ configuration, verification: { keyResolver }, execute, ...options }));
  // Verify optional integration does not consume unrelated application routes.
  result.use(express.json());
  result.post('/gpt/legacy-fixture', (req, res) => res.json({ legacy: req.body }));
  return result;
}
async function connect(application = app(), subject = 'learner-a') {
  const server = createServer(application).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = new Client({ name: 'migration-sdk-fixture', version: '1.0.0' });
  clients.push(client);
  const methods: string[] = [];
  const realFetch = globalThis.fetch;
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/chatgpt/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + await token(subject) } },
    fetch: async (url, init) => {
      if (typeof init?.body === 'string') methods.push(JSON.parse(init.body).method);
      return realFetch(url, init);
    },
  });
  await client.connect(transport);
  return { client, methods, transport, url: 'http://127.0.0.1:' + address.port + '/chatgpt/mcp' };
}
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'arcanos_tutor', arguments: { prompt: 'Explain fractions.' } } };
function post(application = app()) {
  return request(application).post('/chatgpt/mcp').set('Accept', 'application/json, text/event-stream');
}

describe('assembled ChatGPT MCP resource (signed issuer fixtures; generation dependency mocked)', () => {
  it('runs real SDK initialize, initialized, list and call with canonical output schemas', async () => {
    const { client, methods, transport } = await connect();
    const catalog = await client.listTools();
    expect(catalog.tools.map(t => t.name)).toEqual(['arcanos_tutor']);
    expect(catalog.tools[0]).toMatchObject({
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['arcanos:tutor'] }] },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      inputSchema: { additionalProperties: false, required: ['prompt'] },
    });
    const result = await client.callTool(call.params);
    expect(result.structuredContent).toEqual(output);
    expect(methods).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']));
    expect(transport.sessionId).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const raw = await post().auth(await token(), { type: 'bearer' }).send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(raw.body.result.tools[0].securitySchemes).toEqual([{ type: 'oauth2', scopes: ['arcanos:tutor'] }]);
  });
  it.each([
    'Explain why one half equals two quarters, in two short sentences.',
    '  Explain fractions.  ',
    'First line\nExplain the second line.\n',
    'x'.repeat(8000),
  ])('advertises a prompt pattern compatible with whole-string connector validation (%#)', async prompt => {
    const { client } = await connect();
    const catalog = await client.listTools();
    const schema = catalog.tools[0].inputSchema.properties?.prompt as { pattern: string };
    // Some connected clients apply the advertised pattern as a full match.
    // Preserve JSON Schema non-whitespace semantics under either interpretation.
    const connectorPattern = new RegExp(`^(?:${schema.pattern})$`, 'u');
    expect(connectorPattern.test(prompt)).toBe(true);
    for (const blank of ['', '   ', '\t\n\r']) expect(connectorPattern.test(blank)).toBe(false);
    const result = await client.callTool({ name: 'arcanos_tutor', arguments: { prompt } });
    expect(result.structuredContent).toEqual(output);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('publishes correct protected-resource metadata and challenges missing credentials before parsing', async () => {
    const response = await request(app()).get('/.well-known/oauth-protected-resource/chatgpt/mcp');
    expect(response.body).toMatchObject({ resource: values.CHATGPT_MCP_RESOURCE, scopes_supported: ['arcanos:tutor'] });
    const denied = await post().set('Content-Type', 'application/json').send('{bad json');
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('resource_metadata=');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps pre-authentication throttling bound to an untrusted network peer despite forged forwarding headers (Railway trust: %s)', async trustRailwayRealIp => {
    const policy = jest.replaceProperty(runtimeConfig.limits, 'publicProviderTrustRailwayRealIp', trustRailwayRealIp);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const application = app();
      for (let index = 0; index < 120; index += 1) {
        const response = await post(application)
          .set('X-Forwarded-For', `198.51.100.${index + 1}`)
          .set('X-Real-IP', `203.0.113.${index + 1}`)
          .set('X-Railway-Edge', 'iad1').send(call);
        expect(response.status).toBe(401);
      }
      const denied = await post(application)
        .set('X-Forwarded-For', '198.51.100.121')
        .set('X-Real-IP', '203.0.113.121')
        .set('X-Railway-Edge', 'ewr1').send(call);
      expect(denied.status).toBe(429);
      expect(denied.headers['x-ratelimit-bucket']).toBe('chatgpt-mcp-client');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      policy.restore();
    }
  });
  it.each([false, true])('uses the configured Railway trust policy at the actual router boundary (enabled: %s)', async trustRailwayRealIp => {
    const policy = jest.replaceProperty(runtimeConfig.limits, 'publicProviderTrustRailwayRealIp', trustRailwayRealIp);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const application = express();
      // Simulate only the transport peer; the real route and identity policy
      // still decide whether a Railway edge can supply a client address.
      application.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '100.64.0.8' });
        next();
      });
      application.use(app());
      for (let index = 0; index < 120; index += 1) {
        const response = await post(application)
          .set('X-Forwarded-For', `198.51.100.${index + 1}`)
          .set('X-Real-IP', '203.0.113.10')
          .set('X-Railway-Edge', 'iad1').send(call);
        expect(response.status).toBe(401);
      }
      const differentClient = await post(application)
        .set('X-Real-IP', '203.0.113.11').set('X-Railway-Edge', 'iad1').send(call);
      expect(differentClient.status).toBe(trustRailwayRealIp ? 401 : 429);
      expect(differentClient.headers['x-ratelimit-remaining']).toBe(trustRailwayRealIp ? '119' : '0');
      const originalClient = await post(application)
        .set('X-Forwarded-For', '192.0.2.250')
        .set('X-Real-IP', '203.0.113.10').set('X-Railway-Edge', 'iad1').send(call);
      expect(originalClient.status).toBe(429);
      expect(originalClient.headers['x-ratelimit-bucket']).toBe('chatgpt-mcp-client');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      policy.restore();
    }
  });
  it('bounds discovery per verified subject across token rotation without charging the provider or blocking another subject', async () => {
    const providerAdmission = jest.fn<express.RequestHandler>((_req, _res, next) => next());
    const application = app({ providerAdmission });
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const tokens = await Promise.all(Array.from({ length: 31 }, (_unused, index) => token(
      'limited-learner', 'arcanos:tutor', values.CHATGPT_MCP_RESOURCE, `isolated-token-${index}`,
    )));
    const separateToken = await token('separate-learner');
    expect(new Set(tokens).size).toBe(31);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (const bearer of tokens.slice(0, 30)) {
        const response = await post(application).auth(bearer, { type: 'bearer' }).send(list);
        expect(response.status).toBe(200);
        expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['arcanos_tutor']);
      }
      const denied = await post(application).auth(tokens[30], { type: 'bearer' }).send(list);
      expect(denied.status).toBe(429);
      expect(denied.headers['x-ratelimit-bucket']).toBe('chatgpt-mcp-principal');
      const deniedCall = await post(application).auth(tokens[30], { type: 'bearer' }).send(call);
      expect(deniedCall.status).toBe(429);
      expect(deniedCall.headers['x-ratelimit-bucket']).toBe('chatgpt-mcp-principal');
      const separateDiscovery = await post(application).auth(separateToken, { type: 'bearer' }).send(list);
      expect(separateDiscovery.status).toBe(200);
      expect(separateDiscovery.body.result.tools).toHaveLength(1);
      expect(providerAdmission).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const separateCall = await post(application).auth(separateToken, { type: 'bearer' }).send(call);
      expect(separateCall.status).toBe(200);
      expect(separateCall.body.result.structuredContent).toEqual(output);
      expect(providerAdmission).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['Basic abc', 'Bearer operator-token', 'Bearer action-token', 'Bearer malformed.jwt.token'])('rejects non-OAuth credentials %s', async credential => {
    const response = await post().set('Authorization', credential).send(call);
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects wrong audience and insufficient permission before direct invocation', async () => {
    expect((await post().auth(await token('a', 'arcanos:tutor', 'https://other.test'), { type: 'bearer' }).send(call)).status).toBe(401);
    expect((await post().auth(await token('a', 'operator:all'), { type: 'bearer' }).send(call)).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['modules.invoke', 'jobs.get', 'memory.search', 'gaming_query', 'backstage_generate', 'exec'])('denies unadvertised direct tool %s', async name => {
    const { client } = await connect();
    const response = await client.callTool({ name, arguments: { prompt: 'test' } });
    expect(response.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ sessionId: 'another-session' }, { module: 'ARCANOS:CORE' }, { credentials: 'secret' }, { principal: 'operator' }])('rejects extra arguments %j', async additional => {
    const { client } = await connect();
    const response = await client.callTool({ name: 'arcanos_tutor', arguments: { prompt: 'test', ...additional } });
    expect(response.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['', '   ', 'x'.repeat(8001)])('enforces prompt bounds (%#)', async prompt => {
    const { client } = await connect();
    expect((await client.callTool({ name: 'arcanos_tutor', arguments: { prompt } })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps principals separate despite identical supplied transport-session headers', async () => {
    const application = app();
    for (const subject of ['learner-a', 'learner-b']) {
      const response = await post(application).auth(await token(subject), { type: 'bearer' })
        .set('Mcp-Session-Id', 'caller-controlled').send(call);
      expect(response.status).toBe(200);
    }
    expect(execute.mock.calls.map(args => (args as unknown[])[0])).toMatchObject([{ subject: 'learner-a' }, { subject: 'learner-b' }]);
  });
  it('returns a fixed sanitized error without disclosing exception contents', async () => {
    const failing = jest.fn(async () => { throw new Error('private-token internal-database.example'); });
    const { client } = await connect(app({ execute: failing }));
    const result = await client.callTool(call.params);
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'TUTOR_UNAVAILABLE' }] });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('aborts timed-out work using the existing request abort context', async () => {
    let observedSignal: AbortSignal | undefined;
    const delayed = jest.fn(async () => {
      observedSignal = getRequestAbortSignal();
      await new Promise<void>(resolve => observedSignal!.addEventListener('abort', () => resolve(), { once: true }));
      return output;
    });
    const { client } = await connect(app({ execute: delayed, timeoutMs: 20 }));
    const result = await client.callTool(call.params);
    expect(result).toMatchObject({ isError: true, content: [{ text: 'TUTOR_TIMEOUT' }] });
    expect(observedSignal?.aborted).toBe(true);
  });
  it('aborts backend work when the HTTP client disconnects', async () => {
    let started!: () => void;
    let aborted!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const abort = new Promise<void>(resolve => { aborted = resolve; });
    const delayed = jest.fn(async () => {
      const signal = getRequestAbortSignal()!;
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      return output;
    });
    const { url } = await connect(app({ execute: delayed }));
    const controller = new AbortController();
    const pending = fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(call),
    }).catch(() => undefined);
    await start;
    controller.abort();
    await pending;
    await abort;
  });
  it.each([{ status: 'disabled' as const }, { status: 'misconfigured' as const }])('isolates $status configuration from old paths', async state => {
    const application = app({ configuration: state });
    expect((await post(application).send(call)).status).toBe(state.status === 'disabled' ? 404 : 503);
    expect((await request(application).post('/gpt/legacy-fixture').send({ prompt: 'unchanged' })).body).toEqual({ legacy: { prompt: 'unchanged' } });
  });
  it('rejects hostile origins, compressed/oversized bodies and unsupported methods', async () => {
    const bearer = await token();
    expect((await post().auth(bearer, { type: 'bearer' }).set('Origin', 'https://evil.test').send(call)).status).toBe(403);
    expect((await post().auth(bearer, { type: 'bearer' }).send({ ...call, padding: 'x'.repeat(17000) })).status).toBe(413);
    expect((await post().auth(bearer, { type: 'bearer' }).set('Content-Encoding', 'gzip').send(call)).status).toBe(400);
    expect((await request(app()).get('/chatgpt/mcp').auth(bearer, { type: 'bearer' })).status).toBe(405);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not admit batched MCP calls', async () => {
    const response = await post().auth(await token(), { type: 'bearer' }).send([call, { ...call, id: 2 }]);
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it('preserves runtime safety denial while discovery remains available', async () => {
    activateUnsafeCondition({ code: 'PATTERN_INTEGRITY_FAILURE', message: 'synthetic integrity failure' });
    const response = await post().auth(await token(), { type: 'bearer' }).send(call);
    expect(response.status).toBe(503);
    const { client } = await connect();
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it('shares the provider budget across route instances and preserves exhaustion', async () => {
    const providerAdmission = createPublicProviderRateLimitMiddleware({ maxRequests: 1, clientMaxRequests: 1 });
    expect((await post(app({ providerAdmission })).auth(await token('first'), { type: 'bearer' }).send(call)).status).toBe(200);
    expect((await post(app({ providerAdmission })).auth(await token('second'), { type: 'bearer' }).send(call)).status).toBe(429);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('fails closed with a sanitized response when shared budget storage is unavailable', async () => {
    const providerAdmission = createPublicProviderRateLimitMiddleware({
      store: { consume: async () => { throw new Error('private redis credentials'); } },
    });
    const response = await post(app({ providerAdmission })).auth(await token(), { type: 'bearer' }).send(call);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'TUTOR_UNAVAILABLE' });
    expect(execute).not.toHaveBeenCalled();
  });
});
