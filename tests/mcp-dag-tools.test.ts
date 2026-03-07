import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetFeatureFlags = jest.fn();
const mockGetExecutionLimits = jest.fn();
const mockCreateRun = jest.fn();
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
      'dag.run.get',
      'dag.run.wait',
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
});
