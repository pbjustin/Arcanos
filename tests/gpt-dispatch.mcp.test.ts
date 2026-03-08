import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockPersistModuleConversation = jest.fn();
const mockExecuteNaturalLanguageMemoryCommand = jest.fn();
const mockParseNaturalLanguageMemoryCommand = jest.fn();
const mockExtractNaturalLanguageSessionId = jest.fn();

jest.unstable_mockModule('../src/platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
}));

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  dispatchModuleAction: mockDispatchModuleAction,
  getModuleMetadata: mockGetModuleMetadata,
}));

jest.unstable_mockModule('../src/services/moduleConversationPersistence.js', () => ({
  persistModuleConversation: mockPersistModuleConversation,
}));

jest.unstable_mockModule('../src/services/naturalLanguageMemory.js', () => ({
  executeNaturalLanguageMemoryCommand: mockExecuteNaturalLanguageMemoryCommand,
  parseNaturalLanguageMemoryCommand: mockParseNaturalLanguageMemoryCommand,
  extractNaturalLanguageSessionId: mockExtractNaturalLanguageSessionId,
}));

jest.unstable_mockModule('../src/services/arcanosMcp.js', () => ({
  arcanosMcpService: {
    invokeTool: jest.fn(),
    listTools: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/shared/typeGuards.js', () => ({
  isRecord(value: unknown) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');

describe('routeGptRequest MCP dispatch branch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:TUTOR',
      actions: ['query'],
      route: 'tutor',
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
  });

  it('uses the request-scoped ARCANOS MCP service for explicit mcp.invoke actions', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: { ok: true },
    });
    const listTools = jest.fn();
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool,
            listTools,
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'tutor',
      body: {
        action: 'mcp.invoke',
        payload: {
          toolName: 'modules.list',
          toolArguments: { scope: 'all' },
        },
        sessionId: 'sess-1',
      },
      requestId: 'req-1',
      request,
    });

    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'modules.list',
      toolArguments: { scope: 'all' },
      request,
      sessionId: 'sess-1',
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(mockPersistModuleConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.invoke',
        gptId: 'tutor',
        moduleName: 'ARCANOS:TUTOR',
        sessionId: 'sess-1',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'mcp-dispatcher',
          mcp: expect.objectContaining({
            action: 'invoke',
            toolName: 'modules.list',
          }),
        }),
      })
    );
  });

  it('allows payload.mcp to trigger list tools dispatch when no action was requested', async () => {
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn().mockResolvedValue({
              tools: [{ name: 'modules.list' }],
            }),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'tutor',
      body: {
        payload: {
          mcp: {
            action: 'mcp.listTools',
          },
        },
      },
      requestId: 'req-2',
      request,
    });

    expect(request.app.locals.arcanosMcp.listTools).toHaveBeenCalledWith({
      request,
      sessionId: undefined,
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'mcp-dispatcher',
          mcp: expect.objectContaining({
            action: 'list_tools',
          }),
        }),
      })
    );
  });

  it('surfaces MCP tool errors as dispatcher failures', async () => {
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn().mockResolvedValue({
              isError: true,
              structuredContent: {
                error: {
                  code: 'ERR_BAD_REQUEST',
                  message: 'Unknown MCP tool',
                  details: { tool: 'missing.tool' },
                },
              },
            }),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'tutor',
      body: {
        action: 'mcp.invoke',
        payload: {
          toolName: 'missing.tool',
        },
      },
      requestId: 'req-3',
      request,
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'ERR_BAD_REQUEST',
          message: 'Unknown MCP tool',
          details: { tool: 'missing.tool' },
        },
      })
    );
  });

  it('automatically routes tutor prompts asking for MCP tools into listTools', async () => {
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn().mockResolvedValue({
              tools: [{ name: 'modules.list' }],
            }),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'tutor',
      body: {
        message: 'Show me the MCP tools available right now.',
      },
      requestId: 'req-4',
      request,
    });

    expect(request.app.locals.arcanosMcp.listTools).toHaveBeenCalledWith({
      request,
      sessionId: undefined,
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'mcp-dispatcher',
          mcp: expect.objectContaining({
            action: 'list_tools',
            dispatchMode: 'automatic',
            reason: 'prompt_requests_mcp_tools',
          }),
        }),
        _route: expect.objectContaining({
          action: 'mcp.auto.list_tools',
        }),
      })
    );
  });

  it('automatically routes tutor health prompts into ops.health_report', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: { ok: true, status: 'healthy' },
    });
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool,
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'tutor',
      body: {
        message: 'Give me a backend health report.',
      },
      requestId: 'req-5',
      request,
    });

    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'ops.health_report',
      toolArguments: {},
      request,
      sessionId: undefined,
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'mcp-dispatcher',
          mcp: expect.objectContaining({
            action: 'invoke',
            toolName: 'ops.health_report',
            dispatchMode: 'automatic',
            reason: 'prompt_requests_ops_health',
          }),
        }),
      })
    );
  });

  it('automatically routes broad backend operations prompts into trinity.ask', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: { ok: true, result: 'dispatched through trinity' },
    });
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool,
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const prompt = 'Inspect the backend worker, postgres, and redis state and report what is wrong.';
    const envelope = await routeGptRequest({
      gptId: 'tutor',
      body: {
        message: prompt,
        sessionId: 'sess-auto-1',
      },
      requestId: 'req-6',
      request,
    });

    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'trinity.ask',
      toolArguments: {
        prompt,
        sessionId: 'sess-auto-1',
      },
      request,
      sessionId: 'sess-auto-1',
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'mcp-dispatcher',
          mcp: expect.objectContaining({
            action: 'invoke',
            toolName: 'trinity.ask',
            dispatchMode: 'automatic',
            reason: 'prompt_requests_backend_operations',
          }),
        }),
        _route: expect.objectContaining({
          action: 'mcp.auto.invoke',
        }),
      })
    );
  });
});
