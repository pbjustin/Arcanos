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
      sessionId: 'stdio-session',
      transport: 'stdio',
    });
  });
});
