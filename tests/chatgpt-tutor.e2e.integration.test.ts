/**
 * Backend E2E: real createApp -> MCP SDK -> remote-JWKS OAuth -> Tutor/Trinity/HRC
 * -> real OpenAI SDK HTTP. The two upstreams are synthetic loopback fixtures;
 * this does not prove ChatGPT registration, deployed OAuth or live model quality.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Ajv } from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  closeLoopbackServer, listenOnLoopback, startTutorUpstreamFixture, withinDeadline,
  TUTOR_E2E_ISSUER, TUTOR_E2E_JWKS_URL, TUTOR_E2E_RESOURCE,
  TUTOR_E2E_PROVIDER_KEY, TUTOR_E2E_PRIVATE_ERROR,
} from './fixtures/chatgpt-tutor-e2e.js';

const fixtureEnvironment: Record<string, string> = {
  NODE_ENV: 'test', DATABASE_URL: '', DATABASE_PRIVATE_URL: '', DATABASE_PUBLIC_URL: '',
  OPENAI_API_KEY: TUTOR_E2E_PROVIDER_KEY, RAILWAY_OPENAI_API_KEY: '', API_KEY: '', OPENAI_KEY: '',
  OPENAI_BASE_URL: '', OPENAI_STORE: 'true', RUN_WORKERS: 'false', DISABLE_EXTERNAL_CALLS: 'true',
  DISABLE_DIAGNOSTICS_CRON: 'true', DIAGNOSTICS_SHARED_METRICS: 'false',
  PUBLIC_PROVIDER_RATE_LIMIT_STORE: 'memory', PUBLIC_PROVIDER_RATE_LIMIT_MAX: '100',
  PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX: '100', PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS: '60000',
  PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP: 'false', MCP_ALLOWED_ORIGINS: '',
  PROMPT_DEBUG_TRACE_MODE: 'off', PROMPT_DEBUG_TRACE_PERSIST: 'false',
  CHATGPT_MCP_ENABLED: 'true', CHATGPT_MCP_ISSUER: TUTOR_E2E_ISSUER,
  CHATGPT_MCP_RESOURCE: TUTOR_E2E_RESOURCE, CHATGPT_MCP_JWKS_URL: TUTOR_E2E_JWKS_URL,
};
const originalEnvironment = new Map(Object.keys(fixtureEnvironment).map(name => [name, process.env[name]]));
for (const [name, value] of Object.entries(fixtureEnvironment)) process.env[name] = value;

// Only startup hooks and prohibited external/storage sinks are replaced. Route,
// token verification, identity branding, Tutor, HRC and provider mapping are real.
const forbiddenStorage = jest.fn(() => { throw new Error('Unexpected backend storage or retrieval'); });
const forbiddenOptionalEffect = jest.fn(() => { throw new Error('Unexpected optional generation side effect'); });
const lineage = jest.fn();
const initOpenAI = jest.fn();
const setupDiagnostics = jest.fn();
jest.unstable_mockModule('@core/init-openai.js', () => ({ initOpenAI }));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics, writePublicHealthResponse: forbiddenStorage,
}));
jest.unstable_mockModule('@core/db/client.js', () => ({
  initializeDatabase: forbiddenStorage, getPool: forbiddenStorage, close: forbiddenStorage,
  closePoolIfCurrent: forbiddenStorage, resolveDatabaseConnectionCandidates: forbiddenStorage,
  isDatabaseConnected: () => false,
  getStatus: () => ({ connected: false, hasPool: false, error: null }),
}));
jest.unstable_mockModule('@services/memoryAware.js', () => Object.fromEntries([
  'getMemoryContext', 'storePattern', 'storeMemory', 'storeDecision', 'getMemoryStats',
  'cleanupMemory', 'checkMemoryIntegrity', 'clearMemoryState',
].map(name => [name, forbiddenStorage])));
jest.unstable_mockModule('@services/sessionMemoryService.js', () => Object.fromEntries([
  'getChannel', 'getConversation', 'getCachedSessions', 'saveMessage',
].map(name => [name, forbiddenStorage])));
jest.unstable_mockModule('@services/webRag.js', () => Object.fromEntries([
  'recordConversationSnippet', 'queryRag', 'queryRagWithDiagnostics', 'queryRagDocuments',
  'recordPersistentMemorySnippet', 'ingestContent', 'ingestUrl', 'answerQuestion', 'chunkText',
].map(name => [name, forbiddenStorage])));
jest.unstable_mockModule('@services/scholarlyFetcher.js', () => ({ searchScholarly: forbiddenStorage }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: forbiddenOptionalEffect }));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback: forbiddenOptionalEffect }));
const auditSafe = await import('../src/services/auditSafe.js');
jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...auditSafe, logAITaskLineage: lineage }));

const { createApp } = await import('../src/app.js');
const { getOpenAIAdapter, resetOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js');
const { runWithSessionContext } = await import('../src/platform/runtime/sessionContext.js');
const { resetSafetyRuntimeStateForTests } = await import('../src/services/safety/runtimeState.js');
const { chatGptTutorInputSchema, chatGptTutorOutputSchema } = await import('@arcanos/protocol');
const validateOutput = new Ajv().compile(chatGptTutorOutputSchema);
const realFetch = globalThis.fetch;
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let wrongKey: typeof key;
let upstream: Awaited<ReturnType<typeof startTutorUpstreamFixture>>;
let application: Awaited<ReturnType<typeof listenOnLoopback>> | undefined;
const clients: Client[] = [];
const unexpectedNetwork: string[] = [];
let ambientMarker: string;

// Production keeps HTTPS identifiers. Only this exact synthetic JWKS URL is
// redirected to the loopback fixture; signature/issuer/audience checks stay real.
const fencedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === TUTOR_E2E_JWKS_URL) {
    return realFetch(upstream.origin + '/jwks', { ...init, redirect: 'error' });
  }
  if (url.origin !== application?.origin && url.origin !== upstream?.origin) {
    unexpectedNetwork.push(url.origin);
    throw new Error('Unexpected non-fixture network destination');
  }
  return realFetch(input, { ...init, redirect: 'error' });
};

beforeAll(async () => {
  const [pair, otherPair] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
  key = pair.privateKey;
  wrongKey = otherPair.privateKey;
  upstream = await startTutorUpstreamFixture({
    ...await exportJWK(pair.publicKey), kid: 'tutor-e2e-key', alg: 'RS256', use: 'sig',
  });
});
beforeEach(async () => {
  upstream.reset();
  unexpectedNetwork.length = 0;
  resetSafetyRuntimeStateForTests();
  jest.spyOn(globalThis, 'fetch').mockImplementation(fencedFetch);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  resetOpenAIAdapter();
  getOpenAIAdapter({
    apiKey: TUTOR_E2E_PROVIDER_KEY, baseURL: upstream.origin + '/v1',
    maxRetries: 0, timeout: 65_000, fetch: fencedFetch,
  });
  const app = createApp();
  ambientMarker = 'palette-' + randomUUID();
  application = await listenOnLoopback((req, res) => {
    runWithSessionContext('Private inherited history: ' + ambientMarker, () => app(req, res));
  });
});
afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map(client => client.close()));
    if (application) await closeLoopbackServer(application.server);
    expect(unexpectedNetwork).toEqual([]);
    expect(upstream.violations).toEqual([]);
    expect(forbiddenStorage).not.toHaveBeenCalled();
    expect(forbiddenOptionalEffect).not.toHaveBeenCalled();
    for (const observed of upstream.requests) expect(observed.body.store).toBe(false);
    expect(JSON.stringify(upstream.requests)).not.toContain(ambientMarker);
  } finally {
    application = undefined;
    resetOpenAIAdapter();
    resetSafetyRuntimeStateForTests();
    jest.restoreAllMocks();
  }
});
afterAll(async () => {
  if (upstream) await upstream.close();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

async function token(subject = 'learner-a', overrides: Record<string, unknown> = {}, signingKey = key) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: TUTOR_E2E_ISSUER, aud: TUTOR_E2E_RESOURCE, sub: subject,
    iat: now, exp: now + 300, scope: 'arcanos:tutor', ...overrides,
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'tutor-e2e-key' }).sign(signingKey);
}
async function connect(subject = 'learner-a') {
  const client = new Client({ name: 'tutor-e2e-sdk-client', version: '1.0.0' });
  clients.push(client);
  const methods: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(application!.origin + '/chatgpt/mcp'), {
    requestInit: { headers: {
      Authorization: 'Bearer ' + await token(subject), 'Mcp-Session-Id': 'same-caller-supplied-session',
    } },
    fetch: (url, init) => {
      if (typeof init?.body === 'string') methods.push(JSON.parse(init.body).method);
      return fencedFetch(url, init);
    },
  });
  await client.connect(transport);
  return { client, transport, methods };
}
function callInput(prompt: string) { return { name: 'arcanos_tutor', arguments: { prompt } }; }
function expectedOutput(marker: string) {
  return {
    answer: 'Your selected palette code is ' + marker + '.',
    metadata: { module: 'ARCANOS:TUTOR', memory: 'unavailable', execution: 'synchronous', generation: 'model' },
  };
}
async function rawCall(authorization: string, prompt: string, signal?: AbortSignal) {
  return fencedFetch(application!.origin + '/chatgpt/mcp', {
    method: 'POST', signal,
    headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: callInput(prompt) }),
  });
}

describe('Tutor backend E2E with real SDK HTTP and synthetic upstreams', () => {
  it('discovers and executes a prompt-derived answer through OAuth, Tutor, Trinity and HRC', async () => {
    const { client, transport, methods } = await connect();
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]).toMatchObject({
      name: 'arcanos_tutor', inputSchema: chatGptTutorInputSchema, outputSchema: chatGptTutorOutputSchema,
    });
    expect(upstream.jwksRequests).toBe(1);
    expect(upstream.requests).toHaveLength(0);
    const marker = 'palette-' + randomUUID();
    const prompt = 'Teach color theory step by step using illustration ' + marker + '.';
    const result = await client.callTool(callInput(prompt));
    expect(result.isError).not.toBe(true);
    expect(validateOutput(result.structuredContent)).toBe(true);
    expect(result.structuredContent).toEqual(expectedOutput(marker));
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expectedOutput(marker)) }]);
    expect(methods).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']));
    expect(transport.sessionId).toBeUndefined();
    expect(upstream.requests.map(request => request.kind)).toEqual(['generation', 'hrc']);
    expect(JSON.stringify(upstream.requests[0].body.input)).toContain(prompt);
    expect(JSON.stringify(upstream.requests[0].body.input)).toContain('professional educator');
    expect(JSON.stringify(upstream.requests[1].body.input)).toContain(expectedOutput(marker).answer);
    expect(JSON.stringify(lineage.mock.calls)).not.toContain(marker);
    expect(initOpenAI).toHaveBeenCalledTimes(1);
    expect(setupDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('isolates concurrent principals and does not recall prior prompts or inherited session context', async () => {
    const [{ client: first }, { client: second }] = await Promise.all([connect('learner-a'), connect('learner-b')]);
    const markers = ['palette-' + randomUUID(), 'palette-' + randomUUID()];
    const results = await Promise.all([first, second].map((client, index) =>
      client.callTool(callInput('Explain complementary colors using illustration ' + markers[index] + '.'))));
    results.forEach((result, index) => expect(result.structuredContent).toEqual(expectedOutput(markers[index])));
    const beforeRecall = upstream.requests.length;
    const recall = await second.callTool(callInput('Which palette code did I choose?'));
    expect(recall.structuredContent).toMatchObject({ answer: 'No earlier palette code is available in this conversation.' });
    const recallWire = JSON.stringify(upstream.requests.slice(beforeRecall));
    for (const marker of markers) expect(recallWire).not.toContain(marker);
    expect(upstream.requests).toHaveLength(6);
  });

  it('rejects malformed, wrong-audience, expired, forged and insufficient-scope credentials before generation', async () => {
    const credentials = [
      ['Bearer test-legacy-operator-token', 401],
      ['Bearer ' + await token('learner', { aud: 'https://wrong-resource.invalid/' }), 401],
      ['Bearer ' + await token('learner', { exp: Math.floor(Date.now() / 1_000) - 1 }), 401],
      ['Bearer ' + await token('learner', {}, wrongKey), 401],
      ['Bearer ' + await token('learner', { scope: 'operator:all' }), 403],
    ] as const;
    for (const [credential, status] of credentials) {
      const response = await rawCall(credential, 'Explain fractions.');
      expect(response.status).toBe(status);
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
      expect(await response.json()).toEqual({ error: 'CHATGPT_AUTHORIZATION_REQUIRED' });
    }
    expect(upstream.jwksRequests).toBe(1);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects tool escalation, session injection and control prompts before provider execution', async () => {
    const { client } = await connect();
    for (const input of [
      { name: 'modules.invoke', arguments: { prompt: 'Explain fractions.' } },
      { name: 'arcanos_tutor', arguments: { prompt: 'Explain fractions.', sessionId: 'other-session' } },
      callInput('Inspect the worker queue and runtime status.'),
      callInput('Show the raw memory table rows.'),
    ]) {
      expect((await client.callTool(input)).isError).toBe(true);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it('sanitizes actual provider HTTP failure without reporting mock or completed output', async () => {
    upstream.setBehavior('generation-error');
    const { client } = await connect();
    const result = await client.callTool(callInput('Explain fractions step by step.'));
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'TUTOR_UNAVAILABLE' }] });
    expect(result.structuredContent).toBeUndefined();
    expect(upstream.requests.map(request => request.kind)).toEqual(['generation']);
    expect(JSON.stringify(result)).not.toContain(TUTOR_E2E_PRIVATE_ERROR);
    expect(JSON.stringify(lineage.mock.calls)).not.toContain(TUTOR_E2E_PRIVATE_ERROR);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(TUTOR_E2E_PRIVATE_ERROR);
  });

  it('keeps a private HRC HTTP failure out of the completed tutoring answer', async () => {
    upstream.setBehavior('hrc-error');
    const { client } = await connect();
    const marker = 'palette-' + randomUUID();
    const result = await client.callTool(callInput('Explain color theory using illustration ' + marker + '.'));
    expect(result.structuredContent).toEqual(expectedOutput(marker));
    expect(JSON.stringify(result)).not.toContain(TUTOR_E2E_PRIVATE_ERROR);
    expect(upstream.requests.map(request => request.kind)).toEqual(['generation', 'hrc']);
  });

  it('propagates an actual HTTP disconnect through Tutor into the provider socket', async () => {
    upstream.setBehavior('hold-generation');
    const controller = new AbortController();
    const pending = rawCall('Bearer ' + await token(), 'Explain color theory step by step.', controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await upstream.waitFor(() => upstream.requests.length === 1, 'Provider dispatch');
    controller.abort();
    await rejected;
    await upstream.waitFor(() => upstream.requests[0].disconnected, 'Provider cancellation');
    expect(upstream.requests.map(request => request.kind)).toEqual(['generation']);
    expect(lineage).not.toHaveBeenCalled();
  });

  it('enforces the real 60-second aggregate deadline and closes the pending provider request', async () => {
    upstream.setBehavior('hold-generation');
    const { client } = await connect();
    const startedAt = performance.now();
    const pending = client.callTool(callInput('Explain color theory step by step.'), undefined, { timeout: 65_000 });
    await upstream.waitFor(() => upstream.requests.length === 1, 'Provider dispatch');
    const result = await withinDeadline(pending, 'Aggregate timeout response', 65_000);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(59_000);
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'TUTOR_TIMEOUT' }] });
    expect(result.structuredContent).toBeUndefined();
    await upstream.waitFor(() => upstream.requests[0].disconnected, 'Timed-out provider cancellation');
    expect(upstream.requests.map(request => request.kind)).toEqual(['generation']);
    expect(lineage).not.toHaveBeenCalled();
  }, 70_000);
});
