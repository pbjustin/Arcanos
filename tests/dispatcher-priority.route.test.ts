import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  resolveDispatchLane,
  type DispatchIntentDecision,
} from '../src/shared/dispatch/universalDispatch.js';

const controlPlaneToken = 'dispatch-dag-token-12345678901234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

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
  getWorkerControlHealth: jest.fn(),
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

function buildApp(options: {
  forceNonOperatorPrincipal?: boolean;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestContext);
  if (options.forceNonOperatorPrincipal) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'controlPlanePrincipal', {
        configurable: true,
        get: () => ({
          audience: 'control-plane-http',
          role: 'viewer',
          principalId: 'viewer:dispatch-dag',
          scopes: ['mcp:invoke'],
        }),
        set: () => undefined,
      });
      next();
    });
  }
  app.use('/gpt', gptRouter);
  app.use('/', dispatchRouter);
  return app;
}

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes = 'arcanos:read,mcp:invoke'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:dispatch-dag';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

const dagSelectorRequests = [
  ['target', {
    target: 'dag',
    prompt: 'Run the workflow now.',
  }],
  ['action', {
    action: 'dag.run.create',
    prompt: 'Run the workflow now.',
  }],
  ['execution mode', {
    executionMode: 'dag',
    prompt: 'Run the workflow now.',
  }],
  ['automatic classification', {
    executionMode: 'auto',
    prompt: 'Run the workflow now and poll the trace.',
  }],
] as const;

describe('dispatcher priority routing', () => {
  const originalGptRouteAsyncCoreDefault = process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'false';
    configureControlPlane();
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

  it('rejects unsupported explicit DAG bridge action on /gpt/{gptId}', async () => {
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
        code: 'GPT_DAG_ACTION_UNSUPPORTED',
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
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it('rejects oversized GPT identifiers before GPT routing or dispatch work', async () => {
    const oversizedGptId = 'x'.repeat(257);

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: oversizedGptId,
        action: 'query',
        prompt: 'Stop at the GPT identifier boundary.',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      target: 'gpt',
      routeFamily: 'dispatch',
      gptId: 'invalid',
      executionMode: 'gpt',
      error: {
        code: 'BAD_REQUEST',
        message: 'gptId too long',
      },
      _route: expect.objectContaining({
        gptId: 'invalid',
      }),
      _dispatch: {
        target: 'gpt',
        executionMode: 'gpt',
        reason: 'explicit_target_gpt',
      },
    }));
    expect(response.body.action).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(oversizedGptId);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it('preserves the structured invalid-ID envelope for oversized action metadata', async () => {
    const oversizedGptId = 'x'.repeat(257);
    const oversizedActionMarker = 'oversized-action-sentinel';
    const oversizedAction = `${oversizedActionMarker}:${'a'.repeat(40_000)}`;

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: oversizedGptId,
        action: oversizedAction,
        prompt: 'Stop before provider admission without reflecting oversized metadata.',
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      target: 'gpt',
      routeFamily: 'dispatch',
      gptId: 'invalid',
      executionMode: 'gpt',
      error: {
        code: 'BAD_REQUEST',
        message: 'gptId too long',
      },
      _route: expect.objectContaining({
        gptId: 'invalid',
      }),
      _dispatch: {
        target: 'gpt',
        executionMode: 'gpt',
        reason: 'explicit_target_gpt',
      },
    }));
    expect(response.body.action).toBeUndefined();
    expect(response.body.result).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(oversizedGptId);
    expect(JSON.stringify(response.body)).not.toContain(oversizedActionMarker);
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it('accepts an exactly 256-character explicit GPT identifier', async () => {
    const maximumLengthGptId = 'x'.repeat(256);

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: maximumLengthGptId,
        action: 'query',
        prompt: 'Continue to the GPT leaf.',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      target: 'gpt',
      gptId: maximumLengthGptId,
    }));
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      gptId: maximumLengthGptId,
    }));
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it.each([
    ['omitted', {}],
    ['blank', { gptId: '   ' }],
  ] as const)('preserves the default GPT identifier when body gptId is %s', async (
    _case,
    gptIdInput,
  ) => {
    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        ...gptIdInput,
        action: 'query',
        prompt: 'Use the default GPT identifier.',
      });

    expect(response.status).toBe(200);
    expect(response.body.gptId).toBe('arcanos-core');
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'arcanos-core',
    }));
  });

  it.each([
    ['MEMORY_AUTH_REQUIRED', 401],
    ['MEMORY_AUTH_UNAVAILABLE', 503],
  ] as const)('maps /dispatch %s failures to HTTP %i', async (errorCode, expectedStatus) => {
    mockRouteGptRequest.mockResolvedValue({
      ok: false,
      error: {
        code: errorCode,
        message: 'memory authentication failed',
      },
      _route: {
        gptId: 'arcanos-core',
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'memory',
        timestamp: '2026-04-25T00:00:00.000Z',
      },
    });

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'arcanos-core',
        prompt: 'Remember the release marker.',
      });

    expect(response.status).toBe(expectedStatus);
    expect(response.body.error.code).toBe(errorCode);
  });

  it.each(dagSelectorRequests)(
    'protects the %s DAG selector from anonymous execution',
    async (_selector, body) => {
      const response = await request(buildApp())
        .post('/dispatch')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(mockCreateDagRun).not.toHaveBeenCalled();
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }
  );

  it.each(dagSelectorRequests)(
    'routes the authorized %s DAG selector to DAG execution',
    async (_selector, body) => {
      const response = await request(buildApp())
        .post('/dispatch')
        .set('Authorization', `Bearer ${controlPlaneToken}`)
        .send(body);

      expect(response.status).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        target: 'dag',
        operation: 'dag.run.create',
        executionMode: 'dag',
      }));
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(mockCreateDagRun).toHaveBeenCalledTimes(1);
      expect(mockCreateDagRun).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({
          goal: body.prompt,
        }),
      }));
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
    }
  );

  it('protects a form-encoded DAG selector after body parsing', async () => {
    const response = await request(buildApp())
      .post('/dispatch')
      .type('form')
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(mockCreateDagRun).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('lets target=dag outrank an unused oversized GPT id after DAG authorization', async () => {
    const response = await request(buildApp())
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        target: 'dag',
        gptId: 'x'.repeat(257),
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      target: 'dag',
      operation: 'dag.run.create',
    }));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockCreateDagRun).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['DAG action', { action: 'dag.run.create', executionMode: 'auto' }],
    ['DAG mode', { action: 'query', executionMode: 'dag' }],
  ] as const)('lets an explicit GPT id outrank %s without DAG authentication', async (
    _selector,
    selection
  ) => {
    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        ...selection,
        gptId: 'arcanos-core',
        prompt: 'Run the workflow now and poll the trace.',
      });

    expect(response.status).toBe(200);
    expect(response.body.target).toBe('gpt');
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateDagRun).not.toHaveBeenCalled();
  });

  it.each(['mcp', 'tool'] as const)(
    'keeps explicit %s control rejection ahead of an unused oversized GPT id',
    async (target) => {
      const response = await request(buildApp())
        .post('/dispatch')
        .send({
          target,
          gptId: 'x'.repeat(257),
          action: 'dag.run.create',
          executionMode: 'dag',
          prompt: 'Run the workflow now.',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MCP_CONTROL_REQUIRES_MCP_API');
      expect(mockRouteGptRequest).not.toHaveBeenCalled();
      expect(mockCreateDagRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a malformed bearer', 'malformed', 'arcanos:read,mcp:invoke', 401, 'CONTROL_PLANE_AUTH_REQUIRED'],
    ['the wrong scope', `Bearer ${controlPlaneToken}`, 'arcanos:read', 403, 'CONTROL_PLANE_SCOPE_DENIED'],
  ] as const)('denies DAG execution for %s without creating a run', async (
    _case,
    authorization,
    scopes,
    expectedStatus,
    expectedCode
  ) => {
    configureControlPlane(scopes);
    const response = await request(buildApp())
      .post('/dispatch')
      .set('Authorization', authorization)
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(expectedStatus);
    expect(response.body.error.code).toBe(expectedCode);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockCreateDagRun).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('denies a non-operator DAG principal without creating a run', async () => {
    const response = await request(buildApp({ forceNonOperatorPrincipal: true }))
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_FORBIDDEN');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(mockCreateDagRun).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('fails closed for unavailable DAG authentication without creating a run', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockCreateDagRun).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported DAG action', {
      action: 'dag.run.cancel',
      prompt: 'Cancel the workflow now.',
    }, 'DAG_ACTION_UNSUPPORTED'],
    ['missing DAG input', {
      target: 'dag',
    }, 'DAG_INPUT_REQUIRED'],
  ] as const)('marks the %s response no-store', async (
    _case,
    body,
    expectedCode
  ) => {
    const response = await request(buildApp())
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(expectedCode);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockCreateDagRun).not.toHaveBeenCalled();
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
      .set('Authorization', `Bearer ${controlPlaneToken}`)
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

describe('dispatch lane resolution', () => {
  it.each([
    ['explicit DAG target', {
      target: 'dag',
      gptId: 'arcanos-core',
      action: 'query',
      executionMode: 'tool',
    }, 'dag', 'explicit_target_dag', undefined],
    ['explicit GPT target', {
      target: 'gpt',
      action: 'dag.run.create',
      executionMode: 'dag',
    }, 'gpt', 'explicit_target_gpt', undefined],
    ['explicit MCP target', {
      target: 'mcp',
      gptId: 'arcanos-core',
      action: 'dag.run.create',
      executionMode: 'dag',
    }, 'reject-control', 'explicit_target_mcp', 'mcp'],
    ['explicit tool target', {
      target: 'tool',
      gptId: 'arcanos-core',
      action: 'dag.run.create',
      executionMode: 'dag',
    }, 'reject-control', 'explicit_target_tool', 'tool'],
    ['explicit GPT id', {
      gptId: 'Arcanos-Custom',
      action: 'dag.run.create',
      executionMode: 'dag',
    }, 'gpt', 'explicit_gpt_id', undefined],
    ['DAG action before tool mode', {
      action: 'dag.run.create',
      executionMode: 'tool',
    }, 'dag', 'explicit_dag_action', undefined],
    ['DAG action before DAG mode reason', {
      action: 'dag.run.create',
      executionMode: 'dag',
    }, 'dag', 'explicit_dag_action', undefined],
    ['DAG execution mode', {
      action: 'query',
      executionMode: 'dag',
    }, 'dag', 'explicit_execution_mode_dag', undefined],
    ['tool execution mode', {
      action: 'query',
      executionMode: 'tool',
    }, 'reject-control', 'explicit_execution_mode_tool', 'tool'],
    ['GPT execution mode', {
      action: 'query',
      executionMode: 'gpt',
      prompt: 'Run the workflow now.',
    }, 'gpt', 'explicit_execution_mode_gpt', undefined],
  ] as const)('preserves precedence for %s', (
    _case,
    body,
    expectedLane,
    expectedReason,
    expectedRejectionTarget
  ) => {
    const classifier = jest.fn<(_input: unknown) => DispatchIntentDecision>(() => ({
      mode: 'dag',
      confidence: 1,
      reason: 'must_not_run',
    }));

    const resolution = resolveDispatchLane(body, classifier);

    expect(resolution.lane).toBe(expectedLane);
    expect(resolution.reason).toBe(expectedReason);
    if (resolution.lane === 'reject-control') {
      expect(resolution.rejectionTarget).toBe(expectedRejectionTarget);
    } else {
      expect(expectedRejectionTarget).toBeUndefined();
    }
    expect(classifier).not.toHaveBeenCalled();
  });

  it('selects DAG actions case-insensitively without rewriting the action', () => {
    const classifier = jest.fn<(_input: unknown) => DispatchIntentDecision>();
    const resolution = resolveDispatchLane({
      action: '  DAG.RUN.CREATE  ',
      executionMode: 'auto',
    }, classifier);

    expect(resolution).toEqual(expect.objectContaining({
      lane: 'dag',
      reason: 'explicit_dag_action',
      input: expect.objectContaining({
        action: 'DAG.RUN.CREATE',
      }),
    }));
    expect(classifier).not.toHaveBeenCalled();
  });

  it.each([
    [0.85, 'dag', 'threshold_test:0.85'],
    [0.849_999, 'gpt', 'safe_fallback_gpt'],
  ] as const)('applies the inclusive DAG confidence threshold at %s', (
    confidence,
    expectedLane,
    expectedReason
  ) => {
    const resolution = resolveDispatchLane(
      {
        executionMode: 'auto',
        prompt: 'classifier-controlled prompt',
      },
      () => ({
        mode: 'dag',
        confidence,
        reason: 'threshold_test',
      })
    );

    expect(resolution.lane).toBe(expectedLane);
    expect(resolution.reason).toBe(expectedReason);
  });

  it.each([
    [undefined],
    [null],
    ['dispatch'],
    [42],
    [true],
    [[]],
    [{ executionMode: 'invalid', prompt: 'Run the workflow now.' }],
  ])('keeps non-record or defaulted input on the GPT lane: %p', (body) => {
    const classifier = jest.fn<(_input: unknown) => DispatchIntentDecision>();
    const resolution = resolveDispatchLane(body, classifier);

    expect(resolution).toEqual(expect.objectContaining({
      lane: 'gpt',
      reason: 'explicit_execution_mode_gpt',
      input: expect.objectContaining({
        target: 'auto',
        executionMode: 'gpt',
      }),
    }));
    expect(classifier).not.toHaveBeenCalled();
  });

  it('keeps content-generation workflow prompts on GPT in auto mode', () => {
    const resolution = resolveDispatchLane({
      executionMode: 'auto',
      prompt: 'Generate a workflow, then run through its documentation now.',
    });

    expect(resolution).toEqual(expect.objectContaining({
      lane: 'gpt',
      reason: 'safe_fallback_gpt',
    }));
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});
