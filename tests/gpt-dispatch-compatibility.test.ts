import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockRebuildGptModuleMap = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockDispatchModuleAction = jest.fn();

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  getMetricsText: jest.fn(),
  metricsRegistry: {},
  recordAiBudgetExceeded: jest.fn(),
  recordAiOperation: jest.fn(),
  recordDagRunRequest: jest.fn(),
  recordDagRunStatus: jest.fn(),
  recordDagTraceTimeout: jest.fn(),
  recordDependencyCall: jest.fn(),
  recordDependencyLifecycleEvent: jest.fn(),
  recordDependencyOperationGateRejection: jest.fn(),
  recordDependencyOperationInFlight: jest.fn(),
  recordDispatcherFallback: jest.fn(),
  recordDispatcherMisroute: jest.fn(),
  recordDispatcherRoute: jest.fn(),
  recordHttpRequestCompletion: jest.fn(),
  recordHttpRequestEnd: jest.fn(),
  recordHttpRequestStart: jest.fn(),
  recordJobEventCleanup: jest.fn(),
  recordJobEventInsertFailure: jest.fn(),
  recordMcpAutoInvoke: jest.fn(),
  recordMemoryDispatchIgnored: jest.fn(),
  recordUnknownGpt: jest.fn(),
  recordWorkerFailureTotal: jest.fn(),
  recordWorkerRecoveredJobs: jest.fn(),
  recordWorkerRecoveryAction: jest.fn(),
  recordWorkerJobDuration: jest.fn(),
  recordWorkerJobTotal: jest.fn(),
  recordWorkerQueueDepth: jest.fn(),
  recordWorkerQueueLatency: jest.fn(),
  recordWorkerRetryTotal: jest.fn(),
  recordWorkerLivenessWrite: jest.fn(),
  recordWorkerRuntimeHistoryWrite: jest.fn(),
  recordWorkerRuntimeSnapshotSkipped: jest.fn(),
  recordWorkerRuntimeStateWrite: jest.fn(),
  recordWorkerStaleDetection: jest.fn(),
  recordWorkerStalledJobs: jest.fn(),
  resetAppMetricsForTests: jest.fn(),
  resolveMetricRouteLabel: jest.fn(),
  shouldSkipHttpMetrics: jest.fn(() => false),
  writeMetricsResponse: jest.fn(),
}));

jest.unstable_mockModule('@services/moduleConversationPersistence.js', () => ({
  persistModuleConversation: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {
    invokeTool: jest.fn(),
    listTools: jest.fn(),
  },
}));

jest.unstable_mockModule('@services/naturalLanguageMemory.js', () => ({
  executeNaturalLanguageMemoryCommand: jest.fn(),
  extractNaturalLanguageSessionId: jest.fn(() => null),
  extractNaturalLanguageStorageLabel: jest.fn(() => null),
  hasDagOrchestrationIntentCue: jest.fn(() => false),
  hasNaturalLanguageMemoryCue: jest.fn(() => false),
  parseNaturalLanguageMemoryCommand: jest.fn(() => ({ intent: 'unknown' })),
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null),
}));

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: jest.fn(() => 'repo inspection'),
  collectRepoImplementationEvidence: jest.fn(),
  shouldInspectRepoPrompt: jest.fn(() => false),
}));

jest.unstable_mockModule('@services/systemState.js', () => ({
  executeSystemStateRequest: jest.fn(() => ({
    mode: 'system_state'
  })),
  SystemStateConflictError: class SystemStateConflictError extends Error {
    code = 'SYSTEM_STATE_CONFLICT';
    conflict = {};
  },
}));

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
  getGptModuleMap: mockGetGptModuleMap,
  rebuildGptModuleMap: mockRebuildGptModuleMap,
  validateGptRegistry: jest.fn(() => ({ requiredGptIds: ['arcanos-core'] })),
}));

jest.unstable_mockModule('../src/services/moduleRegistry.js', () => ({
  getModuleMetadata: mockGetModuleMetadata,
  dispatchModuleAction: mockDispatchModuleAction,
  initializeModuleRegistry: jest.fn(async () => undefined)
}));

const { resolveGptRouting, routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');
const { listPromptDebugTraces } = await import('../src/services/promptDebugTraceService.js');

describe('gpt dispatch compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': {
        route: 'core',
        module: 'ARCANOS:CORE'
      }
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': {
        route: 'core',
        module: 'ARCANOS:CORE'
      }
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:CORE',
      description: null,
      route: 'core',
      actions: ['query', 'system_state'],
      defaultAction: 'query'
    });
    mockDispatchModuleAction.mockResolvedValue({ ok: true });
  });

  it('accepts nested payload prompts for canonical gpt routes', async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        payload: {
          prompt: 'Reply with exactly OK.',
          extra: 'kept'
        }
      },
      requestId: 'req_nested_query'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Reply with exactly OK.',
        extra: 'kept'
      })
    );
  });

  it('uses an explicit payload prompt instead of a conflicting top-level diagnostic prompt', async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'ping',
        payload: {
          prompt: 'Write a haiku.',
          extra: 'kept'
        }
      },
      requestId: 'req_payload_overrides_diagnostic_prompt'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Write a haiku.',
        extra: 'kept'
      })
    );
  });

  it('stores the GPT route template instead of caller-controlled URL segments in trace metadata', async () => {
    const previousMode = process.env.PROMPT_DEBUG_TRACE_MODE;
    const previousPersist = process.env.PROMPT_DEBUG_TRACE_PERSIST;
    process.env.PROMPT_DEBUG_TRACE_MODE = 'metadata';
    process.env.PROMPT_DEBUG_TRACE_PERSIST = 'false';

    try {
      await routeGptRequest({
        gptId: 'arcanos-core',
        body: {
          action: 'query',
          prompt: 'Reply with exactly OK.',
        },
        requestId: 'req_dynamic_endpoint_trace',
        request: {
          method: 'POST',
          originalUrl: '/gpt/alice@example.com?private=marker',
          url: '/gpt/alice@example.com?private=marker',
          path: '/gpt/alice@example.com',
        } as never,
      });

      const [trace] = await listPromptDebugTraces(
        1,
        'req_dynamic_endpoint_trace',
      );
      expect(trace?.endpoint).toBe('/gpt/:gptId');
      expect(JSON.stringify(trace)).not.toContain('alice@example.com');
    } finally {
      if (previousMode === undefined) {
        delete process.env.PROMPT_DEBUG_TRACE_MODE;
      } else {
        process.env.PROMPT_DEBUG_TRACE_MODE = previousMode;
      }
      if (previousPersist === undefined) {
        delete process.env.PROMPT_DEBUG_TRACE_PERSIST;
      } else {
        process.env.PROMPT_DEBUG_TRACE_PERSIST = previousPersist;
      }
    }
  });

  it("maps nested legacy 'ask' payloads onto the canonical 'query' action", async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'ask',
        payload: {
          prompt: 'Reply with exactly OK.'
        }
      },
      requestId: 'req_nested_ask'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Reply with exactly OK.'
      })
    );
  });

  it('preserves the exact top-level prompt when query callers also send an explicit payload wrapper', async () => {
    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        prompt: 'Reply with exactly OK.',
        payload: {
          executionMode: 'async',
          extra: 'kept'
        }
      },
      requestId: 'req_payload_prompt_query'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        prompt: 'Reply with exactly OK.',
        executionMode: 'async',
        extra: 'kept'
      })
    );
  });

  it('accepts structured message content parts and forwards the original messages', async () => {
    const messages = [
      { role: 'system', content: 'You write compact operator notes.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Draft a release note for Trinity facade routing.' }
        ]
      }
    ];

    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        messages
      },
      requestId: 'req_structured_messages_query'
    });

    expect(response.ok).toBe(true);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({
        messages,
        prompt: 'Draft a release note for Trinity facade routing.'
      })
    );
  });

  it('returns safe Trinity integrity diagnostics without exposing output text', async () => {
    const integrityError = new Error('Trinity direct-answer output failed integrity validation.');
    Object.assign(integrityError, {
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['abrupt_mid_sentence_ending']
    });
    mockDispatchModuleAction.mockRejectedValueOnce(integrityError);

    const response = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        prompt: 'Return exactly OBSERVABILITY_SMOKE_TEST_OK.'
      },
      requestId: 'req_integrity_failed',
      traceId: 'trace_integrity_failed'
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'MODULE_ERROR',
        message: 'Trinity direct-answer output failed integrity validation.',
        details: {
          validator: 'validateTrinityAnswerIntegrity',
          failureCode: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
          expectedShape: 'complete_user_visible_answer_text',
          receivedShape: 'redacted_text',
          issues: ['abrupt_mid_sentence_ending']
        }
      })
    }));
    expect(response._route).toEqual(expect.objectContaining({
      requestId: 'req_integrity_failed',
      traceId: 'trace_integrity_failed'
    }));
    expect(JSON.stringify(response)).not.toContain('OBSERVABILITY_SMOKE_TEST_OK');
  });

  it('resolves normalized GPT IDs without executing a module action', async () => {
    const response = await resolveGptRouting(' ARCANOS-CORE ', 'req_resolve_normalized');

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        plan: expect.objectContaining({
          matchedId: 'arcanos-core',
          module: 'ARCANOS:CORE',
          route: 'core',
          action: 'query',
          availableActions: ['query', 'system_state'],
          matchMethod: 'normalized'
        }),
        _route: expect.objectContaining({
          requestId: 'req_resolve_normalized',
          gptId: 'ARCANOS-CORE',
          module: 'ARCANOS:CORE',
          route: 'core',
          action: 'query',
          matchMethod: 'normalized'
        })
      })
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it.each(['default', 'foo-arcanos-bar'])('keeps unregistered GPT ID %s unknown', async (gptId) => {
    const response = await resolveGptRouting(gptId, `req_unknown_${gptId}`);

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'UNKNOWN_GPT'
      }),
      _route: expect.objectContaining({
        requestId: `req_unknown_${gptId}`,
        gptId
      })
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it.each([
    'cli',
    'arcanos-cli',
    'ARCANOS:CLI',
    'local-agent',
    'arcanos-local-agent',
    'ARCANOS:LOCAL_AGENT',
    'productivity',
    'arcanos-productivity',
    'ARCANOS:PRODUCTIVITY'
  ])('keeps protected module identifier %s out of fuzzy public routing', async (gptId) => {
    const resolved = await resolveGptRouting(
      gptId,
      `req_protected_resolve_${gptId}`
    );
    const dispatched = await routeGptRequest({
      gptId,
      body: {
        prompt: 'This protected identifier must remain unavailable.'
      },
      requestId: `req_protected_dispatch_${gptId}`
    });

    for (const response of [resolved, dispatched]) {
      expect(response).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'UNKNOWN_GPT'
        })
      }));
    }
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
