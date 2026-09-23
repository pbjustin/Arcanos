import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Real createApp, parsers, both authentication boundaries and the GPT HTTP
// route. External execution/startup dependencies below are deterministic fixtures.
const fixtureEnvironment: Record<string, string | undefined> = {
  NODE_ENV: 'test', DATABASE_URL: '', OPENAI_API_KEY: '', RAILWAY_OPENAI_API_KEY: '',
  API_KEY: '', OPENAI_KEY: '', RUN_WORKERS: 'false', DISABLE_EXTERNAL_CALLS: 'true',
  DISABLE_DIAGNOSTICS_CRON: 'true', DIAGNOSTICS_SHARED_METRICS: 'false',
  PUBLIC_PROVIDER_RATE_LIMIT_STORE: 'memory', PUBLIC_PROVIDER_RATE_LIMIT_MAX: '100',
  PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX: '100', PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS: '60000',
  MCP_BEARER_TOKEN: 'isolated-composition-operator-credential-for-test-only',
  MCP_ALLOWED_ORIGINS: '', JSON_LIMIT: '256kb',
  CHATGPT_MCP_ENABLED: undefined, CHATGPT_MCP_ISSUER: undefined,
  CHATGPT_MCP_RESOURCE: undefined, CHATGPT_MCP_JWKS_URL: undefined,
};
const originalEnvironment = new Map(Object.keys(fixtureEnvironment).map(name => [name, process.env[name]]));
for (const [name, value] of Object.entries(fixtureEnvironment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const initOpenAIMock = jest.fn();
const setupDiagnosticsMock = jest.fn();
const routeGptRequestMock = jest.fn(async ({ gptId }: { gptId: string }) => ({
  ok: true,
  result: { result: 'existing-tutor-action-fixture', module: 'ARCANOS:TUTOR' },
  _route: {
    requestId: 'isolated-composition-request', traceId: 'isolated-composition-trace',
    gptId, module: 'ARCANOS:TUTOR', action: 'query', route: 'tutor',
    availableActions: ['query'], moduleVersion: null, timestamp: '2026-09-22T00:00:00.000Z',
  },
}));
const resolveGptRoutingMock = jest.fn(async (gptId: string) => ({
  ok: true,
  plan: {
    matchedId: gptId, module: 'ARCANOS:TUTOR', route: 'tutor', action: 'query',
    availableActions: ['query'], moduleVersion: null, moduleDescription: null, matchMethod: 'exact',
  },
  _route: { gptId, module: 'ARCANOS:TUTOR', action: 'query', route: 'tutor', timestamp: '2026-09-22T00:00:00.000Z' },
}));
const operatorServers: Server[] = [];
const buildOperatorServerMock = jest.fn(async () => {
  const server = new Server({ name: 'isolated-operator-transport-fixture', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  operatorServers.push(server);
  await server.connect(transport);
  return { server, transport };
});

jest.unstable_mockModule('@core/init-openai.js', () => ({ initOpenAI: initOpenAIMock }));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: setupDiagnosticsMock,
  writePublicHealthResponse: jest.fn(async (_req: Request, res: Response) => res.status(200).json({ status: 'ok' })),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: { logStartupSummary: jest.fn(async () => undefined), recordRequestCompletion: jest.fn() },
}));
jest.unstable_mockModule('@transport/http/middleware/unsafeExecutionGate.js', () => ({
  unsafeExecutionGate: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.unstable_mockModule('@transport/http/gamingIngressAudit.js', () => ({
  gamingIngressAudit: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({ adapter: null, client: {} })),
  requireOpenAIClientOrAdapter: jest.fn(() => { throw new Error('External provider unavailable in composition fixture'); }),
}));
jest.unstable_mockModule('../src/mcp/server.js', () => ({ buildMcpServer: buildOperatorServerMock }));
jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock, resolveGptRouting: resolveGptRoutingMock,
}));

const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { CHATGPT_RESOURCE_METADATA_PATH } = await import('../src/chatgpt/auth.js');
const initializeRequest = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isolated-composition-client', version: '1.0.0' } },
};

function configureNewIntegration(mode: 'disabled' | 'misconfigured' | 'enabled'): void {
  process.env.CHATGPT_MCP_ENABLED = mode === 'disabled' ? 'false' : 'true';
  process.env.CHATGPT_MCP_ISSUER = 'https://composition-issuer.invalid/';
  process.env.CHATGPT_MCP_RESOURCE = 'https://composition-resource.invalid/chatgpt/mcp';
  if (mode === 'misconfigured') delete process.env.CHATGPT_MCP_JWKS_URL;
  else process.env.CHATGPT_MCP_JWKS_URL = 'https://composition-issuer.invalid/jwks';
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of ['CHATGPT_MCP_ENABLED', 'CHATGPT_MCP_ISSUER', 'CHATGPT_MCP_RESOURCE', 'CHATGPT_MCP_JWKS_URL']) {
    delete process.env[name];
  }
});

describe('ChatGPT integration in the real application composition', () => {
  it('constructs the application with the new integration absent and disabled by default', async () => {
    const app = createApp();
    expect(initOpenAIMock).toHaveBeenCalledTimes(1);
    expect(setupDiagnosticsMock).toHaveBeenCalledTimes(1);
    const transport = await request(app).post('/chatgpt/mcp').send(initializeRequest);
    const metadata = await request(app).get(CHATGPT_RESOURCE_METADATA_PATH);
    expect(transport.status).toBe(404);
    expect(metadata.status).toBe(404);
    expect(transport.body).toEqual({ error: 'CHATGPT_INTEGRATION_UNAVAILABLE' });
    expect(metadata.body).toEqual(transport.body);
    expect(buildOperatorServerMock).not.toHaveBeenCalled();
    expect(routeGptRequestMock).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'misconfigured'] as const)(
    'keeps operator authentication and existing Tutor GPT routing independent while %s', async mode => {
      configureNewIntegration(mode);
      const app = createApp();
      const newTransport = await request(app).post('/chatgpt/mcp').send(initializeRequest);
      const newMetadata = await request(app).get(CHATGPT_RESOURCE_METADATA_PATH);
      expect(newTransport.status).toBe(mode === 'disabled' ? 404 : 503);
      expect(newMetadata.status).toBe(newTransport.status);
      expect(newTransport.body).toEqual({ error: 'CHATGPT_INTEGRATION_UNAVAILABLE' });

      for (const credential of [undefined, 'unrelated-action-credential']) {
        const pending = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
        if (credential) pending.set('Authorization', `Bearer ${credential}`);
        const denied = await pending.send(initializeRequest);
        expect(denied.status).toBe(401);
        expect(denied.body).toEqual({ error: 'Unauthorized' });
      }
      expect(buildOperatorServerMock).not.toHaveBeenCalled();
      const operator = await request(app).post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${fixtureEnvironment.MCP_BEARER_TOKEN}`)
        .send(initializeRequest);
      expect(operator.status).toBe(200);
      expect(operator.body.result.serverInfo.name).toBe('isolated-operator-transport-fixture');
      expect(buildOperatorServerMock).toHaveBeenCalledTimes(1);

      const queuedTutor = await request(app).post('/gpt/arcanos-tutor')
        .send({ action: 'query', prompt: 'isolated composition question' });
      expect(queuedTutor.status).toBe(503);
      expect(queuedTutor.body.error.code).toBe('ASYNC_GPT_JOBS_UNAVAILABLE');
      expect(routeGptRequestMock).not.toHaveBeenCalled();
      const tutor = await request(app).post('/gpt/arcanos-tutor').send({ action: 'ping' });
      expect(tutor.status).toBe(200);
      expect(JSON.stringify(tutor.body)).toContain('existing-tutor-action-fixture');
      expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
      expect(routeGptRequestMock.mock.calls[0][0]).toMatchObject({ gptId: 'arcanos-tutor', memoryPlaneAuthorized: undefined });
    },
  );

  it.each(['{malformed JSON', JSON.stringify({ padding: 'x'.repeat(300_000) })])(
    'authenticates the enabled new route before either JSON parser allocates its body', async body => {
      configureNewIntegration('enabled');
      const app = createApp();
      const response = await request(app).post('/chatgpt/mcp')
        .set('Content-Type', 'application/json').send(body);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'CHATGPT_AUTHORIZATION_REQUIRED' });
      expect(response.headers['www-authenticate']).toContain(CHATGPT_RESOURCE_METADATA_PATH);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(buildOperatorServerMock).not.toHaveBeenCalled();
      expect(routeGptRequestMock).not.toHaveBeenCalled();
    },
  );

  it('does not reinterpret a valid legacy operator credential as new OAuth authority', async () => {
    configureNewIntegration('enabled');
    const app = createApp();
    const denied = await request(app).post('/chatgpt/mcp')
      .set('Authorization', `Bearer ${fixtureEnvironment.MCP_BEARER_TOKEN}`).send(initializeRequest);
    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ error: 'CHATGPT_AUTHORIZATION_REQUIRED' });
    expect(buildOperatorServerMock).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await Promise.all(operatorServers.map(server => server.close()));
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
