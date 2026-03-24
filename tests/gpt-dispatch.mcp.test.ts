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
const mockBuildRepoInspectionPrompt = jest.fn();
const mockBuildRepoInspectionAnswer = jest.fn();
const mockCollectRepoImplementationEvidence = jest.fn();
const mockShouldInspectRepoPrompt = jest.fn();

jest.unstable_mockModule('../src/platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
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
    invokeTool: jest.fn(),
    listTools: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: mockBuildRepoInspectionAnswer,
  buildRepoInspectionPrompt: mockBuildRepoInspectionPrompt,
  collectRepoImplementationEvidence: mockCollectRepoImplementationEvidence,
  shouldInspectRepoPrompt: mockShouldInspectRepoPrompt,
}));

jest.unstable_mockModule('../src/shared/typeGuards.js', () => ({
  isRecord(value: unknown) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');
const { getMetricsText, resetAppMetricsForTests } = await import('../src/platform/observability/appMetrics.js');

describe('routeGptRequest MCP dispatch branch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.METRICS_INCLUDE_WORKER_STATE = 'false';
    resetAppMetricsForTests();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: ['arcanos-core', 'core'],
      missingGptIds: [],
      registeredGptIds: ['arcanos-core'],
      registeredGptCount: 1,
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:CORE',
      actions: ['query'],
      route: 'core',
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockShouldInspectRepoPrompt.mockReturnValue(false);
    mockCollectRepoImplementationEvidence.mockResolvedValue({
      status: 'implemented',
      checks: [{ name: 'repo_tools', status: 'pass' }],
      evidence: {
        rootPath: '/workspace',
        filesFound: ['packages/cli/src'],
        commandsDetected: ['tool.invoke'],
        repoToolsDetected: ['repo.listTree'],
      },
    });
    mockBuildRepoInspectionPrompt.mockImplementation((prompt: string) => `repo-evidence:${prompt}`);
    mockBuildRepoInspectionAnswer.mockImplementation((prompt: string) => `repo-answer:${prompt}`);
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
      gptId: 'arcanos-core',
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
        gptId: 'arcanos-core',
        moduleName: 'ARCANOS:CORE',
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
      gptId: 'arcanos-core',
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
      gptId: 'arcanos-core',
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

  it('automatically routes core prompts asking for MCP tools into listTools', async () => {
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
      gptId: 'arcanos-core',
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

  it('automatically routes core health prompts into ops.health_report', async () => {
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
      gptId: 'arcanos-core',
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

  it('automatically routes latest DAG trace prompts into dag.run.latest instead of trinity.query', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: {
        __debug: 'NEW_DAG_LOGIC_ACTIVE',
        found: true,
        runId: 'dagrun_latest_1',
        status: 'complete',
        nodeCount: 4,
        durationMs: 123,
        timings: { lookupMs: 5, totalMs: 9 },
        topLevelMetrics: { eventCount: 8, completedNodes: 4, failedNodes: 0, verificationStatus: 'passed' },
        available: { nodes: true, events: true, metrics: true, verification: true, fullTrace: true },
      },
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

    const prompt = 'Trace the most recent DAG run with full lineage, nodes, events, metrics, and verification summary.';
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
        sessionId: 'sess-dag-1',
      },
      requestId: 'req-dag-1',
      request,
    });

    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'dag.run.latest',
      toolArguments: {
        sessionId: 'sess-dag-1',
      },
      request,
      sessionId: 'sess-dag-1',
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'mcp-dispatcher',
          mcp: expect.objectContaining({
            action: 'invoke',
            toolName: 'dag.run.latest',
            dispatchMode: 'automatic',
            reason: 'prompt_requests_latest_dag_run',
            output: expect.objectContaining({
              __debug: 'NEW_DAG_LOGIC_ACTIVE',
              found: true,
              runId: 'dagrun_latest_1',
            }),
          }),
        }),
      })
    );
    expect((envelope as any).result.mcp.output.summary).toBeUndefined();

    const metricsText = await getMetricsText();
    expect(metricsText).toMatch(/mcp_auto_invoke_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*tool_name="dag\.run\.latest"[^}]*reason="prompt_requests_latest_dag_run"[^}]*\} 1/);
    expect(metricsText).toMatch(/dispatcher_route_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*route="core"[^}]*handler="mcp-dispatcher"[^}]*outcome="ok"[^}]*\} 1/);
  });

  it('bypasses the memory dispatcher for DAG intent prompts even when memory cues are present', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: {
        __debug: 'NEW_DAG_LOGIC_ACTIVE',
        found: true,
        runId: 'dagrun_latest_2',
        status: 'complete',
      },
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

    mockHasDagOrchestrationIntentCue.mockReturnValue(true);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(true);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'retrieve', latest: true });

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'Show the DAG lineage, nodes, metrics, and verification for the latest run.',
      },
      requestId: 'req-dag-2',
      request,
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    expect(mockExecuteNaturalLanguageMemoryCommand).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'dag.run.latest',
      toolArguments: {},
      request,
      sessionId: undefined,
    });
    expect(envelope.ok).toBe(true);
  });

  it('retries DAG routing when the memory dispatcher ignores a misclassified DAG prompt', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: {
        __debug: 'NEW_DAG_LOGIC_ACTIVE',
        found: true,
        runId: 'dagrun_latest_3',
        status: 'complete',
      },
    });
    const logger = { info: jest.fn(), warn: jest.fn() };
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

    mockHasDagOrchestrationIntentCue
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(true);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(true);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'retrieve', latest: true });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      success: false,
      intent: 'unknown',
      operation: 'ignored',
      sessionId: 'sess-dag-fallback',
      message: 'Command not recognized.'
    });

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'Get the DAG lineage, nodes, metrics, and verification summary.',
      },
      requestId: 'req-dag-fallback',
      request,
      logger,
    });

    expect(mockExecuteNaturalLanguageMemoryCommand).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'dag.run.latest',
      toolArguments: {},
      request,
      sessionId: undefined,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'gpt.dispatch.intent_fallback',
      expect.objectContaining({
        fallbackReason: 'memory_ignored_retry_dag',
      })
    );
    expect(envelope.ok).toBe(true);

    const metricsText = await getMetricsText();
    expect(metricsText).toMatch(/memory_dispatch_ignored_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*reason="memory_ignored_retry_dag"[^}]*\} 1/);
    expect(metricsText).toMatch(/dispatcher_misroutes_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*reason="memory_ignored_retry_dag"[^}]*\} 1/);
    expect(metricsText).toMatch(/dispatcher_fallback_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*reason="memory_ignored_retry_dag"[^}]*\} 1/);
  });

  it('accepts explicit module:dag commands for latest-run tracing', async () => {
    const invokeTool = jest.fn().mockResolvedValue({
      structuredContent: {
        __debug: 'NEW_DAG_LOGIC_ACTIVE',
        found: true,
        runId: 'dagrun_latest_4',
        status: 'complete',
      },
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
      gptId: 'arcanos-core',
      body: {
        message: 'module:dag trace latest run',
        sessionId: 'sess-dag-command',
      },
      requestId: 'req-dag-command',
      request,
    });

    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'dag.run.latest',
      toolArguments: {
        sessionId: 'sess-dag-command',
      },
      request,
      sessionId: 'sess-dag-command',
    });
    expect(envelope.ok).toBe(true);
  });

  it('dispatches broad backend operations prompts through the direct core query path', async () => {
    const request = {
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    mockDispatchModuleAction.mockResolvedValueOnce({ ok: true, result: 'dispatched through direct query' });

    const prompt = 'Inspect the backend worker, postgres, and redis state and report what is wrong.';
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
        sessionId: 'sess-auto-1',
      },
      requestId: 'req-6',
      request,
    });

    expect(request.app.locals.arcanosMcp.invokeTool).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:CORE', 'query', {
      message: prompt,
      sessionId: 'sess-auto-1',
      prompt,
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: { ok: true, result: 'dispatched through direct query' },
        _route: expect.objectContaining({
          action: 'query',
          route: 'core',
        }),
      })
    );
  });

  it('automatically returns repository evidence for implementation-status prompts', async () => {
    const invokeTool = jest.fn();
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

    mockShouldInspectRepoPrompt.mockReturnValue(true);

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'Is my CLI implemented?',
        sessionId: 'sess-repo-1',
      },
      requestId: 'req-repo-1',
      request,
    });

    expect(mockCollectRepoImplementationEvidence).toHaveBeenCalledTimes(1);
    expect(mockBuildRepoInspectionAnswer).toHaveBeenCalledWith(
      'Is my CLI implemented?',
      expect.objectContaining({
        status: 'implemented',
      })
    );
    expect(invokeTool).not.toHaveBeenCalled();
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
  });

  it('maps explicit MCP budget aborts to MODULE_TIMEOUT', async () => {
    const invokeTool = jest.fn().mockRejectedValue(
      Object.assign(new Error('openai_call_aborted_due_to_budget'), {
        name: 'OpenAIAbortError',
      })
    );
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
      gptId: 'arcanos-core',
      body: {
        action: 'mcp.invoke',
        payload: {
          toolName: 'trinity.query',
          toolArguments: {
            prompt: 'Inspect the backend state.',
          },
        },
      },
      requestId: 'req-mcp-timeout-1',
      request,
    });

    expect(invokeTool).toHaveBeenCalledWith({
      toolName: 'trinity.query',
      toolArguments: {
        prompt: 'Inspect the backend state.',
      },
      request,
      sessionId: undefined,
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'MODULE_TIMEOUT',
          message: 'MCP dispatch timed out before completion.',
        }),
        _route: expect.objectContaining({
          gptId: 'arcanos-core',
          action: 'mcp.invoke',
          route: 'core',
        }),
      })
    );
  });
});
