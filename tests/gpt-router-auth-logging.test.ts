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
  const originalGptRouteHardTimeoutMs = process.env.GPT_ROUTE_HARD_TIMEOUT_MS;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalGptRouteHardTimeoutMs === undefined) {
      delete process.env.GPT_ROUTE_HARD_TIMEOUT_MS;
    } else {
      process.env.GPT_ROUTE_HARD_TIMEOUT_MS = originalGptRouteHardTimeoutMs;
    }
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

  it('maps route-level aborts onto 504 MODULE_TIMEOUT envelopes', async () => {
    const abortError = new Error('GPT route timeout after 6000ms');
    abortError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValue(abortError);

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Inspect the backend worker.' });

    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'MODULE_TIMEOUT',
        message: 'GPT route timeout after 6000ms',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
      }),
    });
  });

  it('clips oversized configured GPT route timeout budgets to the bounded ceiling', async () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '60000';
    const abortError = new Error('GPT route timeout after 6000ms');
    abortError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValue(abortError);

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Inspect the backend worker.' });

    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'MODULE_TIMEOUT',
        message: 'GPT route timeout after 6000ms',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
      }),
    });
  });

  it('extends route-level timeout budgets for DAG execution prompts', async () => {
    const abortError = new Error('GPT route timeout after 8000ms');
    abortError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValue(abortError);

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'trigger a real DAG run and trace it live' });

    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'MODULE_TIMEOUT',
        message: 'GPT route timeout after 8000ms',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
      }),
    });
  });

  it('exposes DAG follow-up endpoints in shaped GPT responses', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        handledBy: 'dag-dispatcher',
        dag: {
          dispatchMode: 'automatic',
          reason: 'prompt_requests_dag_execution',
          summary: 'Started DAG run dagrun_test_followup.',
          runId: 'dagrun_test_followup',
          run: {
            runId: 'dagrun_test_followup',
            sessionId: 'sess-followup',
            status: 'queued',
            template: 'trinity-core',
            totalNodes: 5,
            completedNodes: 0,
            failedNodes: 0,
            createdAt: '2026-03-29T00:00:00.000Z',
            updatedAt: '2026-03-29T00:00:00.000Z',
          },
          artifactKeys: ['dag.run.create', 'dag.run.trace'],
          deferredTools: {
            total: 1,
            tools: ['dag.run.trace'],
          },
          followUp: {
            runId: 'dagrun_test_followup',
            trace: '/api/arcanos/dag/runs/dagrun_test_followup/trace',
            tree: '/api/arcanos/dag/runs/dagrun_test_followup/tree',
            lineage: '/api/arcanos/dag/runs/dagrun_test_followup/lineage',
            metrics: '/api/arcanos/dag/runs/dagrun_test_followup/metrics',
            errors: '/api/arcanos/dag/runs/dagrun_test_followup/errors',
            verification: '/api/arcanos/dag/runs/dagrun_test_followup/verification',
          },
        },
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'dag.run.create',
        availableActions: ['query', 'system_state'],
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'trigger a real DAG run and trace it live' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          handledBy: 'dag-dispatcher',
          dag: expect.objectContaining({
            runId: 'dagrun_test_followup',
            artifactKeys: ['dag.run.create', 'dag.run.trace'],
            deferredTools: {
              total: 1,
              tools: ['dag.run.trace'],
            },
            followUp: {
              runId: 'dagrun_test_followup',
              trace: '/api/arcanos/dag/runs/dagrun_test_followup/trace',
              tree: '/api/arcanos/dag/runs/dagrun_test_followup/tree',
              lineage: '/api/arcanos/dag/runs/dagrun_test_followup/lineage',
              metrics: '/api/arcanos/dag/runs/dagrun_test_followup/metrics',
              errors: '/api/arcanos/dag/runs/dagrun_test_followup/errors',
              verification: '/api/arcanos/dag/runs/dagrun_test_followup/verification',
            },
          }),
        },
        _route: expect.objectContaining({
          action: 'dag.run.create',
        }),
      })
    );
  });

  it('applies degraded pipeline headers when routed Trinity results recover under the clamp', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        result: 'Degraded answer',
        module: 'trinity',
        meta: {
          id: 'core-timeout-1',
          created: 1772917000000
        },
        activeModel: 'gpt-4.1-mini',
        fallbackFlag: true,
        dryRun: false,
        fallbackSummary: {
          intakeFallbackUsed: false,
          gpt5FallbackUsed: false,
          finalFallbackUsed: true,
          fallbackReasons: ['Recovered via direct answer']
        },
        auditSafe: {
          mode: true,
          overrideUsed: false,
          auditFlags: [],
          processedSafely: true
        },
        memoryContext: {
          entriesAccessed: 0,
          contextSummary: 'No memory context available.',
          memoryEnhanced: false,
          maxRelevanceScore: 0,
          averageRelevanceScore: 0
        },
        taskLineage: {
          requestId: 'core-timeout-1',
          logged: true
        },
        timeoutKind: 'pipeline_timeout',
        degradedModeReason: 'arcanos_core_pipeline_timeout_direct_answer',
        bypassedSubsystems: ['trinity_intake', 'trinity_reasoning']
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        availableActions: ['query']
      }
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Summarize the current state quickly.' });

    expect(response.status).toBe(200);
    expect(response.headers['x-ai-timeout-kind']).toBe('pipeline_timeout');
    expect(response.headers['x-ai-degraded-reason']).toBe('arcanos_core_pipeline_timeout_direct_answer');
    expect(response.headers['x-ai-bypassed-subsystems']).toBe('trinity_intake,trinity_reasoning');
  });
});
