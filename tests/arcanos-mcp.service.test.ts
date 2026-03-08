import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockBuildMcpRequestContext = jest.fn();
const mockBuildMcpInternalContext = jest.fn();
const mockCreateMcpServer = jest.fn();
const mockClientConnect = jest.fn();
const mockClientCallTool = jest.fn();
const mockClientListTools = jest.fn();
const mockClientClose = jest.fn();
const mockServerConnect = jest.fn();
const mockServerClose = jest.fn();
const mockClientTransportClose = jest.fn();
const mockServerTransportClose = jest.fn();
const mockCreateLinkedPair = jest.fn();

class FakeClient {
  constructor(_implementation: { name: string; version: string }, _options?: { capabilities?: Record<string, unknown> }) {}

  connect(transport: unknown) {
    return mockClientConnect(transport);
  }

  callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    return mockClientCallTool(params);
  }

  listTools(params?: Record<string, unknown>) {
    return mockClientListTools(params);
  }

  close() {
    return mockClientClose();
  }
}

jest.unstable_mockModule('../src/mcp/context.js', () => ({
  buildMcpRequestContext: mockBuildMcpRequestContext,
  buildMcpInternalContext: mockBuildMcpInternalContext,
}));

jest.unstable_mockModule('../src/mcp/server.js', () => ({
  createMcpServer: mockCreateMcpServer,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: mockCreateLinkedPair,
  },
}));

const {
  arcanosMcpService,
  invokeArcanosMcpTool,
  listArcanosMcpTools,
} = await import('../src/services/arcanosMcp.js');

function buildMockContext() {
  return {
    requestId: 'mcp-req-1',
    sessionId: 'session-1',
    runtimeBudget: {},
    req: {},
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

describe('arcanosMcpService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockBuildMcpRequestContext.mockReturnValue(buildMockContext());
    mockBuildMcpInternalContext.mockReturnValue(buildMockContext());
    mockCreateMcpServer.mockResolvedValue({
      connect: mockServerConnect,
      close: mockServerClose,
    });
    mockClientConnect.mockResolvedValue(undefined);
    mockClientCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    });
    mockClientListTools.mockResolvedValue({
      tools: [{ name: 'modules.list' }],
    });
    mockClientClose.mockResolvedValue(undefined);
    mockServerConnect.mockResolvedValue(undefined);
    mockServerClose.mockResolvedValue(undefined);
    mockClientTransportClose.mockResolvedValue(undefined);
    mockServerTransportClose.mockResolvedValue(undefined);
    mockCreateLinkedPair.mockReturnValue([
      { close: mockClientTransportClose },
      { close: mockServerTransportClose },
    ]);
  });

  it('invokes an ARCANOS MCP tool with detached backend context', async () => {
    const result = await invokeArcanosMcpTool({
      toolName: 'modules.list',
      toolArguments: { scope: 'all' },
      sessionId: 'worker:planner',
    });

    expect(mockBuildMcpInternalContext).toHaveBeenCalledWith('worker:planner');
    expect(mockBuildMcpRequestContext).not.toHaveBeenCalled();
    expect(mockClientCallTool).toHaveBeenCalledWith({
      name: 'modules.list',
      arguments: { scope: 'all' },
    });
    expect(mockClientClose).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockClientTransportClose).toHaveBeenCalledTimes(1);
    expect(mockServerTransportClose).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: { ok: true },
      })
    );
  });

  it('uses request-scoped context when listing tools from the app runtime', async () => {
    const request = { header: jest.fn() } as any;

    const result = await arcanosMcpService.listTools({ request });

    expect(mockBuildMcpRequestContext).toHaveBeenCalledWith(request);
    expect(mockBuildMcpInternalContext).not.toHaveBeenCalled();
    expect(mockClientListTools).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({
      tools: [{ name: 'modules.list' }],
    });
  });

  it('fails fast on blank tool names before opening an MCP connection', async () => {
    await expect(
      invokeArcanosMcpTool({
        toolName: '   ',
      })
    ).rejects.toThrow('ARCANOS MCP tool name is required');

    expect(mockBuildMcpInternalContext).not.toHaveBeenCalled();
    expect(mockCreateMcpServer).not.toHaveBeenCalled();
  });

  it('cleans up transports when an MCP tool call fails', async () => {
    mockClientCallTool.mockRejectedValue(new Error('tool exploded'));

    await expect(
      invokeArcanosMcpTool({
        toolName: 'dag.run.get',
        toolArguments: { runId: 'dagrun_1' },
        sessionId: 'worker:planner',
      })
    ).rejects.toThrow('ARCANOS MCP tool "dag.run.get" failed: tool exploded');

    expect(mockClientClose).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockClientTransportClose).toHaveBeenCalledTimes(1);
    expect(mockServerTransportClose).toHaveBeenCalledTimes(1);
  });
});
