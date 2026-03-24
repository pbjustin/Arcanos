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
const mockDetectBackstageBookerIntent = jest.fn();

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

jest.unstable_mockModule('../src/services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: mockDetectBackstageBookerIntent,
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

describe('routeGptRequest backstage booker auto-routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' }
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' }
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: ['arcanos-core', 'core'],
      missingGptIds: [],
      registeredGptIds: ['arcanos-core', 'backstage'],
      registeredGptCount: 2,
    });
    mockGetModuleMetadata.mockImplementation((moduleName: string) => {
      if (moduleName === 'BACKSTAGE:BOOKER') {
        return {
          name: 'BACKSTAGE:BOOKER',
          actions: ['bookEvent', 'updateRoster', 'trackStoryline', 'simulateMatch', 'generateBooking', 'generateBookingWithHRC', 'saveStoryline'],
          route: 'backstage',
          defaultAction: 'generateBooking',
          defaultTimeoutMs: 60000,
        };
      }

      return {
        name: 'ARCANOS:CORE',
        actions: ['query'],
        route: 'core'
      };
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockDetectBackstageBookerIntent.mockReturnValue({
      score: 6,
      reason: 'booking_verb+storyline_request+wrestling_brand'
    });
    mockDispatchModuleAction.mockResolvedValue('Generated rivalry matrix');
  });

  it('reroutes core booking prompts to BACKSTAGE:BOOKER generateBooking', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        message: 'Generate three rivalries for RAW after WrestleMania.',
        sessionId: 'RAW_RIVALRY_TEST'
      },
      requestId: 'req-booker-1'
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('BACKSTAGE:BOOKER', 'generateBooking', {
      message: 'Generate three rivalries for RAW after WrestleMania.',
      sessionId: 'RAW_RIVALRY_TEST',
      prompt: 'Generate three rivalries for RAW after WrestleMania.'
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: 'Generated rivalry matrix',
        _route: expect.objectContaining({
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage'
        })
      })
    );
  });

  it('defaults backstage-booker traffic without an explicit action to generateBooking', async () => {
    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        prompt: 'Book a WWE Raw title-picture rivalry map for the next month.'
      },
      requestId: 'req-booker-2'
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('BACKSTAGE:BOOKER', 'generateBooking', {
      prompt: 'Book a WWE Raw title-picture rivalry map for the next month.'
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage'
        })
      })
    );
  });

  it('uses the module default action for backstage traffic even when intent detection does not match', async () => {
    mockDetectBackstageBookerIntent.mockReturnValue(null);

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        prompt: 'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: backstage-check.'
      },
      requestId: 'req-booker-3'
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('BACKSTAGE:BOOKER', 'generateBooking', {
      prompt: 'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: backstage-check.'
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        _route: expect.objectContaining({
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage'
        })
      })
    );
  });

  it("rejects legacy 'ask' actions instead of remapping them onto the module default action", async () => {
    mockDetectBackstageBookerIntent.mockReturnValue(null);

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'ask',
        prompt: 'Book tonight\'s main event arc.'
      },
      requestId: 'req-booker-legacy-ask-1'
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: "Legacy action 'ask' is not supported; use 'query'.",
        }),
        _route: expect.objectContaining({
          module: 'BACKSTAGE:BOOKER',
          action: 'ask',
          route: 'backstage'
        })
      })
    );
  });

  it('uses the backstage module timeout budget instead of the generic 15s dispatcher timeout', async () => {
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
            setTimeout(() => resolve('Long-running booking result'), 20_000);
          })
      );

      const envelopePromise = routeGptRequest({
        gptId: 'backstage',
        body: {
          prompt: 'Book a long-form month of TV with title programs and faction tension.',
        },
        requestId: 'req-booker-timeout-budget-1',
        logger,
      });

      await jest.advanceTimersByTimeAsync(20_000);
      const envelope = await envelopePromise;

      expect(envelope).toEqual(
        expect.objectContaining({
          ok: true,
          result: 'Long-running booking result',
          _route: expect.objectContaining({
            module: 'BACKSTAGE:BOOKER',
            action: 'generateBooking',
            route: 'backstage',
          }),
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'gpt.dispatch.plan',
        expect.objectContaining({
          requestId: 'req-booker-timeout-budget-1',
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
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
});
