import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
process.env.LEGACY_GPT_ROUTES = 'enabled';

const express = (await import('express')).default;
const request = (await import('supertest')).default;

const mockRouteGptRequest = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest
}));

const arcanosRouter = (await import('../src/routes/arcanos.js')).default;
const aiEndpointsRouter = (await import('../src/routes/ai-endpoints.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', arcanosRouter);
  app.use('/', aiEndpointsRouter);
  return app;
}

describe('legacy root route compatibility', () => {
  afterAll(() => {
    if (originalLegacyGptRoutes === undefined) {
      delete process.env.LEGACY_GPT_ROUTES;
      return;
    }

    process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [
      '/arcanos',
      { userInput: 'inspect system', sessionId: 'sess-42', overrideAuditSafe: 'force' },
      '/gpt/arcanos-core',
      'arcanos',
      {
        action: 'query',
        payload: {
          prompt: 'inspect system',
          sessionId: 'sess-42',
          overrideAuditSafe: 'force'
        }
      }
    ],
    ['/write', { prompt: 'draft copy' }, '/gpt/write', 'write', { action: 'query', payload: { prompt: 'draft copy' } }],
    ['/guide', { prompt: 'show steps' }, '/gpt/guide', 'guide', { action: 'query', payload: { prompt: 'show steps' } }],
    ['/sim', { prompt: 'model scenario' }, '/gpt/sim', 'sim', { action: 'run', payload: { prompt: 'model scenario' } }]
  ] as const)(
    'preserves the legacy response shape for %s',
    async (path, body, canonicalRoute, endpointName, expectedDispatchBody) => {
      mockRouteGptRequest.mockResolvedValue({
        ok: true,
        result: {
          activeModel: 'MOCK'
        },
        _route: {
          gptId: endpointName,
          timestamp: '2026-04-08T00:00:00.000Z'
        }
      });

      const response = await request(buildApp())
        .post(path)
        .set('x-confirmed', 'yes')
        .send(body);

      expect(response.status).toBe(200);
      expect(response.headers['x-canonical-route']).toBe(canonicalRoute);
      expect(response.headers['x-route-deprecated']).toBe('true');
      expect(response.body.ok).toBeUndefined();
      expect(response.body._route).toBeUndefined();
      expect(mockRouteGptRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expectedDispatchBody
        })
      );

      if (endpointName === 'arcanos') {
        expect(response.body.result).toContain('[MOCK ARCANOS RESPONSE]');
        expect(response.body.componentStatus).toBeDefined();
        expect(response.body.suggestedFixes).toBeDefined();
        expect(response.body.coreLogicTrace).toBeDefined();
        return;
      }

      if (endpointName === 'write') {
        expect(response.body.result).toContain('[MOCK WRITE RESPONSE]');
      }
      if (endpointName === 'guide') {
        expect(response.body.result).toContain('[MOCK GUIDE RESPONSE]');
      }
      if (endpointName === 'sim') {
        expect(response.body.result).toContain('[MOCK SIMULATION RESPONSE]');
      }
      expect(response.body.endpoint).toBe(endpointName);
    }
  );

  it.each([
    ['/arcanos', { userInput: 'inspect system' }, '/gpt/arcanos-core'],
    ['/write', { prompt: 'draft copy' }, '/gpt/write'],
    ['/guide', { prompt: 'show steps' }, '/gpt/guide'],
    ['/sim', { prompt: 'model scenario' }, '/gpt/sim']
  ] as const)(
    'keeps deprecation metadata on 403 confirmation blocks for %s',
    async (path, body, canonicalRoute) => {
      const response = await request(buildApp())
        .post(path)
        .send(body);

      expect(response.status).toBe(403);
      expect(response.headers['x-canonical-route']).toBe(canonicalRoute);
      expect(response.headers.deprecation).toBe('true');
      expect(response.headers.sunset).toBeDefined();
      expect(response.headers.link).toContain(canonicalRoute);
      expect(response.body.canonicalRoute).toBe(canonicalRoute);
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['UNKNOWN_GPT', 404],
    ['SYSTEM_STATE_CONFLICT', 409],
    ['MODULE_TIMEOUT', 504]
  ] as const)(
    'passes through shim error status %s',
    async (errorCode, expectedStatus) => {
      mockRouteGptRequest.mockResolvedValue({
        ok: false,
        error: {
          code: errorCode,
          message: 'dispatcher failure'
        },
        _route: {
          gptId: 'write',
          timestamp: '2026-04-08T00:00:00.000Z'
        }
      });

      const response = await request(buildApp())
        .post('/write')
        .set('x-confirmed', 'yes')
        .send({ prompt: 'draft copy' });

      expect(response.status).toBe(expectedStatus);
      expect(response.headers['x-canonical-route']).toBe('/gpt/write');
      expect(response.body.error.code).toBe(errorCode);
    }
  );
});
