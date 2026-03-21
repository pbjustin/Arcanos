import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

type LoggedPayload = {
  event?: string;
  level?: string;
  path?: string;
  data?: Record<string, unknown>;
};

function collectStructuredLogs(logCalls: unknown[][]): LoggedPayload[] {
  return logCalls
    .map((call) => {
      const firstArg = call[0];
      if (typeof firstArg !== 'string') {
        return null;
      }

      try {
        return JSON.parse(firstArg) as LoggedPayload;
      } catch {
        return null;
      }
    })
    .filter((payload): payload is LoggedPayload => payload !== null);
}

describe('gpt router auth logging', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('logs authenticated GPT requests with attached auth headers and final endpoint', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: { gaming_response: 'ok' },
      _route: {
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        route: 'gaming',
        availableActions: ['query'],
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-gaming')
      .set('Authorization', 'Bearer test-session-token')
      .set('Cookie', 'session=abc123')
      .set('x-confirmed', 'yes')
      .send({ prompt: 'Ping the gaming backend' });

    expect(response.status).toBe(200);

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const authLog = logs.find((entry) => entry.event === 'gpt.request.auth_state');
    const routeResultLog = logs.find((entry) => entry.event === 'gpt.request.route_result');

    expect(authLog?.path).toBe('/gpt/arcanos-gaming');
    expect(authLog?.data).toMatchObject({
      endpoint: '/gpt/arcanos-gaming',
      gptId: 'arcanos-gaming',
      authenticated: true,
      authSource: 'authorization-header',
      bearerPresent: true,
      webStatePresent: true,
      csrfPresent: false,
      confirmedYes: true,
      gptPathHeaderPresent: false,
    });
    expect(routeResultLog?.data).toMatchObject({
      endpoint: '/gpt/arcanos-gaming',
      gptId: 'arcanos-gaming',
      statusCode: 200,
      ok: true,
      module: 'ARCANOS:GAMING',
      route: 'gaming',
    });
  });

  it('logs anonymous GPT requests so UI-auth mismatches are visible in traces', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: false,
      error: {
        code: 'UNKNOWN_GPT',
        message: "gptId 'unknown-gpt' is not registered",
      },
      _route: {
        gptId: 'unknown-gpt',
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/unknown-gpt')
      .send({ prompt: 'Ping the backend anonymously' });

    expect(response.status).toBe(404);

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const authLog = logs.find((entry) => entry.event === 'gpt.request.auth_state');
    const routeResultLog = logs.find((entry) => entry.event === 'gpt.request.route_result');

    expect(authLog?.data).toMatchObject({
      endpoint: '/gpt/unknown-gpt',
      gptId: 'unknown-gpt',
      authenticated: false,
      authSource: 'anonymous',
      bearerPresent: false,
      webStatePresent: false,
      csrfPresent: false,
      confirmedYes: false,
      gptPathHeaderPresent: false,
    });
    expect(routeResultLog?.data).toMatchObject({
      endpoint: '/gpt/unknown-gpt',
      gptId: 'unknown-gpt',
      statusCode: 404,
      ok: false,
      errorCode: 'UNKNOWN_GPT',
    });
  });

  it('returns bare diagnostic JSON instead of the dispatcher envelope for ping probes', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        route: 'diagnostic',
        message: 'backend operational',
      },
      _route: {
        gptId: 'arcanos-gaming',
        module: 'diagnostic',
        route: 'diagnostic',
        availableActions: [],
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-gaming')
      .send({ action: 'ping' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      route: 'diagnostic',
      message: 'backend operational',
    });
  });
});
