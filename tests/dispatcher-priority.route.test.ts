import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockExecuteSystemStateRequest = jest.fn();
const mockCreateDagRun = jest.fn();

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

jest.unstable_mockModule('../src/services/runtimeInspectionRoutingService.js', () => ({
  executeRuntimeInspection: jest.fn(),
  classifyRuntimeInspectionPrompt: jest.fn(() => ({
    detectedIntent: 'STANDARD',
    matchedKeywords: [],
    repoInspectionDisabled: false,
    onlyReturnRuntimeValues: false,
  })),
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: jest.fn(),
}));

jest.unstable_mockModule('../src/services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: jest.fn(),
}));

jest.unstable_mockModule('../src/core/diagnostics.js', () => ({
  getDiagnosticsSnapshot: jest.fn(),
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    createRun: mockCreateDagRun,
  },
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { default: dispatchRouter } = await import('../src/routes/dispatch.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  app.use('/', dispatchRouter);
  return app;
}

describe('dispatcher priority routing', () => {
  const originalGptRouteAsyncCoreDefault = process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;

  beforeEach(() => {
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
        matchMethod: 'exact',
      },
      _route: {
        gptId,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-25T00:00:00.000Z',
      },
    }));
    mockRouteGptRequest.mockImplementation(async ({ gptId, body }: { gptId: string; body: Record<string, unknown> }) => ({
      ok: true,
      result: {
        handledBy: 'module-dispatch',
        gptId,
        action: body.action ?? 'query',
      },
      _route: {
        gptId,
        module: 'ARCANOS:CORE',
        route: 'core',
        action: body.action ?? 'query',
        timestamp: '2026-04-25T00:00:00.000Z',
      },
    }));
    mockCreateDagRun.mockResolvedValue({
      runId: 'dag-run-1',
      sessionId: 'req-1',
      template: 'trinity-core',
      status: 'queued',
    });
  });

  afterEach(() => {
    if (originalGptRouteAsyncCoreDefault === undefined) {
      delete process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;
    } else {
      process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = originalGptRouteAsyncCoreDefault;
    }
  });

  it('keeps /gpt/{gptId} action=query workflow-like prompts on GPT', async () => {
    const response = await request(buildApp())
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
        action: 'query',
      }),
    }));
    expect(JSON.parse(response.body.result)).toEqual(expect.objectContaining({
      gptId: 'arcanos-core',
      action: 'query',
    }));
    expect(JSON.stringify(response.body)).not.toContain('dag.run.create');
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it('rejects explicit DAG action on /gpt/{gptId}', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'dag.run.create',
        prompt: 'Start a DAG.',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      action: 'dag.run.create',
      error: expect.objectContaining({
        code: 'DAG_CONTROL_REQUIRES_DIRECT_ENDPOINT',
      }),
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it('honors gptId on /dispatch before classifier intent', async () => {
    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        gptId: 'arcanos-core',
        action: 'query',
        executionMode: 'auto',
        prompt: 'Run the workflow now and poll the trace.',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      target: 'gpt',
      gptId: 'arcanos-core',
      action: 'query',
      executionMode: 'gpt',
    }));
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'arcanos-core',
    }));
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it('routes /dispatch target=dag to DAG execution', async () => {
    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      target: 'dag',
      action: 'query',
      operation: 'dag.run.create',
      executionMode: 'dag',
    }));
    expect(mockCreateDagRun).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        goal: 'Run the workflow now.',
      }),
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('only classifier-routes auto dispatch to DAG above the confidence threshold', async () => {
    const contentResponse = await request(buildApp())
      .post('/dispatch')
      .send({
        executionMode: 'auto',
        prompt: 'Generate a workflow for inventory, classification, refactor, verify, report.',
      });

    expect(contentResponse.status).toBe(200);
    expect(contentResponse.body).toEqual(expect.objectContaining({
      target: 'gpt',
      action: 'query',
    }));
    expect(mockCreateDagRun).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: { handledBy: 'module-dispatch' },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        timestamp: '2026-04-25T00:00:00.000Z',
      },
    });
    mockCreateDagRun.mockResolvedValue({
      runId: 'dag-run-2',
      sessionId: 'req-2',
      template: 'trinity-core',
      status: 'queued',
    });

    const dagResponse = await request(buildApp())
      .post('/dispatch')
      .send({
        executionMode: 'auto',
        prompt: 'Run the workflow now and poll the trace.',
      });

    expect(dagResponse.status).toBe(202);
    expect(dagResponse.body).toEqual(expect.objectContaining({
      target: 'dag',
      action: 'query',
      operation: 'dag.run.create',
    }));
    expect(mockCreateDagRun).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('does not let prompt text override explicit target, gptId, action, or executionMode', async () => {
    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'arcanos-core',
        action: 'query',
        executionMode: 'gpt',
        prompt: 'Run the DAG workflow now and poll the trace.',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      target: 'gpt',
      gptId: 'arcanos-core',
      action: 'query',
      executionMode: 'gpt',
    }));
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'arcanos-core',
      body: expect.objectContaining({
        action: 'query',
        prompt: 'Run the DAG workflow now and poll the trace.',
        executionMode: 'gpt',
      }),
    }));
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });
});
