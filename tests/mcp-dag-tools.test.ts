import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetFeatureFlags = jest.fn();
const mockGetExecutionLimits = jest.fn();
const mockCreateRun = jest.fn();
const mockInspectLatestRun = jest.fn();
const mockInspectRunTrace = jest.fn();
const mockGetRun = jest.fn();
const mockWaitForRunUpdate = jest.fn();
const mockGetRunTree = jest.fn();
const mockGetNode = jest.fn();
const mockGetRunEvents = jest.fn();
const mockGetRunMetrics = jest.fn();
const mockGetRunErrors = jest.fn();
const mockGetRunLineage = jest.fn();
const mockGetRunVerification = jest.fn();
const mockCancelRun = jest.fn();

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    getFeatureFlags: mockGetFeatureFlags,
    getExecutionLimits: mockGetExecutionLimits,
    createRun: mockCreateRun,
    inspectLatestRun: mockInspectLatestRun,
    inspectRunTrace: mockInspectRunTrace,
    getRun: mockGetRun,
    waitForRunUpdate: mockWaitForRunUpdate,
    getRunTree: mockGetRunTree,
    getNode: mockGetNode,
    getRunEvents: mockGetRunEvents,
    getRunMetrics: mockGetRunMetrics,
    getRunErrors: mockGetRunErrors,
    getRunLineage: mockGetRunLineage,
    getRunVerification: mockGetRunVerification,
    cancelRun: mockCancelRun,
  },
}));

jest.unstable_mockModule('../src/mcp/server/helpers.js', () => ({
  wrapTool: (_toolName: string, _ctx: unknown, handler: (args: unknown) => Promise<unknown>) => handler,
  requireNonceOrIssue: () => ({ ok: true }),
  stripConfirmationFields: (args: unknown) => args,
}));

const { registerDagMcpTools } = await import('../src/mcp/server/dagTools.js');

type RegisteredTool = {
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
};

function buildFakeServer() {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    server: {
      registerTool(name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) {
        tools.set(name, { config, handler });
      },
    },
  };
}

function buildContext() {
  return {
    requestId: 'mcp-req-1',
    sessionId: 'mcp-session-1',
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

describe('registerDagMcpTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers the expected DAG MCP tools', () => {
    const { server, tools } = buildFakeServer();

    registerDagMcpTools(server as any, buildContext());

    expect(Array.from(tools.keys())).toEqual([
      'dag.capabilities',
      'dag.run.create',
      'dag.run.latest',
      'dag.run.get',
      'dag.run.wait',
      'dag.run.trace',
      'dag.run.tree',
      'dag.run.node',
      'dag.run.events',
      'dag.run.metrics',
      'dag.run.errors',
      'dag.run.lineage',
      'dag.run.verification',
      'dag.run.cancel',
    ]);
  });

  it('returns DAG capabilities from the orchestration service', async () => {
    const { server, tools } = buildFakeServer();
    mockGetFeatureFlags.mockReturnValue({
      dagOrchestration: true,
      parallelExecution: true,
    });
    mockGetExecutionLimits.mockReturnValue({
      maxConcurrency: 5,
      maxSpawnDepth: 3,
    });

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.capabilities')!.handler({});

    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: {
          features: expect.objectContaining({ dagOrchestration: true }),
          limits: expect.objectContaining({ maxConcurrency: 5 }),
        },
      })
    );
  });

  it('creates DAG runs from a natural-language goal and MCP context session', async () => {
    const { server, tools } = buildFakeServer();
    mockCreateRun.mockResolvedValue({
      pipeline: 'trinity',
      runId: 'dagrun_1',
      sessionId: 'mcp-session-1',
      template: 'trinity-core',
      status: 'queued',
    });

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.create')!.handler({
      goal: 'Research and audit the deployment pipeline',
      maxConcurrency: 4,
      debug: true,
    });

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'mcp-session-1',
        template: 'trinity-core',
        input: {
          goal: 'Research and audit the deployment pipeline',
        },
        options: {
          maxConcurrency: 4,
          allowRecursiveSpawning: undefined,
          debug: true,
        },
      })
    );
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: {
          run: expect.objectContaining({ runId: 'dagrun_1' }),
        },
      })
    );
  });

  it('returns a retryable MCP unavailable error when DAG capacity is exhausted', async () => {
    const { server, tools } = buildFakeServer();
    mockCreateRun.mockRejectedValueOnce(
      Object.assign(
        new Error('DAG run capacity is temporarily unavailable.'),
        {
          code: 'DAG_RUN_CAPACITY_EXCEEDED',
          retryAfterSeconds: 7,
        }
      )
    );

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.create')!.handler({
      goal: 'Wait for available DAG capacity',
    });

    expect(output).toEqual(
      expect.objectContaining({
        isError: true,
        structuredContent: {
          error: expect.objectContaining({
            code: 'ERR_UNAVAILABLE',
            message: 'DAG run capacity is temporarily unavailable.',
            details: {
              reasonCode: 'DAG_RUN_CAPACITY_EXCEEDED',
              retryAfterSeconds: 7,
            },
            requestId: 'mcp-req-1',
          }),
        },
      })
    );
  });

  it('rejects empty DAG run creation requests with an MCP bad-request error', async () => {
    const { server, tools } = buildFakeServer();

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.create')!.handler({});

    expect(output).toEqual(
      expect.objectContaining({
        isError: true,
        structuredContent: {
          error: expect.objectContaining({
            code: 'ERR_BAD_REQUEST',
          }),
        },
      })
    );
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('waits for DAG run updates through the orchestration service', async () => {
    const { server, tools } = buildFakeServer();
    mockWaitForRunUpdate.mockResolvedValue({
      run: {
        runId: 'dagrun_2',
        status: 'running',
      },
      updated: true,
      waited: true,
    });

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.wait')!.handler({
      runId: 'dagrun_2',
      updatedAfter: '2026-03-07T00:00:00.000Z',
      waitForUpdateMs: 5000,
    });

    expect(mockWaitForRunUpdate).toHaveBeenCalledWith('dagrun_2', {
      updatedAfter: '2026-03-07T00:00:00.000Z',
      waitForUpdateMs: 5000,
    });
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: {
          run: expect.objectContaining({ runId: 'dagrun_2' }),
          updated: true,
          waited: true,
        },
      })
    );
  });

  it('returns the latest DAG run summary through the inspection service', async () => {
    const { server, tools } = buildFakeServer();
    mockInspectLatestRun.mockResolvedValue({
      run: {
        runId: 'dagrun_latest_1',
        status: 'complete',
      },
      diagnostics: {
        snapshotSource: 'persisted',
        localLookupMs: 0,
        persistedLookupMs: 5,
        totalMs: 5,
      },
    });

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.latest')!.handler({});

    expect(mockInspectLatestRun).toHaveBeenCalledWith('mcp-session-1');
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          run: expect.objectContaining({ runId: 'dagrun_latest_1' }),
        }),
      })
    );
  });

  it('returns one bounded full trace for an explicit run id', async () => {
    const { server, tools } = buildFakeServer();
    mockInspectRunTrace.mockResolvedValue({
      trace: {
        run: { runId: 'dagrun_trace_1', status: 'running' },
        tree: { nodes: [{ nodeId: 'planner' }] },
        events: { events: [{ eventId: 'evt-1' }] },
        metrics: { metrics: {}, limits: {}, guardViolations: [] },
        errors: { errors: [] },
        lineage: { lineage: [{ nodeId: 'planner' }], loopDetected: false },
        verification: { verification: { runCompleted: false }, lineage: { workerPipeline: 'trinity' } },
        sections: {
          requested: ['run', 'tree', 'events', 'metrics', 'errors', 'lineage', 'verification'],
          events: { total: 1, returned: 1, truncated: false, maxEvents: 200 },
        },
      },
      diagnostics: {
        snapshotSource: 'persisted',
        localLookupMs: 0,
        persistedLookupMs: 3,
        buildMs: {
          run: 0,
          tree: 0,
          events: 1,
          metrics: 0,
          errors: 0,
          lineage: 0,
          verification: 0,
        },
        totalMs: 4,
        payload: {
          nodes: 1,
          totalEvents: 1,
          returnedEvents: 1,
          errors: 0,
          lineageEntries: 1,
        },
      },
    });

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.trace')!.handler({ runId: 'dagrun_trace_1' });

    expect(mockInspectRunTrace).toHaveBeenCalledWith('dagrun_trace_1', {
      maxEvents: undefined,
    });
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          run: expect.objectContaining({ runId: 'dagrun_trace_1' }),
          sections: expect.objectContaining({
            events: expect.objectContaining({ returned: 1 }),
          }),
        }),
      })
    );
  });

  it('returns MCP not-found errors for missing DAG runs', async () => {
    const { server, tools } = buildFakeServer();
    mockGetRun.mockResolvedValue(null);

    registerDagMcpTools(server as any, buildContext());
    const output = await tools.get('dag.run.get')!.handler({
      runId: 'missing-run',
    });

    expect(output).toEqual(
      expect.objectContaining({
        isError: true,
        structuredContent: {
          error: expect.objectContaining({
            code: 'ERR_NOT_FOUND',
            details: { runId: 'missing-run' },
          }),
        },
      })
    );
  });

  it('returns accepted and idempotent DAG cancellation results', async () => {
    const { server, tools } = buildFakeServer();
    mockCancelRun
      .mockResolvedValueOnce({
        outcome: 'cancellation_requested',
        statusCode: 202,
        data: {
          runId: 'dagrun_cancel_accepted',
          status: 'cancellation_requested',
          cancelledNodes: ['writer'],
        },
      })
      .mockResolvedValueOnce({
        outcome: 'already_cancelled',
        statusCode: 200,
        data: {
          runId: 'dagrun_cancelled',
          status: 'cancelled',
          cancelledNodes: ['writer'],
        },
      });

    registerDagMcpTools(server as any, buildContext());
    const accepted = await tools.get('dag.run.cancel')!.handler({
      runId: 'dagrun_cancel_accepted',
    });
    const idempotent = await tools.get('dag.run.cancel')!.handler({
      runId: 'dagrun_cancelled',
    });

    expect(accepted).toEqual(
      expect.objectContaining({
        structuredContent: {
          runId: 'dagrun_cancel_accepted',
          status: 'cancellation_requested',
          cancelledNodes: ['writer'],
        },
      })
    );
    expect(idempotent).toEqual(
      expect.objectContaining({
        structuredContent: {
          runId: 'dagrun_cancelled',
          status: 'cancelled',
          cancelledNodes: ['writer'],
        },
      })
    );
    expect(mockCancelRun).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'not found',
      runId: 'dagrun_missing',
      result: {
        outcome: 'not_found',
        statusCode: 404,
      },
      code: 'ERR_NOT_FOUND',
      details: {
        runId: 'dagrun_missing',
      },
    },
    {
      name: 'terminal conflict',
      runId: 'dagrun_complete',
      result: {
        outcome: 'not_cancellable',
        statusCode: 409,
        runStatus: 'complete',
      },
      code: 'ERR_CONFLICT',
      details: {
        runId: 'dagrun_complete',
        reasonCode: 'RUN_NOT_CANCELLABLE',
        status: 'complete',
      },
    },
    {
      name: 'owned elsewhere',
      runId: 'dagrun_owned_elsewhere',
      result: {
        outcome: 'owned_elsewhere',
        statusCode: 503,
        retryAfterSeconds: 11,
      },
      code: 'ERR_UNAVAILABLE',
      details: {
        runId: 'dagrun_owned_elsewhere',
        reasonCode: 'DAG_RUN_OWNED_ELSEWHERE',
        retryAfterSeconds: 11,
      },
    },
    {
      name: 'state unavailable',
      runId: 'dagrun_unavailable',
      result: {
        outcome: 'unavailable',
        statusCode: 503,
        retryAfterSeconds: 13,
      },
      code: 'ERR_UNAVAILABLE',
      details: {
        runId: 'dagrun_unavailable',
        reasonCode: 'DAG_RUN_CANCELLATION_UNAVAILABLE',
        retryAfterSeconds: 13,
      },
    },
  ])(
    'returns an explicit MCP error when DAG cancellation is $name',
    async ({ runId, result, code, details }) => {
      const { server, tools } = buildFakeServer();
      mockCancelRun.mockResolvedValueOnce(result);

      registerDagMcpTools(server as any, buildContext());
      const output = await tools.get('dag.run.cancel')!.handler({ runId });

      expect(output).toEqual(
        expect.objectContaining({
          isError: true,
          structuredContent: {
            error: expect.objectContaining({
              code,
              details,
              requestId: 'mcp-req-1',
            }),
          },
        })
      );
    }
  );
});
