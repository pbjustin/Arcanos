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
const mockBuildSelfHealRuntimeSnapshot = jest.fn();
const mockBuildSelfHealEventsSnapshot = jest.fn();
const mockBuildSafetySelfHealSnapshot = jest.fn();
const mockBuildSelfHealInspectionSnapshot = jest.fn();
const mockGetWorkerControlHealth = jest.fn();
const mockGetWorkerRuntimeStatus = jest.fn();
const mockGetConfig = jest.fn();
const mockIsArcanosCliAvailable = jest.fn();
const mockRunArcanosCLI = jest.fn();
const mockGetDiagnosticsSnapshot = jest.fn();
const mockGetHealthSnapshot = jest.fn();
const mockTryExecuteDeterministicDagTools = jest.fn();

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

jest.unstable_mockModule('../src/services/selfHealRuntimeInspectionService.js', () => ({
  buildSelfHealRuntimeSnapshot: mockBuildSelfHealRuntimeSnapshot,
  buildSelfHealEventsSnapshot: mockBuildSelfHealEventsSnapshot,
  buildSafetySelfHealSnapshot: mockBuildSafetySelfHealSnapshot,
  buildSelfHealInspectionSnapshot: mockBuildSelfHealInspectionSnapshot,
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlHealth: mockGetWorkerControlHealth,
}));

jest.unstable_mockModule('../src/platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: mockGetWorkerRuntimeStatus,
}));

jest.unstable_mockModule('../src/platform/runtime/unifiedConfig.js', () => ({
  getConfig: mockGetConfig,
  getEnvVar: jest.fn(),
  isRailwayEnvironment: jest.fn(() => false),
  resolveWorkerRuntimeMode: jest.fn(() => ({ mode: 'disabled', enabled: false })),
  validateConfig: jest.fn(() => ({ ok: true, issues: [] })),
  getConfigValue: jest.fn(),
}));

jest.unstable_mockModule('../src/services/arcanosCliRuntimeService.js', () => ({
  isArcanosCliAvailable: mockIsArcanosCliAvailable,
  runArcanosCLI: mockRunArcanosCLI,
}));

jest.unstable_mockModule('../src/services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    getDiagnosticsSnapshot: mockGetDiagnosticsSnapshot,
    getHealthSnapshot: mockGetHealthSnapshot,
  },
}));

jest.unstable_mockModule('../src/routes/ask/dagTools.js', () => ({
  tryExecuteDeterministicDagTools: mockTryExecuteDeterministicDagTools,
}));

jest.unstable_mockModule('../src/shared/typeGuards.js', () => ({
  isRecord(value: unknown) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');
const { getMetricsText, resetAppMetricsForTests } = await import('../src/platform/observability/appMetrics.js');
const {
  clearPromptDebugTracesForTest,
  getLatestPromptDebugTrace,
} = await import('../src/services/promptDebugTraceService.js');
const {
  clearAiRoutingDebugSnapshotsForTest,
  getLatestAiRoutingDebugSnapshot,
} = await import('../src/services/aiRoutingDebugService.js');

describe('routeGptRequest MCP dispatch branch', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await clearPromptDebugTracesForTest();
    clearAiRoutingDebugSnapshotsForTest();
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
    mockBuildSelfHealRuntimeSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      loopStatus: { loopRunning: true, activeMitigation: null },
      telemetry: { recentEvents: [] },
    });
    mockBuildSelfHealEventsSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      count: 0,
      events: [],
    });
    mockBuildSafetySelfHealSnapshot.mockReturnValue({
      status: 'ok',
      lastHealResult: 'success',
      recentEvents: [],
    });
    mockBuildSelfHealInspectionSnapshot.mockResolvedValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      summary: 'Collected 3 self-heal runtime events.',
      evidence: {
        selfHealRuntimeSnapshot: {
          status: 'ok',
          lastDecision: 'observe',
          lastAIDiagnosis: {
            advisor: 'arcanos_core_v1',
            decision: 'observe',
          },
        },
        recentSelfHealEvents: [
          {
            ts: '2026-03-27T00:00:00.000Z',
            type: 'AI_DIAGNOSIS_REQUEST',
            source: '/api/self-heal/events',
            payload: { trigger: 'interval' },
          },
          {
            ts: '2026-03-27T00:00:01.000Z',
            type: 'AI_DIAGNOSIS_RESULT',
            source: '/api/self-heal/events',
            payload: { decision: 'observe' },
          },
          {
            ts: '2026-03-27T00:00:01.000Z',
            type: 'CONTROLLER_DECISION',
            source: '/api/self-heal/events',
            payload: { decision: 'observe' },
          },
        ],
        recentPromptDebugEvents: [],
        recentAIRoutingEvents: [],
        recentWorkerEvidence: [],
      },
      limits: {
        selfHealEvents: 10,
        promptDebugEvents: 10,
        aiRoutingEvents: 10,
        workerEvidence: 10,
      },
    });
    mockGetWorkerControlHealth.mockResolvedValue({
      overallStatus: 'healthy',
      workers: [],
    });
    mockGetWorkerRuntimeStatus.mockReturnValue({
      enabled: true,
      configuredCount: 2,
      started: true,
      model: 'gpt-5',
    });
    mockGetConfig.mockReturnValue({
      defaultModel: 'gpt-5',
      nodeEnv: 'test',
    });
    mockIsArcanosCliAvailable.mockResolvedValue(true);
    mockRunArcanosCLI.mockImplementation(async (command: string) => ({
      available: true,
      command,
      cliPath: '/workspace/packages/cli/dist/index.js',
      stdout: JSON.stringify({ ok: true, data: { command } }),
      stderr: '',
      parsedOutput: { ok: true, data: { command } },
      exitCode: 0,
      timedOut: false,
      error: null,
    }));
    mockGetHealthSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      uptime: 12.3,
      memory: { rss_mb: 12 },
    });
    mockGetDiagnosticsSnapshot.mockResolvedValue({
      avg_latency_ms: 18,
      recent_latency_ms: [18],
      requests_total: 10,
      errors_total: 0,
    });
    mockTryExecuteDeterministicDagTools.mockResolvedValue(null);
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

  it('preserves live runtime verification by routing canonical GPT prompts into runtime inspection', async () => {
    const request = {
      method: 'POST',
      originalUrl: '/gpt/arcanos-core',
      traceId: 'trace-runtime-1',
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const prompt = 'verify in production on the live backend runtime that is currently active';
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
      },
      requestId: 'req-runtime-1',
      request,
    });

    expect(request.app.locals.arcanosMcp.invokeTool).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'runtime-inspection',
          runtimeInspection: expect.objectContaining({
            detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
            cliUsed: true,
            repoFallbackUsed: false,
            evidence: expect.objectContaining({
              selfHealRuntimeSnapshot: expect.objectContaining({
                lastDecision: 'observe',
              }),
              recentSelfHealEvents: expect.arrayContaining([
                expect.objectContaining({ type: 'AI_DIAGNOSIS_REQUEST' }),
                expect.objectContaining({ type: 'AI_DIAGNOSIS_RESULT' }),
                expect.objectContaining({ type: 'CONTROLLER_DECISION' }),
              ]),
            }),
          }),
        }),
        _route: expect.objectContaining({
          action: 'runtime.inspect',
        }),
      })
    );

    expect(await getLatestPromptDebugTrace('req-runtime-1')).toMatchObject({
      requestId: 'req-runtime-1',
      rawPrompt: prompt,
      normalizedPrompt: prompt,
      selectedRoute: 'core',
      selectedModule: 'ARCANOS:CORE',
      selectedTools: expect.arrayContaining(['/api/self-heal/runtime', '/api/self-heal/events', '/status/safety/self-heal', '/worker-helper/health', '/workers/status', 'cli:status', 'system.metrics']),
      runtimeInspectionChosen: true,
      explicitlyRequestedLiveRuntimeVerification: true,
      liveRuntimeRequirementPreserved: true,
      preservedConstraints: expect.arrayContaining(['runtime', 'currently active', 'verify in production']),
      droppedConstraints: [],
      finalExecutorPayload: expect.objectContaining({
        executor: 'runtime-inspection',
        cliUsed: true,
      }),
    });
    expect(getLatestAiRoutingDebugSnapshot('req-runtime-1')).toMatchObject({
      requestId: 'req-runtime-1',
      detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
      routingDecision: 'runtime_inspection_completed',
      cliUsed: true,
      repoFallbackUsed: false,
      toolsSelected: expect.arrayContaining(['cli:status']),
      runtimeEndpointsQueried: expect.arrayContaining(['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection', '/status/safety/self-heal', '/worker-helper/health', '/workers/status']),
    });
  });

  it.each([
    {
      prompt: 'trigger a real DAG run',
      selectedTools: ['dag.run.create'],
      runId: 'dagrun_exec_1',
      artifacts: {
        'dag.run.create': {
          runId: 'dagrun_exec_1',
          status: 'queued',
        },
      },
    },
    {
      prompt: 'run a live DAG trace',
      selectedTools: ['dag.run.create', 'dag.run.trace'],
      runId: 'dagrun_exec_2',
      artifacts: {
        'dag.run.create': {
          runId: 'dagrun_exec_2',
          status: 'queued',
        },
        'dag.run.trace': {
          runId: 'dagrun_exec_2',
          trace: {
            run: {
              runId: 'dagrun_exec_2',
              status: 'queued',
            },
          },
        },
      },
    },
    {
      prompt: 'execute DAG and return lineage',
      selectedTools: ['dag.run.create', 'dag.run.lineage'],
      runId: 'dagrun_exec_3',
      artifacts: {
        'dag.run.create': {
          runId: 'dagrun_exec_3',
          status: 'queued',
        },
        'dag.run.lineage': {
          runId: 'dagrun_exec_3',
          lineage: [],
          loopDetected: false,
        },
      },
    },
  ])('routes clear DAG execution prompt "$prompt" into dag execution instead of runtime inspection', async ({ prompt, selectedTools, runId, artifacts }) => {
    mockHasDagOrchestrationIntentCue.mockReturnValue(true);
    mockTryExecuteDeterministicDagTools.mockResolvedValue({
      summary: `Started DAG run ${runId}.`,
      runId,
      deferredToolNames: [],
      operations: selectedTools.map((toolName) => ({
        toolName:
          toolName === 'dag.run.create'
            ? 'create_dag_run'
            : toolName === 'dag.run.trace'
            ? 'get_dag_trace'
            : 'get_dag_lineage',
        output: artifacts[toolName as keyof typeof artifacts],
        summary: `Executed ${toolName}.`,
      })),
    });

    const request = {
      method: 'POST',
      originalUrl: '/gpt/arcanos-core',
      traceId: `trace-${runId}`,
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
        sessionId: `sess-${runId}`,
      },
      requestId: `req-${runId}`,
      request,
    });

    expect(mockTryExecuteDeterministicDagTools).toHaveBeenCalledWith(prompt, {
      sessionId: `sess-${runId}`,
      requestId: `req-${runId}`,
      traceId: `trace-${runId}`,
      logger: undefined,
    });
    expect(request.app.locals.arcanosMcp.invokeTool).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'dag-dispatcher',
          dag: expect.objectContaining({
            dispatchMode: 'automatic',
            reason: 'prompt_requests_dag_execution',
            runId,
            artifacts: expect.objectContaining(artifacts),
          }),
        }),
        _route: expect.objectContaining({
          action: 'dag.run.create',
        }),
      })
    );

    expect(await getLatestPromptDebugTrace(`req-${runId}`)).toMatchObject({
      requestId: `req-${runId}`,
      selectedRoute: 'core',
      selectedModule: 'ARCANOS:CORE',
      selectedTools: selectedTools,
      runtimeInspectionChosen: false,
      finalExecutorPayload: expect.objectContaining({
        executor: 'dag-dispatcher',
        runId,
      }),
    });
    expect(getLatestAiRoutingDebugSnapshot(`req-${runId}`)).toMatchObject({
      requestId: `req-${runId}`,
      detectedIntent: 'DAG_EXECUTION_REQUIRED',
      routingDecision: 'dag_execution_completed',
      toolsSelected: selectedTools,
      cliUsed: false,
      repoFallbackUsed: false,
    });
  });

  it.each([
    'run diagnostics',
    'inspect self-heal',
    'check workers',
    'show runtime status',
  ])('keeps runtime diagnostics prompt "%s" on runtime inspection routing', async (prompt) => {
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    const request = {
      method: 'POST',
      originalUrl: '/gpt/arcanos-core',
      traceId: `trace-${prompt}`,
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
      },
      requestId: `req-${prompt}`,
      request,
    });

    expect(mockTryExecuteDeterministicDagTools).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'runtime-inspection',
        }),
        _route: expect.objectContaining({
          action: 'runtime.inspect',
        }),
      })
    );
  });

  it('returns explicit runtime inspection unavailable when repo inspection is disallowed', async () => {
    mockBuildSelfHealRuntimeSnapshot.mockImplementation(() => {
      throw new Error('runtime unavailable');
    });
    mockBuildSelfHealEventsSnapshot.mockImplementation(() => {
      throw new Error('events unavailable');
    });
    mockBuildSelfHealInspectionSnapshot.mockImplementation(() => {
      throw new Error('inspection unavailable');
    });
    mockBuildSafetySelfHealSnapshot.mockImplementation(() => {
      throw new Error('self-heal unavailable');
    });
    mockGetWorkerControlHealth.mockRejectedValue(new Error('worker health unavailable'));
    mockGetWorkerRuntimeStatus.mockImplementation(() => {
      throw new Error('worker runtime unavailable');
    });
    mockIsArcanosCliAvailable.mockResolvedValue(false);
    mockGetHealthSnapshot.mockImplementation(() => {
      throw new Error('metrics unavailable');
    });
    mockShouldInspectRepoPrompt.mockReturnValue(true);

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'Read live runtime state. Do not use repo inspection.',
      },
      requestId: 'req-runtime-2',
      request: {
        method: 'POST',
        originalUrl: '/gpt/arcanos-core',
      } as any,
    });

    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'RUNTIME_INSPECTION_UNAVAILABLE',
          message: 'runtime inspection unavailable',
        }),
      })
    );
    expect(getLatestAiRoutingDebugSnapshot('req-runtime-2')).toMatchObject({
      requestId: 'req-runtime-2',
      detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
      routingDecision: 'runtime_inspection_unavailable',
      repoFallbackUsed: false,
      cliUsed: false,
    });
  });

  it.each([
    {
      prompt: 'trigger a real DAG run',
      selectedTools: ['dag.run.create'],
      runId: 'dagrun_exec_1',
      artifacts: {
        'dag.run.create': {
          runId: 'dagrun_exec_1',
          status: 'queued',
        },
      },
    },
    {
      prompt: 'run a live DAG trace',
      selectedTools: ['dag.run.create', 'dag.run.trace'],
      runId: 'dagrun_exec_2',
      artifacts: {
        'dag.run.create': {
          runId: 'dagrun_exec_2',
          status: 'queued',
        },
        'dag.run.trace': {
          runId: 'dagrun_exec_2',
          trace: {
            run: {
              runId: 'dagrun_exec_2',
              status: 'queued',
            },
          },
        },
      },
    },
    {
      prompt: 'execute DAG and return lineage',
      selectedTools: ['dag.run.create', 'dag.run.lineage'],
      runId: 'dagrun_exec_3',
      artifacts: {
        'dag.run.create': {
          runId: 'dagrun_exec_3',
          status: 'queued',
        },
        'dag.run.lineage': {
          runId: 'dagrun_exec_3',
          lineage: [],
          loopDetected: false,
        },
      },
    },
  ])('routes clear DAG execution prompt "$prompt" into dag execution instead of runtime inspection', async ({ prompt, selectedTools, runId, artifacts }) => {
    mockHasDagOrchestrationIntentCue.mockReturnValue(true);
    mockTryExecuteDeterministicDagTools.mockResolvedValue({
      summary: `Started DAG run ${runId}.`,
      runId,
      operations: selectedTools.map((toolName) => ({
        toolName:
          toolName === 'dag.run.create'
            ? 'create_dag_run'
            : toolName === 'dag.run.trace'
              ? 'get_dag_trace'
              : 'get_dag_lineage',
        output: artifacts[toolName as keyof typeof artifacts],
        summary: `Executed ${toolName}.`,
      })),
      deferredToolNames: [],
    });

    const request = {
      method: 'POST',
      originalUrl: '/gpt/arcanos-core',
      traceId: `trace-${runId}`,
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
        sessionId: `sess-${runId}`,
      },
      requestId: `req-${runId}`,
      request,
    });

    expect(mockTryExecuteDeterministicDagTools).toHaveBeenCalledWith(prompt, {
      sessionId: `sess-${runId}`,
      requestId: `req-${runId}`,
      traceId: `trace-${runId}`,
      requestBudgetMs: undefined,
      logger: undefined,
    });
    expect(request.app.locals.arcanosMcp.invokeTool).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'dag-dispatcher',
          dag: expect.objectContaining({
            dispatchMode: 'automatic',
            reason: 'prompt_requests_dag_execution',
            runId,
            artifacts: expect.objectContaining(artifacts),
            followUp: expect.objectContaining({
              runId,
              trace: `/api/arcanos/dag/runs/${runId}/trace`,
              tree: `/api/arcanos/dag/runs/${runId}/tree`,
              lineage: `/api/arcanos/dag/runs/${runId}/lineage`,
              metrics: `/api/arcanos/dag/runs/${runId}/metrics`,
              errors: `/api/arcanos/dag/runs/${runId}/errors`,
              verification: `/api/arcanos/dag/runs/${runId}/verification`,
            }),
          }),
        }),
        _route: expect.objectContaining({
          action: 'dag.run.create',
        }),
      })
    );

    expect(await getLatestPromptDebugTrace(`req-${runId}`)).toMatchObject({
      requestId: `req-${runId}`,
      selectedRoute: 'core',
      selectedModule: 'ARCANOS:CORE',
      selectedTools,
      runtimeInspectionChosen: false,
      finalExecutorPayload: expect.objectContaining({
        executor: 'dag-dispatcher',
        runId,
      }),
    });
    const promptDebugTrace = await getLatestPromptDebugTrace(`req-${runId}`);
    expect(promptDebugTrace?.intentTags).toContain('dag_execution_requested');
    expect(promptDebugTrace?.intentTags).not.toContain('runtime_inspection_requested');
    expect(getLatestAiRoutingDebugSnapshot(`req-${runId}`)).toMatchObject({
      requestId: `req-${runId}`,
      detectedIntent: 'DAG_EXECUTION_REQUIRED',
      routingDecision: 'dag_execution_completed',
      toolsSelected: selectedTools,
      cliUsed: false,
      repoFallbackUsed: false,
    });
  });

  it.each([
    'run diagnostics',
    'inspect self-heal',
    'check workers',
    'show runtime status',
  ])('keeps runtime diagnostics prompt "%s" on runtime inspection routing', async (prompt) => {
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    const request = {
      method: 'POST',
      originalUrl: '/gpt/arcanos-core',
      traceId: `trace-${prompt}`,
      app: {
        locals: {
          arcanosMcp: {
            invokeTool: jest.fn(),
            listTools: jest.fn(),
          },
        },
      },
    } as any;

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: prompt,
      },
      requestId: `req-${prompt}`,
      request,
    });

    expect(mockTryExecuteDeterministicDagTools).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          handledBy: 'runtime-inspection',
        }),
        _route: expect.objectContaining({
          action: 'runtime.inspect',
        }),
      })
    );
  });

  it('automatically resolves latest DAG trace prompts into dag.run.trace after latest-run lookup', async () => {
    const invokeTool = jest.fn()
      .mockResolvedValueOnce({
        structuredContent: {
          summary: 'Most recent DAG run is dagrun_latest_1.',
          run: {
            runId: 'dagrun_latest_1',
            status: 'complete',
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_1',
            status: 'complete',
          },
          tree: {
            nodes: [{ nodeId: 'planner', agentRole: 'planner', status: 'complete' }],
          },
          metrics: {
            metrics: { totalNodes: 1, totalFailures: 0 },
          },
          verification: {
            verification: { runCompleted: true },
          },
          sections: {
            requested: ['run', 'tree', 'metrics', 'verification'],
          },
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

    expect(invokeTool).toHaveBeenNthCalledWith(1, {
      toolName: 'dag.run.latest',
      toolArguments: {
        sessionId: 'sess-dag-1',
      },
      request,
      sessionId: 'sess-dag-1',
    });
    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      toolName: 'dag.run.trace',
      toolArguments: {
        runId: 'dagrun_latest_1',
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
            toolName: 'dag.run.trace',
            dispatchMode: 'automatic',
            reason: 'prompt_requests_latest_dag_run',
            output: expect.objectContaining({
              run: expect.objectContaining({
                runId: 'dagrun_latest_1',
              }),
              tree: expect.objectContaining({
                nodes: expect.any(Array),
              }),
            }),
          }),
        }),
      })
    );
    expect((envelope as any).result.mcp.output.tree.nodes[0].nodeId).toBe('planner');

    const metricsText = await getMetricsText();
    expect(metricsText).toMatch(/mcp_auto_invoke_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*tool_name="dag\.run\.latest"[^}]*reason="prompt_requests_latest_dag_run"[^}]*\} 1/);
    expect(metricsText).toMatch(/mcp_auto_invoke_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*tool_name="dag\.run\.trace"[^}]*reason="prompt_requests_latest_dag_run"[^}]*\} 1/);
    expect(metricsText).toMatch(/dispatcher_route_total\{[^}]*gpt_id="arcanos-core"[^}]*module="ARCANOS:CORE"[^}]*route="core"[^}]*handler="mcp-dispatcher"[^}]*outcome="ok"[^}]*\} 1/);
  });

  it('bypasses the memory dispatcher for DAG intent prompts even when memory cues are present', async () => {
    const invokeTool = jest.fn()
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_2',
            status: 'complete',
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_2',
            status: 'complete',
          },
          tree: {
            nodes: [{ nodeId: 'planner' }],
          },
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
    expect(invokeTool).toHaveBeenNthCalledWith(1, {
      toolName: 'dag.run.latest',
      toolArguments: {},
      request,
      sessionId: undefined,
    });
    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      toolName: 'dag.run.trace',
      toolArguments: { runId: 'dagrun_latest_2' },
      request,
      sessionId: undefined,
    });
    expect(envelope.ok).toBe(true);
  });

  it('retries DAG routing when the memory dispatcher ignores a misclassified DAG prompt', async () => {
    const invokeTool = jest.fn()
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_3',
            status: 'complete',
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_3',
            status: 'complete',
          },
          tree: {
            nodes: [{ nodeId: 'planner' }],
          },
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
    expect(invokeTool).toHaveBeenNthCalledWith(1, {
      toolName: 'dag.run.latest',
      toolArguments: {},
      request,
      sessionId: undefined,
    });
    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      toolName: 'dag.run.trace',
      toolArguments: { runId: 'dagrun_latest_3' },
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
    const invokeTool = jest.fn()
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_4',
            status: 'complete',
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          run: {
            runId: 'dagrun_latest_4',
            status: 'complete',
          },
          tree: {
            nodes: [{ nodeId: 'planner' }],
          },
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

    expect(invokeTool).toHaveBeenNthCalledWith(1, {
      toolName: 'dag.run.latest',
      toolArguments: {
        sessionId: 'sess-dag-command',
      },
      request,
      sessionId: 'sess-dag-command',
    });
    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      toolName: 'dag.run.trace',
      toolArguments: {
        runId: 'dagrun_latest_4',
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
});
