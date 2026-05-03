import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockGetFeatureFlags = jest.fn();
const mockGetExecutionLimits = jest.fn();
const mockCreateRun = jest.fn();
const mockWaitForRunUpdate = jest.fn();
const mockGetRunTrace = jest.fn();
const redactionBearerValue = ['Bearer', 'abcdefghijklmnop'].join(' ');
const redactionApiKey = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');
const bridgeBearerToken = 'expected-bridge-token';
const invalidBridgeBearerToken = 'wrong-token';

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    getFeatureFlags: mockGetFeatureFlags,
    getExecutionLimits: mockGetExecutionLimits,
    createRun: mockCreateRun,
    waitForRunUpdate: mockWaitForRunUpdate,
    getRunTrace: mockGetRunTrace,
  },
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { UnsupportedDagTemplateError } = await import('../src/dag/templates.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    pipeline: 'trinity',
    trinity_version: '1.0',
    runId: 'dagrun_bridge_1',
    sessionId: 'gpt.arcanos-core.trace-1',
    template: 'trinity-core',
    status: 'queued',
    createdAt: '2026-04-27T10:00:00.000Z',
    updatedAt: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('GPT DAG bridge route', () => {
  const originalDagBridgeEnabled = process.env.GPT_DAG_BRIDGE_ENABLED;
  const originalDagBridgeAllowedGpts = process.env.GPT_DAG_BRIDGE_ALLOWED_GPTS;
  const originalDagBridgeRequireAuth = process.env.GPT_DAG_BRIDGE_REQUIRE_AUTH;
  const originalDagBridgeBearerToken = process.env.GPT_DAG_BRIDGE_BEARER_TOKEN;
  const originalOpenAiActionSharedSecret = process.env.OPENAI_ACTION_SHARED_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GPT_DAG_BRIDGE_ENABLED = 'true';
    process.env.GPT_DAG_BRIDGE_ALLOWED_GPTS = 'arcanos-core';
    delete process.env.GPT_DAG_BRIDGE_REQUIRE_AUTH;
    delete process.env.GPT_DAG_BRIDGE_BEARER_TOKEN;
    delete process.env.OPENAI_ACTION_SHARED_SECRET;

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
        timestamp: '2026-04-27T00:00:00.000Z',
      },
    }));
    mockGetFeatureFlags.mockReturnValue({
      dagOrchestration: true,
      parallelExecution: true,
      recursiveSpawning: false,
      jobTreeInspection: true,
      eventStreaming: false,
    });
    mockGetExecutionLimits.mockReturnValue({
      maxConcurrency: 5,
      maxSpawnDepth: 3,
      maxChildrenPerNode: 5,
      maxRetriesPerNode: 2,
      maxAiCallsPerRun: 20,
      defaultNodeTimeoutMs: 180000,
    });
    mockCreateRun.mockResolvedValue(buildRun());
    mockWaitForRunUpdate.mockResolvedValue({
      run: buildRun({ status: 'running' }),
      updated: true,
      waited: false,
    });
    mockGetRunTrace.mockResolvedValue({
      pipeline: 'trinity',
      trinity_version: '1.0',
      run: buildRun({ status: 'running' }),
      events: {
        runId: 'dagrun_bridge_1',
        events: [
          {
            eventId: 'evt-1',
            type: 'run.started',
            at: '2026-04-27T10:00:00.000Z',
            data: {
              ['author' + 'ization']: redactionBearerValue,
              ['api_' + 'key']: redactionApiKey,
              safe: 'kept',
            },
          },
        ],
      },
    });
  });

  afterEach(() => {
    if (originalDagBridgeEnabled === undefined) {
      delete process.env.GPT_DAG_BRIDGE_ENABLED;
    } else {
      process.env.GPT_DAG_BRIDGE_ENABLED = originalDagBridgeEnabled;
    }
    if (originalDagBridgeAllowedGpts === undefined) {
      delete process.env.GPT_DAG_BRIDGE_ALLOWED_GPTS;
    } else {
      process.env.GPT_DAG_BRIDGE_ALLOWED_GPTS = originalDagBridgeAllowedGpts;
    }
    if (originalDagBridgeRequireAuth === undefined) {
      delete process.env.GPT_DAG_BRIDGE_REQUIRE_AUTH;
    } else {
      process.env.GPT_DAG_BRIDGE_REQUIRE_AUTH = originalDagBridgeRequireAuth;
    }
    if (originalDagBridgeBearerToken === undefined) {
      delete process.env.GPT_DAG_BRIDGE_BEARER_TOKEN;
    } else {
      process.env.GPT_DAG_BRIDGE_BEARER_TOKEN = originalDagBridgeBearerToken;
    }
    if (originalOpenAiActionSharedSecret === undefined) {
      delete process.env.OPENAI_ACTION_SHARED_SECRET;
    } else {
      process.env.OPENAI_ACTION_SHARED_SECRET = originalOpenAiActionSharedSecret;
    }
  });

  it('returns DAG-safe capabilities without entering Trinity', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'dag.capabilities' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      gptId: 'arcanos-core',
      action: 'dag.capabilities',
      source: 'gpt.arcanos-core',
      capabilities: expect.objectContaining({
        features: expect.objectContaining({ dagOrchestration: true }),
        graphs: [
          expect.objectContaining({
            graphId: 'default',
            template: 'trinity-core',
            actions: expect.arrayContaining(['dag.dispatch', 'dag.status', 'dag.trace']),
          }),
        ],
      }),
      traceId: expect.any(String),
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('dispatches a DAG run with server-derived target and source', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'dag.dispatch',
        target: 'mcp',
        source: 'evil',
        prompt: 'Validation run for GPT DAG bridge.',
        payload: {
          graphId: 'default',
          target: 'mcp',
          source: 'evil',
          headers: { authorization: 'Bearer abcdefghijklmnop' },
          input: {
            validation: true,
            target: 'tool',
            source: 'payload-source',
            nested: {
              auth: 'secret',
              kept: true,
            },
          },
          async: true,
          idempotencyKey: 'gpt-dag-bridge-validation-001',
        },
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      gptId: 'arcanos-core',
      action: 'dag.dispatch',
      source: 'gpt.arcanos-core',
      sourceType: 'gpt',
      graphId: 'default',
      runId: 'dagrun_bridge_1',
      status: 'queued',
      dispatch: expect.objectContaining({
        target: 'dag',
        source: 'gpt.arcanos-core',
        sourceType: 'gpt',
        options: expect.objectContaining({
          async: true,
          priority: 'normal',
          idempotencyKey: 'gpt-dag-bridge-validation-001',
        }),
      }),
    }));
    expect(response.body.dispatch.input).toEqual({
      validation: true,
      nested: { kept: true },
      prompt: 'Validation run for GPT DAG bridge.',
    });
    expect(JSON.stringify(response.body)).not.toContain('payload-source');
    expect(JSON.stringify(response.body)).not.toContain('Bearer abcdefghijklmnop');
    expect(mockCreateRun).toHaveBeenCalledWith(expect.objectContaining({
      template: 'trinity-core',
      input: {
        validation: true,
        nested: { kept: true },
        prompt: 'Validation run for GPT DAG bridge.',
      },
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('returns DAG run status by runId', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'dag.status',
        payload: { runId: 'dagrun_bridge_1' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      action: 'dag.status',
      runId: 'dagrun_bridge_1',
      status: 'running',
      source: 'gpt.arcanos-core',
    }));
    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('dagrun_bridge_1', {});
  });

  it('requires a valid runId for status and trace', async () => {
    const missingStatus = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'dag.status', payload: {} });
    const invalidTrace = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'dag.trace', payload: { runId: '../secret' } });

    expect(missingStatus.status).toBe(400);
    expect(missingStatus.body.error.code).toBe('DAG_RUN_ID_REQUIRED');
    expect(invalidTrace.status).toBe(400);
    expect(invalidTrace.body.error.code).toBe('DAG_RUN_ID_INVALID');
    expect(mockWaitForRunUpdate).not.toHaveBeenCalled();
    expect(mockGetRunTrace).not.toHaveBeenCalled();
  });

  it('returns redacted DAG trace data', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'dag.trace',
        payload: { runId: 'dagrun_bridge_1' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      action: 'dag.trace',
      runId: 'dagrun_bridge_1',
      data: expect.objectContaining({
        events: expect.objectContaining({
          events: [
            expect.objectContaining({
              data: expect.objectContaining({
                authorization: '[REDACTED]',
                api_key: '[REDACTED]',
                safe: 'kept',
              }),
            }),
          ],
        }),
      }),
    }));
    expect(JSON.stringify(response.body)).not.toContain(redactionBearerValue);
    expect(JSON.stringify(response.body)).not.toContain(redactionApiKey);
  });

  it('rejects unsupported DAG actions and unauthorized GPT IDs', async () => {
    const unsupported = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'dag.run.create', payload: { input: { goal: 'no' } } });
    const unauthorized = await request(buildApp())
      .post('/gpt/support-bot')
      .send({ action: 'dag.dispatch', prompt: 'Should not run.' });

    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe('GPT_DAG_ACTION_UNSUPPORTED');
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body.error.code).toBe('GPT_DAG_BRIDGE_GPT_NOT_ALLOWED');
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects Gaming DAG dispatch before module routing', async () => {
    const response = await request(buildApp())
      .post('/gpt/gaming')
      .send({ action: 'dag.dispatch', prompt: 'Should not run.' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_DAG_BRIDGE_GPT_NOT_ALLOWED');
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('maps typed unsupported DAG template errors to graph validation responses', async () => {
    mockCreateRun.mockRejectedValueOnce(new UnsupportedDagTemplateError('unexpected-template'));

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        action: 'dag.dispatch',
        prompt: 'Validation run for typed DAG template errors.',
        payload: { graphId: 'default', input: { validation: true } },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('DAG_GRAPH_UNSUPPORTED');
    expect(response.body._route).toEqual(expect.objectContaining({
      route: 'dag_dispatch_invalid_graph',
      action: 'dag.dispatch',
    }));
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('blocks runtime control actions through the GPT route', async () => {
    for (const action of ['runtime.inspect', 'workers.status', 'queue.inspect', 'self_heal.status']) {
      const response = await request(buildApp())
        .post('/gpt/arcanos-core')
        .send({ action });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT');
      expect(response.body.canonical).toEqual(expect.objectContaining({
        mcp: '/gpt-access/mcp',
      }));
    }

    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('enforces optional bridge bearer auth when configured', async () => {
    process.env.GPT_DAG_BRIDGE_REQUIRE_AUTH = 'true';
    process.env.GPT_DAG_BRIDGE_BEARER_TOKEN = bridgeBearerToken;

    const missing = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'dag.capabilities' });
    const invalid = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', ['Bearer', invalidBridgeBearerToken].join(' '))
      .send({ action: 'dag.capabilities' });
    const valid = await request(buildApp())
      .post('/gpt/arcanos-core')
      .set('Authorization', ['Bearer', bridgeBearerToken].join(' '))
      .send({ action: 'dag.capabilities' });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(valid.status).toBe(200);
    expect(JSON.stringify(missing.body)).not.toContain(bridgeBearerToken);
    expect(JSON.stringify(invalid.body)).not.toContain(invalidBridgeBearerToken);
  });

  it('returns a safe disabled response when the feature flag is false', async () => {
    process.env.GPT_DAG_BRIDGE_ENABLED = 'false';

    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'dag.capabilities' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('GPT_DAG_BRIDGE_DISABLED');
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });
});
