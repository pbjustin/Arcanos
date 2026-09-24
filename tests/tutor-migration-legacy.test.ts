import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Real legacy HTTP router and new MCP authentication boundary. Only legacy
// execution/admission are fixtures; no provider, database, or user account runs.
const legacyDispatch = jest.fn(async ({ gptId }: { gptId: string }) => ({
  ok: true,
  result: { arcanos_tutor: 'A denominator counts equal parts in the whole.' },
  _route: {
    gptId, module: 'ARCANOS:TUTOR', route: 'tutor', action: 'query',
    timestamp: '2026-09-24T00:00:00.000Z',
  },
}));
const resolveLegacyRoute = jest.fn(async (gptId: string) => ({
  ok: true,
  plan: {
    matchedId: gptId, module: 'ARCANOS:TUTOR', route: 'tutor', action: 'query',
    availableActions: ['query'], moduleVersion: null, moduleDescription: null,
    matchMethod: 'exact',
  },
  _route: {
    gptId, module: 'ARCANOS:TUTOR', route: 'tutor', action: 'query',
    timestamp: '2026-09-24T00:00:00.000Z',
  },
}));
const forbiddenExternalCall = jest.fn(() => {
  throw new Error('External execution is forbidden in this migration fixture.');
});
const admitFixture = (_req: Request, _res: Response, next: NextFunction) => next();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: legacyDispatch,
  resolveGptRouting: resolveLegacyRoute,
}));
jest.unstable_mockModule('@platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(), logGptConnectionFailed: jest.fn(), logGptAckSent: jest.fn(),
}));
jest.unstable_mockModule('@transport/http/middleware/publicProviderAdmission.js', () => ({
  publicProviderGptAdmission: admitFixture,
  publicProviderRateLimit: admitFixture,
  resolvePublicProviderClientIdentity: () => 'mock-migration-client',
}));
jest.unstable_mockModule('@services/gptFastPath.js', () => ({
  executeFastGptPrompt: forbiddenExternalCall,
  executeDirectGptAction: forbiddenExternalCall,
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { createChatGptMcpRouter } = await import('../src/routes/chatgptMcp.js');
const { readChatGptAuthConfiguration } = await import('../src/chatgpt/auth.js');
type AuthConfiguration = Parameters<typeof createChatGptMcpRouter>[0];

const authFixture: Record<string, string> = {
  CHATGPT_MCP_ENABLED: 'true',
  CHATGPT_MCP_ISSUER: 'https://mock-migration-issuer.invalid/',
  CHATGPT_MCP_RESOURCE: 'https://mock-migration-resource.invalid/chatgpt/mcp',
  CHATGPT_MCP_JWKS_URL: 'https://mock-migration-issuer.invalid/jwks',
};
const enabled = readChatGptAuthConfiguration(name => authFixture[name]);

function buildApp(configuration: NonNullable<AuthConfiguration>['configuration']) {
  const app = express();
  app.use(createChatGptMcpRouter({
    configuration,
    verification: { keyResolver: forbiddenExternalCall, readEnvironmentValue: () => undefined },
    execute: forbiddenExternalCall,
    providerAdmission: admitFixture,
  }));
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenExternalCall);
});
afterEach(() => {
  try { expect(forbiddenExternalCall).not.toHaveBeenCalled(); }
  finally { jest.restoreAllMocks(); }
});

describe('Tutor migration preserves existing Custom GPT HTTP Actions', () => {
  it.each([
    ['disabled', { status: 'disabled' as const }, 404],
    ['misconfigured', { status: 'misconfigured' as const }, 503],
    ['enabled', enabled, 401],
  ] as const)('keeps legacy query operational while MCP is %s', async (_mode, configuration, mcpStatus) => {
    const app = buildApp(configuration);
    const deniedMcp = await request(app).post('/chatgpt/mcp').send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'arcanos_tutor', arguments: { prompt: 'Explain a denominator.' } },
    });
    expect(deniedMcp.status).toBe(mcpStatus);
    expect(legacyDispatch).not.toHaveBeenCalled();

    // Explicit sync selects the existing deterministic legacy route. Its default
    // query job policy is covered separately; this test does not alter that policy.
    const body = {
      action: 'query', executionMode: 'sync',
      payload: { prompt: 'Explain a denominator.', domain: 'default', module: 'generic' },
    };
    const legacy = await request(app).post('/gpt/arcanos-tutor')
      .set('x-gpt-execution-mode', 'orchestrated').send(body);
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({
      ok: true,
      result: { arcanos_tutor: 'A denominator counts equal parts in the whole.' },
      _route: { module: 'ARCANOS:TUTOR', route: 'tutor', action: 'query' },
    });
    expect(legacyDispatch).toHaveBeenCalledTimes(1);
    expect(legacyDispatch.mock.calls[0][0]).toMatchObject({
      gptId: 'arcanos-tutor', body, memoryPlaneAuthorized: undefined,
    });
    if (configuration.status === 'ready') {
      expect(deniedMcp.headers['www-authenticate']).toContain('arcanos:tutor');
      expect(deniedMcp.body).toEqual({ error: 'CHATGPT_AUTHORIZATION_REQUIRED' });
    }
  });
});
