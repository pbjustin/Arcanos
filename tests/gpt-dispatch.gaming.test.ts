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
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-gaming': { route: 'gaming', module: 'ARCANOS:GAMING' },
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: ['arcanos-core', 'core'],
      missingGptIds: [],
      registeredGptIds: ['arcanos-gaming', 'tutor'],
      registeredGptCount: 2,
    });
    mockGetModuleMetadata.mockImplementation((moduleName: string) => {
      if (moduleName === 'ARCANOS:GAMING') {
        return {
          name: 'ARCANOS:GAMING',
          actions: ['query'],
          route: 'gaming',
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
      mode: 'gameplay',
      data: {
        response: 'Gaming pipeline response',
        sources: [],
      },
    });
  });

  it('dispatches exact arcanos-gaming requests to the gaming module when mode gameplay is explicit', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        mode: 'gameplay',
        action: 'query',
        payload: {
          prompt: 'Ping the gaming backend and inspect whether repo tools exist before SWTOR tips ingestion.',
          schema: 'gaming',
          target: 'gaming_guides',
          game: 'SWTOR',
        },
      },
      requestId: 'req-gaming-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      prompt: 'Ping the gaming backend and inspect whether repo tools exist before SWTOR tips ingestion.',
      schema: 'gaming',
      target: 'gaming_guides',
      game: 'SWTOR',
    }));
    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          route: 'gaming',
          mode: 'gameplay',
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
        mode: 'gameplay',
        action: 'query',
        payload: {
          prompt: 'Inspect the repo tools before answering my SWTOR guide question.',
        },
      },
      requestId: 'req-gaming-override-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
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

  it('fails validation when gameplay query payload has no prompt', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        mode: 'gameplay',
        action: 'query',
        payload: {
          schema: 'gaming',
          target: 'gaming_guides',
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
              mode: 'gameplay',
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
          mode: 'gameplay',
          action: 'query',
          payload: {
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
            mode: 'gameplay',
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

  it('requires explicit gameplay mode instead of accepting legacy guide/build/meta modes', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        mode: 'guide',
        action: 'query',
        payload: {
          prompt: 'Give me SWTOR gearing help.'
        }
      },
      requestId: 'req-gaming-mode-required-1',
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'GAMEPLAY_MODE_REQUIRED',
          message: "Gameplay requests require explicit mode 'gameplay'.",
        }),
        _route: expect.objectContaining({
          module: 'ARCANOS:GAMING',
          route: 'gaming',
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

  it("rewrites legacy 'ask' actions onto canonical 'query' for query-capable gameplay modules", async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
        mode: 'gameplay',
        action: 'ask',
        payload: {
          prompt: 'Give me SWTOR gearing help.'
        }
      },
      requestId: 'req-gaming-legacy-ask-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', expect.objectContaining({
      prompt: 'Give me SWTOR gearing help.'
    }));
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          route: 'gaming',
          mode: 'gameplay',
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
