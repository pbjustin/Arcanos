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
      status: 'ok',
      route: 'diagnostic',
      message: 'backend operational',
    });
  });

  it('returns bare gaming envelopes for explicit guide mode responses', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        route: 'gaming',
        mode: 'guide',
        data: {
          response: 'Guide response',
          sources: [],
        },
      },
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
      .send({ mode: 'guide', prompt: 'Where do I go next?' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      _route: {
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        route: 'gaming',
      },
      result: {
        ok: true,
        route: 'gaming',
        mode: 'guide',
        data: {
          response: 'Guide response',
          sources: {
            total: 0,
          },
        },
      },
    });
  });

  it('returns structured gaming errors when explicit mode is missing', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: false,
      error: {
        code: 'GAMEPLAY_MODE_REQUIRED',
        message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
      },
      _route: {
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        route: 'gaming',
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-gaming')
      .send({ prompt: 'Give me a walkthrough.' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      _route: {
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        route: 'gaming',
      },
      error: {
        code: 'GAMEPLAY_MODE_REQUIRED',
        message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
      },
    });
  });

  it('rejects body-level gptId on the canonical route before dispatching', async () => {
    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-gaming')
      .send({
        gptId: 'backstage-booker',
        prompt: 'Ping the gaming backend',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'BODY_GPT_ID_FORBIDDEN',
          message: 'gptId must be supplied by the /gpt/{gptId} path only.',
        },
        _route: expect.objectContaining({
          gptId: 'arcanos-gaming',
        }),
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('maps system state conflicts to HTTP 409 on the canonical route', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: false,
      error: {
        code: 'SYSTEM_STATE_CONFLICT',
        message: 'system_state update conflict',
        details: {
          expectedVersion: 1,
          currentVersion: 2,
        },
      },
      _route: {
        gptId: 'arcanos-daemon',
        module: 'ARCANOS:CORE',
        route: 'core',
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-daemon')
      .send({ action: 'system_state' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      ok: false,
      _route: {
        gptId: 'arcanos-daemon',
        module: 'ARCANOS:CORE',
        route: 'core',
      },
      error: {
        code: 'SYSTEM_STATE_CONFLICT',
        message: 'system_state update conflict',
        details: {
          expectedVersion: 1,
          currentVersion: 2,
        },
      },
    });
  });

  it('allows system_state reads without update fields on the canonical route', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        mode: 'system_state',
      },
      _route: {
        gptId: 'arcanos-daemon',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'system_state',
        availableActions: ['query', 'system_state'],
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-daemon')
      .send({ action: 'system_state' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          mode: 'system_state',
        },
        _route: expect.objectContaining({
          gptId: 'arcanos-daemon',
          action: 'system_state',
        }),
      })
    );
  });
});
