import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockVerificationRouter = express.Router();

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordDagTraceTimeout: jest.fn(),
  recordDispatcherFallback: jest.fn(),
  recordDispatcherMisroute: jest.fn(),
  recordDispatcherRoute: jest.fn(),
  recordHttpRequestCompletion: jest.fn(),
  recordHttpRequestEnd: jest.fn(),
  recordHttpRequestStart: jest.fn(),
  recordMcpAutoInvoke: jest.fn(),
  recordMemoryDispatchIgnored: jest.fn(),
  recordUnknownGpt: jest.fn(),
  resolveMetricRouteLabel: jest.fn(() => '/test'),
  shouldSkipHttpMetrics: jest.fn(() => false),
}));

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/routes/api-arcanos-verification.js', () => ({
  default: mockVerificationRouter,
}));

const { default: apiArcanosRouter } = await import('../src/routes/api-arcanos.js');

function createApiArcanosTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/arcanos', apiArcanosRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  });

  return app;
}

describe('/api/arcanos/ask compatibility', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApiArcanosTestApp();
  });

  it('preserves legacy ping health checks without invoking GPT routing', async () => {
    const response = await request(app).post('/api/arcanos/ask').send({
      prompt: 'ping',
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-deprecated-endpoint']).toBe('/api/arcanos/ask');
    expect(response.headers['x-canonical-route']).toBe('/gpt/arcanos-core');
    expect(response.body).toMatchObject({
      success: true,
      result: 'pong',
      metadata: {
        deprecatedEndpoint: true,
        canonicalRoute: '/gpt/arcanos-core',
      },
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rewrites deprecated ask traffic through arcanos-core query dispatch', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        result: 'Hello',
        activeModel: 'gpt-4.1',
        fallbackFlag: false,
        routingStages: ['ARCANOS-INTAKE', 'ARCANOS-DIRECT-ANSWER'],
      },
      _route: {
        requestId: 'req_compat',
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        action: 'query',
        matchMethod: 'exact',
        route: 'core',
        availableActions: ['query', 'system_state'],
        timestamp: '2026-03-24T03:40:00.000Z',
      },
    });

    const response = await request(app).post('/api/arcanos/ask').send({
      prompt: 'Say hello in one word.',
    });

    expect(response.status).toBe(200);
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        body: expect.objectContaining({
          prompt: 'Say hello in one word.',
          action: 'query',
        }),
      })
    );
    expect(response.body).toMatchObject({
      success: true,
      result: 'Hello',
      metadata: {
        model: 'gpt-4.1',
        deprecatedEndpoint: true,
        canonicalRoute: '/gpt/arcanos-core',
        route: 'core',
        gptId: 'arcanos-core',
      },
    });
  });

  it('returns canonical validation errors as 400 responses', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Request must include message/prompt (or messages[])',
      },
      _route: {
        requestId: 'req_bad_request',
        gptId: 'arcanos-core',
        timestamp: '2026-03-24T03:41:00.000Z',
      },
    });

    const response = await request(app).post('/api/arcanos/ask').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: 'Request must include message/prompt (or messages[])',
      metadata: {
        deprecatedEndpoint: true,
        canonicalRoute: '/gpt/arcanos-core',
      },
    });
  });
});
