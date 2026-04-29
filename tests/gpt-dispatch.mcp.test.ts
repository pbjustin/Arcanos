import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockRebuildGptModuleMap = jest.fn();
const mockValidateGptRegistry = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockPersistModuleConversation = jest.fn();
const mockExecuteNaturalLanguageMemoryCommand = jest.fn();
const mockParseNaturalLanguageMemoryCommand = jest.fn();
const mockExtractNaturalLanguageSessionId = jest.fn();
const mockExtractNaturalLanguageStorageLabel = jest.fn();
const mockHasDagOrchestrationIntentCue = jest.fn();
const mockHasNaturalLanguageMemoryCue = jest.fn();
const mockBuildRepoInspectionAnswer = jest.fn();
const mockCollectRepoImplementationEvidence = jest.fn();
const mockShouldInspectRepoPrompt = jest.fn();
const mockTryExecuteDeterministicDagTools = jest.fn();
const mockMcpInvokeTool = jest.fn();
const mockMcpListTools = jest.fn();

jest.unstable_mockModule('../src/platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
  getGptModuleMap: mockGetGptModuleMap,
  rebuildGptModuleMap: mockRebuildGptModuleMap,
  validateGptRegistry: mockValidateGptRegistry,
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
  extractNaturalLanguageStorageLabel: mockExtractNaturalLanguageStorageLabel,
  hasDagOrchestrationIntentCue: mockHasDagOrchestrationIntentCue,
  hasNaturalLanguageMemoryCue: mockHasNaturalLanguageMemoryCue,
}));

jest.unstable_mockModule('../src/services/arcanosMcp.js', () => ({
  arcanosMcpService: {
    invokeTool: mockMcpInvokeTool,
    listTools: mockMcpListTools,
  },
}));

jest.unstable_mockModule('../src/services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: mockBuildRepoInspectionAnswer,
  collectRepoImplementationEvidence: mockCollectRepoImplementationEvidence,
  shouldInspectRepoPrompt: mockShouldInspectRepoPrompt,
}));

jest.unstable_mockModule('../src/routes/ask/dagTools.js', () => ({
  tryExecuteDeterministicDagTools: mockTryExecuteDeterministicDagTools,
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');

describe('routeGptRequest write-plane classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: ['arcanos-core'],
      missingGptIds: [],
      registeredGptIds: ['arcanos-core'],
      registeredGptCount: 1,
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:CORE',
      actions: ['query', 'system_state'],
      route: 'core',
      defaultAction: 'query',
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockShouldInspectRepoPrompt.mockReturnValue(false);
    mockBuildRepoInspectionAnswer.mockImplementation((prompt: string) => `repo-answer:${prompt}`);
    mockCollectRepoImplementationEvidence.mockResolvedValue({
      status: 'implemented',
      checks: [{ name: 'repo_tools', status: 'pass' }],
      evidence: {
        rootPath: '/workspace',
        filesFound: ['packages/cli/src'],
      },
    });
    mockTryExecuteDeterministicDagTools.mockResolvedValue(null);
    mockMcpInvokeTool.mockResolvedValue({ structuredContent: { ok: true } });
    mockMcpListTools.mockResolvedValue({ tools: [] });
    mockDispatchModuleAction.mockResolvedValue({
      response: 'write-plane ok',
    });
  });

  it('defers explicit MCP dispatch requests to the core Trinity boundary', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'mcp.invoke',
        prompt: 'Invoke the modules.list MCP tool.',
        payload: {
          toolName: 'modules.list',
        },
      },
      requestId: 'req-mcp-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        toolName: 'modules.list',
        prompt: 'Invoke the modules.list MCP tool.',
        __arcanosRequestedAction: 'mcp.invoke',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          route: 'core',
          action: 'query',
        }),
      })
    );
    expect(mockMcpInvokeTool).not.toHaveBeenCalled();
  });

  it('defers embedded payload.mcp envelopes to the core Trinity boundary', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        payload: {
          prompt: 'List the available MCP tools.',
          mcp: {
            action: 'mcp.listTools',
          },
        },
      },
      requestId: 'req-mcp-2',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'List the available MCP tools.',
        mcp: expect.objectContaining({
          action: 'mcp.listTools',
        }),
        __arcanosRequestedAction: 'mcp.list_tools',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          route: 'core',
          action: 'query',
        }),
      })
    );
    expect(mockMcpListTools).not.toHaveBeenCalled();
  });

  it('defers runtime inspection prompts to the core Trinity boundary', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'verify in production on the live backend runtime that is currently active',
      },
      requestId: 'req-runtime-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        message: 'verify in production on the live backend runtime that is currently active',
        prompt: 'verify in production on the live backend runtime that is currently active',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          route: 'core',
          action: 'query',
        }),
      })
    );
  });

  it('keeps workflow-like query prompts on the requested GPT write plane', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        message: 'Generate a phased workflow: inventory, classify, refactor, verify, report.',
      },
      requestId: 'req-dag-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        message: 'Generate a phased workflow: inventory, classify, refactor, verify, report.',
        prompt: 'Generate a phased workflow: inventory, classify, refactor, verify, report.',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'query',
          route: 'core',
        }),
      })
    );
    expect(mockTryExecuteDeterministicDagTools).not.toHaveBeenCalled();
  });

  it('defers leaked direct control actions to the core Trinity boundary', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'system_state',
        prompt: 'Inspect the current system state.',
      },
      requestId: 'req-control-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        action: 'system_state',
        prompt: 'Inspect the current system state.',
        __arcanosRequestedAction: 'system_state',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          route: 'core',
          action: 'query',
        }),
      })
    );
  });

  it('keeps normal writing prompts on module dispatch', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'Explain how the backend worker and queue fit together.',
        sessionId: 'sess-write-1',
      },
      requestId: 'req-write-1',
      logger,
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        message: 'Explain how the backend worker and queue fit together.',
        prompt: 'Explain how the backend worker and queue fit together.',
        sessionId: 'sess-write-1',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          action: 'query',
          module: 'ARCANOS:CORE',
          route: 'core',
        }),
      })
    );
    expect(mockTryExecuteDeterministicDagTools).not.toHaveBeenCalled();
    expect(mockMcpInvokeTool).not.toHaveBeenCalled();
    expect(mockMcpListTools).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      'gpt.dispatch.mcp.auto_selected',
      expect.anything()
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      'gpt.dispatch.dag_execution.ok',
      expect.anything()
    );
  });

  it('still allows repo inspection for implementation-status writing prompts', async () => {
    mockShouldInspectRepoPrompt.mockReturnValue(true);

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'Is my CLI implemented?',
      },
      requestId: 'req-repo-1',
    });

    expect(mockCollectRepoImplementationEvidence).toHaveBeenCalledTimes(1);
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'repo-inspection',
          repoInspection: expect.objectContaining({
            reason: 'prompt_requests_repo_inspection',
            answer: 'repo-answer:Is my CLI implemented?',
          }),
        }),
        _route: expect.objectContaining({
          action: 'repo.inspect',
        }),
      })
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
