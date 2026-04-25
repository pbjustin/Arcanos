import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockExecuteSystemStateRequest = jest.fn();

class MockSystemStateConflictError extends Error {
  readonly code = 'SYSTEM_STATE_CONFLICT';

  constructor(readonly conflict: Record<string, unknown>) {
    super('system_state update conflict');
  }
}

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/services/systemState.js', () => ({
  executeSystemStateRequest: mockExecuteSystemStateRequest,
  SystemStateConflictError: MockSystemStateConflictError,
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
  const originalGptRouteAsyncCoreDefault = process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.clearAllMocks();
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'false';
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
    if (originalGptRouteHardTimeoutMs === undefined) {
      delete process.env.GPT_ROUTE_HARD_TIMEOUT_MS;
    } else {
      process.env.GPT_ROUTE_HARD_TIMEOUT_MS = originalGptRouteHardTimeoutMs;
    }
    if (originalGptRouteAsyncCoreDefault === undefined) {
      delete process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
    } else {
      process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = originalGptRouteAsyncCoreDefault;
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

  it('logs sanitized GPT request metadata without leaking prompt text', async () => {
    const promptMarker = 'QA-LOG-PRIVACY-MARKER-20260407';
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
      .send({
        prompt: `Inspect ${promptMarker} carefully`,
        messages: [{ role: 'user', content: `Inspect ${promptMarker} carefully` }],
      });

    expect(response.status).toBe(200);

    const rawStructuredLogs = consoleLogSpy.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
      .join('\n');
    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const requestMetaLog = logs.find((entry) => entry.event === 'gpt.request.meta');

    expect(requestMetaLog?.data).toMatchObject({
      endpoint: '/gpt/arcanos-gaming',
      gptId: 'arcanos-gaming',
      promptLength: `Inspect ${promptMarker} carefully`.length,
      messageCount: 1,
      promptLikeFields: ['messages', 'prompt'],
    });
    expect(requestMetaLog?.data?.promptHash).toEqual(expect.any(String));
    expect(requestMetaLog?.data?.bodyKeys).toEqual(['messages', 'prompt']);
    expect(rawStructuredLogs).not.toContain(promptMarker);
  });

  it('logs anonymous GPT requests so UI-auth mismatches are visible in traces', async () => {
    mockResolveGptRouting.mockResolvedValueOnce({
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
    expect(mockRouteGptRequest).not.toHaveBeenCalled();

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
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-gaming',
      action: 'query',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      _route: expect.objectContaining({
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        route: 'gaming',
        traceId: expect.any(String),
      }),
      error: {
        code: 'GAMEPLAY_MODE_REQUIRED',
        message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
      },
    }));
  });

  it('rejects mismatched body-level gptId on the canonical route before dispatching', async () => {
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
          message: 'body gptId must match the /gpt/{gptId} path parameter.',
        },
        _route: expect.objectContaining({
          gptId: 'arcanos-gaming',
        }),
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('maps system state conflicts to HTTP 409 on the canonical route', async () => {
    mockExecuteSystemStateRequest.mockImplementation(() => {
      throw new MockSystemStateConflictError({
        expectedVersion: 1,
        currentVersion: 2,
      });
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
      _route: expect.objectContaining({
        gptId: 'arcanos-daemon',
        action: 'system_state',
        route: 'system_state',
      }),
      error: {
        code: 'SYSTEM_STATE_CONFLICT',
        message: 'system_state update conflict',
        details: {
          expectedVersion: 1,
          currentVersion: 2,
        },
      },
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('allows system_state reads without update fields on the canonical route', async () => {
    mockExecuteSystemStateRequest.mockResolvedValue({
      mode: 'system_state',
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
          route: 'system_state',
        }),
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('accepts operation aliases for system_state on the canonical control route', async () => {
    mockExecuteSystemStateRequest.mockResolvedValue({
      mode: 'system_state',
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-daemon')
      .send({ operation: 'system_state' });

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
          route: 'system_state',
        }),
      })
    );
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects runtime control prompts before dispatching to the write plane', async () => {
    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'verify in production on the live backend runtime that is currently active' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      action: 'runtime.inspect',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        message: 'Runtime diagnostics, worker state, tracing, and queue inspection must use direct control-plane endpoints or POST /mcp. Do not send runtime control requests through POST /gpt/{gptId}.',
      },
      canonical: {
        status: '/status',
        workers: '/workers/status',
        workerHealth: '/worker-helper/health',
        selfHeal: '/status/safety/self-heal',
        mcp: '/mcp',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'control_guard',
        action: 'runtime.inspect',
      }),
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('maps route-level timeout aborts onto bounded ARCANOS fallback envelopes', async () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '6000';
    const abortError = new Error('GPT route timeout after 6000ms');
    abortError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValue(abortError);

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Explain how the backend worker is structured.' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          module: 'trinity',
          activeModel: 'arcanos-core:static-timeout-fallback',
          fallbackFlag: true,
          routingStages: ['ARCANOS-CORE-TIMEOUT-FALLBACK'],
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          module: 'ARCANOS:CORE',
          action: 'query',
          route: 'core',
        }),
      })
    );
  });

  it('terminates non-timeout aborts with a single deterministic aborted response', async () => {
    const abortError = new Error('Request was aborted.');
    abortError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValue(abortError);

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Explain how the backend worker is structured.' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'REQUEST_ABORTED',
        message: 'Request was aborted before completion.',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
      }),
    });

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    expect(logs.filter((entry) => entry.event === 'gpt.request.aborted')).toHaveLength(1);
    expect(logs.find((entry) => entry.event === 'gpt.request.timeout_fallback')).toBeUndefined();
  });

  it('clips oversized configured GPT route timeout budgets to the bounded ceiling', async () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '60000';
    const abortError = new Error('GPT route timeout after 60000ms');
    abortError.name = 'AbortError';
    mockRouteGptRequest.mockRejectedValue(abortError);

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({ prompt: 'Explain how the backend worker is structured.' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          module: 'trinity',
          activeModel: 'arcanos-core:static-timeout-fallback',
          fallbackFlag: true,
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          module: 'ARCANOS:CORE',
          action: 'query',
          route: 'core',
        }),
      })
    );
  });

  it('keeps workflow-like query prompts on the canonical GPT route', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: { handledBy: 'module-dispatch' },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
      },
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        action: 'query',
        prompt: 'Generate a phased workflow: inventory, classify, refactor, verify, report.',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'core',
        action: 'query',
      }),
    }));
    expect(JSON.parse(response.body.result)).toEqual({ handledBy: 'module-dispatch' });
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        body: expect.objectContaining({
          action: 'query',
          prompt: 'Generate a phased workflow: inventory, classify, refactor, verify, report.',
        }),
        bypassIntentRouting: true,
      })
    );
  });

  it('rejects explicit embedded DAG control actions before dispatching to the write plane', async () => {
    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'run the latest dag trace for me',
        payload: {
          action: 'dag.run.latest',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      action: 'dag.run.latest',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'DAG_CONTROL_REQUIRES_DIRECT_ENDPOINT',
        message: "DAG execution must use /api/arcanos/dag/*, POST /mcp, or POST /dispatch with target='dag'.",
      },
      canonical: {
        mcp: '/mcp',
        dispatch: '/dispatch',
        dagRuns: '/api/arcanos/dag/runs/{runId}',
        dagTrace: '/api/arcanos/dag/runs/{runId}/trace',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'control_guard',
        action: 'dag.run.latest',
      }),
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects explicit MCP control actions and points callers to /mcp', async () => {
    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use('/gpt', gptRouter);

    const response = await request(app)
      .post('/gpt/arcanos-core')
      .send({
        action: 'mcp.invoke',
        payload: {
          toolName: 'dag.run.latest',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      action: 'mcp.invoke',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'MCP_CONTROL_REQUIRES_MCP_API',
        message: 'MCP tool calls must use POST /mcp. Do not send MCP control requests through POST /gpt/{gptId}.',
      },
      canonical: {
        mcp: '/mcp',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'control_guard',
        action: 'mcp.invoke',
      }),
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('applies degraded pipeline headers when routed Trinity results recover under the clamp', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        result: 'Degraded answer',
        module: 'trinity',
        meta: {
          id: 'core-timeout-1',
          created: 1772917000000,
        },
        activeModel: 'gpt-4.1-mini',
        fallbackFlag: true,
        dryRun: false,
        fallbackSummary: {
          intakeFallbackUsed: false,
          gpt5FallbackUsed: false,
          finalFallbackUsed: true,
          fallbackReasons: ['Recovered via direct answer'],
        },
        auditSafe: {
          mode: true,
          overrideUsed: false,
          auditFlags: [],
          processedSafely: true,
        },
        memoryContext: {
          entriesAccessed: 0,
          contextSummary: 'No memory context available.',
          memoryEnhanced: false,
          maxRelevanceScore: 0,
          averageRelevanceScore: 0,
        },
        taskLineage: {
          requestId: 'core-timeout-1',
          logged: true,
        },
        timeoutKind: 'pipeline_timeout',
        degradedModeReason: 'arcanos_core_pipeline_timeout_direct_answer',
        bypassedSubsystems: ['trinity_intake', 'trinity_reasoning'],
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        availableActions: ['query'],
      },
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
