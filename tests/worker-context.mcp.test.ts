import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockDbQuery = jest.fn();
const mockLogExecution = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockRunWorkerTrinityPrompt = jest.fn();
const mockInvokeArcanosMcpTool = jest.fn();
const mockListArcanosMcpTools = jest.fn();

jest.unstable_mockModule('../src/core/db/index.js', () => ({
  query: mockDbQuery,
  logExecution: mockLogExecution,
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('../src/workers/trinityWorkerPipeline.js', () => ({
  runWorkerTrinityPrompt: mockRunWorkerTrinityPrompt,
}));

jest.unstable_mockModule('../src/services/arcanosMcp.js', () => ({
  invokeArcanosMcpTool: mockInvokeArcanosMcpTool,
  listArcanosMcpTools: mockListArcanosMcpTools,
}));

const { createWorkerContext } = await import('../src/platform/runtime/workerContext.js');

describe('createWorkerContext MCP facade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: null });
    mockInvokeArcanosMcpTool.mockResolvedValue({ structuredContent: { ok: true } });
    mockListArcanosMcpTools.mockResolvedValue({ tools: [{ name: 'modules.list' }] });
  });

  it('routes worker MCP tool calls through the internal ARCANOS MCP service', async () => {
    const context = createWorkerContext('planner-1');

    const result = await context.mcp.invokeTool('modules.list', { scope: 'all' });

    expect(mockInvokeArcanosMcpTool).toHaveBeenCalledWith({
      toolName: 'modules.list',
      toolArguments: { scope: 'all' },
      sessionId: 'worker:planner-1',
    });
    expect(result).toEqual({ structuredContent: { ok: true } });
  });

  it('lists ARCANOS MCP tools with the worker-scoped session id', async () => {
    const context = createWorkerContext('planner-1');

    const result = await context.mcp.listTools();

    expect(mockListArcanosMcpTools).toHaveBeenCalledWith({
      sessionId: 'worker:planner-1',
    });
    expect(result).toEqual({ tools: [{ name: 'modules.list' }] });
  });
});
