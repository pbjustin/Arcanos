import express from 'express';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

const request = (await import('supertest')).default;
const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

describe('canonical GPT route validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveGptRouting.mockImplementation(async (gptId: string) => ({
      ok: true,
      plan: {
        matchedId: gptId,
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact'
      },
      _route: {
        gptId,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-24T00:00:00.000Z'
      }
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rejects body-level gptId overrides on the canonical route before dispatching', async () => {
    const app = buildApp();
    const res = await request(app).post('/gpt/arcanos-gaming').send({
      gptId: 'backstage-booker',
      prompt: 'Ping the gaming backend'
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('BODY_GPT_ID_FORBIDDEN');
    expect(res.body._route?.gptId).toBe('arcanos-gaming');
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('propagates query validation failures from dispatch as HTTP 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/gpt/arcanos-daemon').send({ action: 'query', sessionId: 'demo-session' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PROMPT_REQUIRED');
    expect(String(res.body.error?.message || '')).toContain('prompt');
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('forwards alternate prompt field aliases to canonical GPT dispatch', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        result: '[MOCK RESPONSE] Hello from test',
        activeModel: 'MOCK'
      },
      _route: {
        gptId: 'arcanos-daemon',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
      },
    });

    const app = buildApp();
    const res = await request(app).post('/gpt/arcanos-daemon').send({
      userInput: 'Hello from test',
      clientContext: { routingDirectives: ['concise'] }
    });

    expect(res.status).toBe(200);
    expect(res.body._route?.gptId).toBe('arcanos-daemon');
    expect(res.body._route?.action).toBe('query');
    expect(res.body.result?.result).toContain('[MOCK RESPONSE]');
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-daemon',
        body: {
          userInput: 'Hello from test',
          clientContext: { routingDirectives: ['concise'] }
        }
      })
    );
  });
});
