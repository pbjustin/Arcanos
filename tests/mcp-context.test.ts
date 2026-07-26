import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetOpenAIClientOrAdapter = jest.fn();
const mockCreateRuntimeBudget = jest.fn();
const mockGenerateRequestId = jest.fn();
const mockCreateMcpLogger = jest.fn();

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('../src/platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: mockCreateRuntimeBudget,
}));

jest.unstable_mockModule('../src/lib/requestId.js', () => ({
  generateRequestId: mockGenerateRequestId,
}));

jest.unstable_mockModule('../src/mcp/log.js', () => ({
  createMcpLogger: mockCreateMcpLogger,
}));

const { buildMcpInternalContext, buildMcpStdioContext } = await import('../src/mcp/context.js');
const { resolveArcanosMcpPortFromRequest } =
  await import('../src/services/arcanosMcpPort.js');

describe('MCP detached context builders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: { responses: {} } });
    mockCreateRuntimeBudget.mockReturnValue({ budgetId: 'budget-1' });
    mockGenerateRequestId.mockReturnValue('mcp_1');
    mockCreateMcpLogger.mockImplementation((meta: Record<string, unknown>) => ({
      meta,
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
  });

  it('tags in-process MCP contexts with the internal transport label', () => {
    const context = buildMcpInternalContext('worker:planner');

    expect(mockCreateMcpLogger).toHaveBeenCalledWith({
      requestId: 'mcp_1',
      traceId: 'mcp_1',
      sessionId: 'worker:planner',
      transport: 'internal',
    });
    expect(context.logger).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          transport: 'internal',
        }),
      })
    );
  });

  it('keeps stdio MCP contexts labeled as stdio', () => {
    buildMcpStdioContext('stdio-session');

    expect(mockCreateMcpLogger).toHaveBeenCalledWith({
      requestId: 'mcp_1',
      traceId: 'mcp_1',
      sessionId: 'stdio-session',
      transport: 'stdio',
    });
  });

  it('carries an explicitly composed MCP port through detached request locals', () => {
    const arcanosMcp = {
      invokeTool: jest.fn(),
      listTools: jest.fn(),
    };

    const internal = buildMcpInternalContext('worker:planner', { arcanosMcp });
    const stdio = buildMcpStdioContext('stdio-session', { arcanosMcp });

    expect(resolveArcanosMcpPortFromRequest(internal.req)).toBe(arcanosMcp);
    expect(resolveArcanosMcpPortFromRequest(stdio.req)).toBe(arcanosMcp);
  });

  it('rejects absent or malformed request-local MCP ports', () => {
    expect(resolveArcanosMcpPortFromRequest(undefined)).toBeUndefined();
    expect(resolveArcanosMcpPortFromRequest({ app: { locals: {} } })).toBeUndefined();
    expect(resolveArcanosMcpPortFromRequest({
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
          },
        },
      },
    })).toBeUndefined();
  });
});
