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
    invokeTool: jest.fn(),
    listTools: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: mockBuildRepoInspectionAnswer,
  collectRepoImplementationEvidence: mockCollectRepoImplementationEvidence,
  shouldInspectRepoPrompt: mockShouldInspectRepoPrompt,
}));

jest.unstable_mockModule('../src/services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null),
}));

jest.unstable_mockModule('../src/shared/typeGuards.js', () => ({
  isRecord(value: unknown) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');

describe('routeGptRequest gaming routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-gaming': { route: 'gaming', module: 'ARCANOS:GAMING' },
      gaming: { route: 'gaming', module: 'ARCANOS:GAMING' },
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-gaming': { route: 'gaming', module: 'ARCANOS:GAMING' },
      gaming: { route: 'gaming', module: 'ARCANOS:GAMING' },
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: ['arcanos-core', 'core'],
      missingGptIds: [],
      registeredGptIds: ['arcanos-gaming', 'gaming', 'tutor'],
      registeredGptCount: 3,
    });
    mockGetModuleMetadata.mockImplementation((moduleName: string) => {
      if (moduleName === 'ARCANOS:GAMING') {
        return {
          name: 'ARCANOS:GAMING',
          actions: ['query'],
          route: 'gaming',
          defaultAction: 'query',
          defaultTimeoutMs: 60000,
        };
      }
      return {
        name: 'ARCANOS:TUTOR',
        actions: ['query'],
        route: 'tutor',
      };
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockShouldInspectRepoPrompt.mockReturnValue(true);
    mockCollectRepoImplementationEvidence.mockResolvedValue({
      status: 'implemented',
      checks: [],
      evidence: { rootPath: '/workspace', filesFound: [], commandsDetected: [], repoToolsDetected: [] },
    });
    mockBuildRepoInspectionAnswer.mockReturnValue('repo-answer');
    mockDispatchModuleAction.mockResolvedValue({
      ok: true,
      route: 'gaming',
      mode: 'guide',
      data: {
        response: 'Gaming pipeline response',
        sources: [],
      },
    });
  });

  it('dispatches exact arcanos-gaming requests to the gaming module with the validated payload contract', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Ping the gaming backend and inspect whether repo tools exist before SWTOR tips ingestion.',
          game: 'SWTOR',
        },
      },
      requestId: 'req-gaming-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Ping the gaming backend and inspect whether repo tools exist before SWTOR tips ingestion.',
      game: 'SWTOR',
    }));
    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          route: 'gaming',
          mode: 'guide',
          data: expect.objectContaining({
            response: 'Gaming pipeline response',
          }),
        }),
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('forces arcanos-gaming to the gaming module even if the generic GPT map is misconfigured', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-gaming': { route: 'tutor', module: 'ARCANOS:TUTOR' },
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });

    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Inspect the repo tools before answering my SWTOR guide question.',
        },
      },
      requestId: 'req-gaming-override-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Inspect the repo tools before answering my SWTOR guide question.',
    }));
    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('forces gaming alias requests to the gaming module even if the generic GPT map is misconfigured', async () => {
    mockGetGptModuleMap.mockResolvedValue({
      gaming: { route: 'tutor', module: 'ARCANOS:TUTOR' },
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });

    const envelope = await routeGptRequest({
      gptId: 'gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Give me Minecraft first-night survival tips.',
          game: 'Minecraft',
        },
      },
      requestId: 'req-gaming-alias-override-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Give me Minecraft first-night survival tips.',
      game: 'Minecraft',
    }));
    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          gptId: 'gaming',
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it.each([
    ['ARCANOS-GAMING', 'arcanos-gaming'],
    ['Gaming', 'gaming'],
  ])('forces %s requests to Gaming before generic normalized map fallback', async (incomingGptId, matchedId) => {
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-gaming': { route: 'tutor', module: 'ARCANOS:TUTOR' },
      gaming: { route: 'tutor', module: 'ARCANOS:TUTOR' },
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });

    const envelope = await routeGptRequest({
      gptId: incomingGptId,
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Give me Minecraft first-night survival tips.',
          game: 'Minecraft',
        },
      },
      requestId: `req-gaming-normalized-${matchedId}`,
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Give me Minecraft first-night survival tips.',
      game: 'Minecraft',
    }));
    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          gptId: incomingGptId,
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
          matchMethod: 'normalized',
        }),
      })
    );
  });

  it('fails validation when query payload has no prompt', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          game: 'SWTOR',
        },
      },
      requestId: 'req-gaming-2',
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Query actions require message/prompt (or messages[]).',
        }),
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('uses the gaming module timeout budget instead of the generic 15s dispatcher timeout', async () => {
    jest.useFakeTimers();
    try {
      const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      mockDispatchModuleAction.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({
              ok: true,
              route: 'gaming',
              mode: 'guide',
              data: {
                response: 'Slow but valid gaming response',
                sources: [],
              },
            }), 20_000);
          })
      );

      const envelopePromise = routeGptRequest({
        gptId: 'arcanos-gaming',
        body: {
          action: 'query',
          payload: {
            mode: 'guide',
            prompt: 'Give me SWTOR gearing help.',
          },
        },
        requestId: 'req-gaming-timeout-budget-1',
        logger,
      });

      await jest.advanceTimersByTimeAsync(20_000);
      const envelope = await envelopePromise;

      expect(envelope).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            route: 'gaming',
            mode: 'guide',
            data: expect.objectContaining({
              response: 'Slow but valid gaming response',
            }),
          }),
          _route: expect.objectContaining({
            module: 'ARCANOS:GAMING',
            action: 'query',
            route: 'gaming',
          }),
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'gpt.dispatch.plan',
        expect.objectContaining({
          requestId: 'req-gaming-timeout-budget-1',
          module: 'ARCANOS:GAMING',
          action: 'query',
          timeoutMs: 60000,
          timeoutSource: 'module-default',
        })
      );
      expect(logger.error).not.toHaveBeenCalledWith(
        'gpt.dispatch.timeout',
        expect.anything()
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a controlled gaming generation timeout envelope instead of surfacing MODULE_TIMEOUT', async () => {
    mockDispatchModuleAction.mockResolvedValueOnce({
      ok: false,
      route: 'gaming',
      mode: 'guide',
      error: {
        code: 'GENERATION_TIMEOUT',
        message: 'Gaming generation timed out before a complete answer was available.',
        details: {
          timeoutMs: 50_000,
          stageTimeoutMs: 15_000,
          timeoutPhase: 'reasoning',
        },
      },
    });

    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Give me SWTOR gearing help.',
        },
      },
      requestId: 'req-gaming-generation-timeout-envelope',
    });

    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          ok: false,
          route: 'gaming',
          mode: 'guide',
          error: expect.objectContaining({
            code: 'GENERATION_TIMEOUT',
          }),
        }),
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
    expect(envelope).not.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'MODULE_TIMEOUT',
        }),
      })
    );
  });

  it('preserves parent request aborts instead of classifying them as module timeouts', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('GPT route client disconnected'), {
      name: 'AbortError',
    }));

    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Give me SWTOR gearing help.',
        },
      },
      requestId: 'req-gaming-parent-abort-dispatch',
      logger,
      parentAbortSignal: controller.signal,
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'REQUEST_ABORTED',
        }),
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
    expect(envelope).not.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'MODULE_TIMEOUT',
        }),
      })
    );
  });

  it('rejects missing gptId before dispatch resolution', async () => {
    const envelope = await routeGptRequest({
      gptId: '',
      body: {
        action: 'query',
        payload: {
          prompt: 'Ping the gaming backend',
        },
      },
      requestId: 'req-gaming-missing-gpt',
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Missing gptId',
        }),
      })
    );
  });

  it('rejects unknown GPT ids instead of silently falling back', async () => {
    const envelope = await routeGptRequest({
      gptId: 'unknown-gpt',
      body: {
        action: 'query',
        payload: {
          prompt: 'Ping the gaming backend',
        },
      },
      requestId: 'req-gaming-unknown-gpt',
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'UNKNOWN_GPT',
          message: "gptId 'unknown-gpt' is not registered",
        }),
      })
    );
  });

  it('returns the fixed diagnostic payload for ping probes before gameplay routing', async () => {
    const first = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'ping'
      },
      requestId: 'req-gaming-ping-1',
    });
    const second = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'ping'
      },
      requestId: 'req-gaming-ping-2',
    });
    const third = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'ping'
      },
      requestId: 'req-gaming-ping-3',
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(first).toEqual({
      ok: true,
      result: {
        ok: true,
        route: 'diagnostic',
        message: 'backend operational',
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-gaming',
        module: 'diagnostic',
        action: 'diagnostic',
        route: 'diagnostic',
      }),
    });
    expect(second).toEqual(
      expect.objectContaining({
        ...first,
        _route: expect.objectContaining({
          gptId: 'arcanos-gaming',
          module: 'diagnostic',
          action: 'diagnostic',
          route: 'diagnostic',
          requestId: 'req-gaming-ping-2',
        }),
      })
    );
    expect(third).toEqual(
      expect.objectContaining({
        ...first,
        _route: expect.objectContaining({
          gptId: 'arcanos-gaming',
          module: 'diagnostic',
          action: 'diagnostic',
          route: 'diagnostic',
          requestId: 'req-gaming-ping-3',
        }),
      })
    );
    expect(second.result).toEqual(first.result);
    expect(third.result).toEqual(first.result);
  });

  it('dispatches top-level guide mode requests as Gaming payloads', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        mode: 'guide',
        action: 'query',
        prompt: 'Give me SWTOR gearing help.'
      },
      requestId: 'req-gaming-top-level-mode-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Give me SWTOR gearing help.',
    }));
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('merges top-level Gaming mode into explicit payloads that omit mode', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        mode: 'guide',
        game: 'SWTOR',
        payload: {
          prompt: 'Give me SWTOR gearing help.',
        },
      },
      requestId: 'req-gaming-merged-mode-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      game: 'SWTOR',
      prompt: 'Give me SWTOR gearing help.',
    }));
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('preserves explicit payload Gaming mode over conflicting top-level mode', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        mode: 'meta',
        game: 'SWTOR',
        payload: {
          mode: 'guide',
          prompt: 'Give me SWTOR movement tips.',
        },
      },
      requestId: 'req-gaming-payload-mode-wins-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      game: 'SWTOR',
      prompt: 'Give me SWTOR movement tips.',
    }));
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('keeps explicit payload prompt aliases ahead of top-level prompt aliases', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        mode: 'guide',
        message: 'ping',
        payload: {
          prompt: 'Give me SWTOR gearing help.',
        },
      },
      requestId: 'req-gaming-payload-prompt-wins-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Give me SWTOR gearing help.',
    }));
    expect(mockDispatchModuleAction).not.toHaveBeenCalledWith(
      'ARCANOS:GAMING',
      'query',
      expect.objectContaining({
        message: 'ping',
      })
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it('uses the Gaming default query action when action is omitted', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        payload: {
          mode: 'guide',
          prompt: 'Give me beginner tips for surviving the first night.',
          game: 'Minecraft',
        },
      },
      requestId: 'req-gaming-default-action-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Give me beginner tips for surviving the first night.',
      game: 'Minecraft',
    }));
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });

  it.each([
    ['runtime.inspect', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['workers.status', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['queue.inspect', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['self_heal.status', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['system_state', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['get_status', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['get_result', 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT'],
    ['mcp.invoke', 'MCP_CONTROL_REQUIRES_MCP_API'],
    ['dag.dispatch', 'DAG_CONTROL_REQUIRES_DIRECT_ENDPOINT'],
  ])('rejects %s before Gaming module dispatch', async (action, errorCode) => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action,
        payload: {
          mode: 'guide',
          prompt: 'Try to access Core control-plane state.',
        },
      },
      requestId: `req-gaming-control-${action}`,
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: errorCode,
        }),
        _route: expect.objectContaining({
          module: 'control',
          route: 'control_guard',
        }),
      })
    );
  });

  it('treats nested payload prompt ping as a diagnostic probe before gameplay routing', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          prompt: 'ping'
        }
      },
      requestId: 'req-gaming-payload-ping-1',
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          ok: true,
          route: 'diagnostic',
          message: 'backend operational',
        },
        _route: expect.objectContaining({
          module: 'diagnostic',
          route: 'diagnostic',
        }),
      })
    );
  });

  it("rewrites legacy 'ask' actions onto canonical 'query' for query-capable Gaming modules", async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        action: 'ask',
        payload: {
          mode: 'guide',
          prompt: 'Give me SWTOR gearing help.'
        }
      },
      requestId: 'req-gaming-legacy-ask-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      mode: 'guide',
      prompt: 'Give me SWTOR gearing help.'
    }));
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          route: 'gaming',
          mode: 'guide',
          data: expect.objectContaining({
            response: 'Gaming pipeline response',
          }),
        }),
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          action: 'query',
          route: 'gaming',
        }),
      })
    );
  });
});
