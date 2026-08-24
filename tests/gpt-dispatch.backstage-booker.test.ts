import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
  BackstageRosterPersistenceError,
  BackstageRosterValidationError,
} from '../src/shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_MESSAGE,
  BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
  BackstageStorylinePersistenceError,
} from '../src/shared/backstage/backstageStoryline.js';
import {
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE,
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE,
  BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE,
  BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE,
  BackstageBookerOutputIncompleteError,
  BackstageBookerIntegrityFailedError,
  BackstageContinuityQueryFailedError,
} from '../src/shared/backstage/backstageGenerationError.js';
import {
  BackstageCanonDomainError,
} from '../src/core/db/repositories/backstageBookerRepository.js';
import {
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_CODE,
  BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_MESSAGE,
  BackstageBookerContractError,
  BackstageCanonUnavailableError,
  BackstageNotionAuthorityReadOnlyError,
  BackstageNotionAuthorityUnavailableError,
} from '../src/services/backstageBookerContracts.js';

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
const mockWasBackstageNotionEnrichmentUsed = jest.fn();
const mockIsBackstageLegacyQueuedExecution = jest.fn();
const mockIsBackstageProtectedQueuedExecution = jest.fn();
const mockRecordPromptDebugTrace = jest.fn();
const mockSuppressPromptDebugTraceContent = jest.fn((patch: Record<string, unknown>) => ({
  ...patch,
  rawPrompt: '[suppressed-sensitive-context]',
  normalizedPrompt: '[suppressed-sensitive-context]',
  responseReturned: '[suppressed-sensitive-context]',
  finalExecutorPayload: '[suppressed-sensitive-context]',
}));

jest.unstable_mockModule('../src/platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
  getGptModuleMap: mockGetGptModuleMap,
  rebuildGptModuleMap: mockRebuildGptModuleMap,
  validateGptRegistry: mockValidateGptRegistry,
}));

jest.unstable_mockModule('../src/services/moduleRegistry.js', () => ({
  dispatchModuleAction: mockDispatchModuleAction,
  getModuleMetadata: mockGetModuleMetadata,
  initializeModuleRegistry: jest.fn(async () => undefined),
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

jest.unstable_mockModule('../src/services/backstageNotionEnrichmentAuthorization.js', () => ({
  isBackstageNotionEnrichmentAuthorized: jest.fn(() => true),
  isBackstageLegacyQueuedExecution: mockIsBackstageLegacyQueuedExecution,
  isBackstageProtectedQueuedExecution: mockIsBackstageProtectedQueuedExecution,
  markBackstageNotionEnrichmentUsed: jest.fn(),
  wasBackstageNotionEnrichmentUsed: mockWasBackstageNotionEnrichmentUsed,
}));

jest.unstable_mockModule('../src/services/promptDebugTraceService.js', () => ({
  extractPromptText: jest.fn(() => null),
  isPromptAuthoringRequest: jest.fn(() => false),
  recordPromptDebugTrace: mockRecordPromptDebugTrace,
  resolvePromptDebugTraceMode: jest.fn(() => 'metadata'),
  shouldInspectRuntimePrompt: jest.fn(() => false),
  suppressPromptDebugTraceContent: mockSuppressPromptDebugTraceContent,
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
const {
  BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_CODE,
  BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_MESSAGE,
  BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_MESSAGE,
  BACKSTAGE_NOTION_SCOPE_RESOLUTION_ERROR_CODE,
  BackstageNotionCursorInvalidError,
  BackstageNotionIndexUnavailableError,
  BackstageNotionScopeResolutionError,
} = await import('../src/services/backstageNotionRag.js');
const {
  normalizeBackstageBookerActionPayload,
  normalizeBackstageBookerSchemaDrivenActionPayload,
} = await import(
  '../src/services/backstageBookerContracts.js'
);
const {
  buildQueuedGptBackstageMutationAdmission,
} = await import('../src/shared/gpt/asyncGptJob.js');

describe('routeGptRequest backstage booker auto-routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' },
      'backstage-booker': { route: 'backstage', module: 'BACKSTAGE:BOOKER' }
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' },
      'backstage-booker': { route: 'backstage', module: 'BACKSTAGE:BOOKER' }
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
          actions: ['bookEvent', 'updateRoster', 'trackStoryline', 'simulateMatch', 'queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'saveStoryline', 'upsertStoryline', 'appendCanonBeat'],
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
    mockWasBackstageNotionEnrichmentUsed.mockReturnValue(false);
    mockIsBackstageLegacyQueuedExecution.mockReturnValue(false);
    mockIsBackstageProtectedQueuedExecution.mockReturnValue(false);
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

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('BACKSTAGE:BOOKER', 'generateBooking', expect.objectContaining({
      message: 'Generate three rivalries for RAW after WrestleMania.',
      sessionId: 'RAW_RIVALRY_TEST',
      prompt: 'Generate three rivalries for RAW after WrestleMania.'
    }));
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

  it('does not persist a session transcript when private Notion context was used', async () => {
    mockWasBackstageNotionEnrichmentUsed.mockReturnValue(true);

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          prompt: 'Review the mapped universe.',
          universeId: 'my-universe-2k26',
          sessionId: 'PRIVATE-NOTION-SESSION',
        },
      },
      requestId: 'req-booker-notion-no-transcript'
    });

    expect(envelope).toEqual(expect.objectContaining({
      ok: true,
      result: 'Generated rivalry matrix',
    }));
    expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it.each([
    ['transport literal', 'Write exactly this token: TRANSPORT', 'Book six matches.'],
    ['canonical literal', 'Book six matches.', 'Write exactly this token: CANONICAL'],
  ])('executes the explicit canonical prompt when message is a conflicting %s', async (
    _label,
    message,
    prompt
  ) => {
    mockDispatchModuleAction.mockImplementationOnce(
      async (_moduleName: string, action: string, payload: unknown) => {
        expect(action).toBe('generateBooking');
        return normalizeBackstageBookerSchemaDrivenActionPayload(
          'generateBooking',
          payload
        ).prompt;
      }
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'canonical-prompt-dispatch-universe',
          message,
          prompt,
        },
      },
      requestId: `req-booker-canonical-prompt-${_label.replace(' ', '-')}`
    });

    expect(envelope).toEqual(expect.objectContaining({ ok: true, result: prompt }));
  });

  it('does not forward top-level universe scope into a non-Backstage explicit payload', async () => {
    mockDetectBackstageBookerIntent.mockReturnValue(null);
    mockDispatchModuleAction.mockImplementationOnce(
      async (moduleName: string, action: string, payload: unknown) => {
        expect(moduleName).toBe('ARCANOS:CORE');
        expect(action).toBe('query');
        expect(payload).toEqual(expect.objectContaining({ prompt: 'core-only prompt' }));
        expect(payload).not.toEqual(expect.objectContaining({ universeId: expect.anything() }));
        return 'core result';
      }
    );

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        universeId: 'must-not-leak',
        payload: { prompt: 'core-only prompt' }
      },
      requestId: 'req-core-universe-isolation'
    });

    expect(envelope).toEqual(expect.objectContaining({ ok: true, result: 'core result' }));
  });

  it('forwards top-level universe scope when an explicit Core payload auto-routes to Backstage', async () => {
    mockDispatchModuleAction.mockImplementationOnce(
      async (moduleName: string, action: string, payload: unknown) => {
        expect(moduleName).toBe('BACKSTAGE:BOOKER');
        expect(action).toBe('generateBooking');
        expect(payload).toEqual(expect.objectContaining({
          prompt: 'Book a WWE Raw rivalry after WrestleMania.',
          universeId: 'auto-routed-universe',
        }));
        return 'auto-routed result';
      }
    );

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        universeId: 'auto-routed-universe',
        payload: { prompt: 'Book a WWE Raw rivalry after WrestleMania.' },
      },
      requestId: 'req-core-auto-routed-universe'
    });

    expect(envelope).toEqual(expect.objectContaining({
      ok: true,
      result: 'auto-routed result',
      _route: expect.objectContaining({
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
      }),
    }));
  });

  it('defaults backstage-booker traffic without an explicit action to generateBooking', async () => {
    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        prompt: 'Book a WWE Raw title-picture rivalry map for the next month.'
      },
      requestId: 'req-booker-2'
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('BACKSTAGE:BOOKER', 'generateBooking', expect.objectContaining({
      prompt: 'Book a WWE Raw title-picture rivalry map for the next month.'
    }));
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

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('BACKSTAGE:BOOKER', 'generateBooking', expect.objectContaining({
      prompt: 'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: backstage-check.'
    }));
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

  it.each([
    [
      'bookEvent',
      {
        event: 'WrestleMania',
        venue: 'MSG',
        action: 'announce-card',
        context: { brand: 'Raw' },
        mode: 'canon',
        hrc: { requested: true },
        content: 'Night-one main event'
      }
    ],
    [
      'trackStoryline',
      {
        beat: 'turn',
        feud: 'A/B',
        action: 'betrayal',
        context: { target: 'champion' },
        mode: 'canon',
        hrc: { requested: true },
        content: 'The ally reveals the plan.'
      }
    ]
  ] as const)(
    'preserves explicit %s domain fields that collide with dispatch transport names',
    async (action, domainPayload) => {
      mockDispatchModuleAction.mockImplementationOnce(
        async (_moduleName: string, dispatchedAction: string, payload: unknown) => {
          expect(dispatchedAction).toBe(action);
          return action === 'bookEvent'
            ? normalizeBackstageBookerActionPayload('bookEvent', payload)
            : normalizeBackstageBookerActionPayload('trackStoryline', payload);
        }
      );

      const envelope = await routeGptRequest({
        gptId: 'backstage',
        body: {
          action,
          universeId: 'collision-universe',
          context: { transport: true },
          mode: 'transport-mode',
          hrc: { transport: true },
          content: 'transport-content',
          payload: domainPayload
        },
        requestId: `req-backstage-${action}-collisions`
      });

      expect(envelope).toMatchObject({
        ok: true,
        result: {
          universeId: 'collision-universe',
          [action === 'bookEvent' ? 'event' : 'beat']: domainPayload
        }
      });
    }
  );

  it('keeps only explicit event fields and top-level universe provenance at execution', async () => {
    mockDispatchModuleAction.mockImplementationOnce(
      async (_moduleName: string, dispatchedAction: string, payload: unknown) => {
        expect(dispatchedAction).toBe('bookEvent');
        return normalizeBackstageBookerActionPayload('bookEvent', payload);
      }
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'bookEvent',
        universeId: 'explicit-provenance-universe',
        game: 'transport-game',
        url: 'https://example.test/changed-source',
        urls: ['https://example.test/changed-list'],
        guideUrl: 'https://example.test/changed-guide',
        guideUrls: ['https://example.test/changed-guides'],
        payload: {
          name: 'SummerSlam',
          venue: 'Ford Field'
        }
      },
      requestId: 'req-backstage-explicit-provenance'
    });

    expect(envelope).toMatchObject({ ok: true });
    if (!envelope.ok) {
      throw new Error('Expected Backstage event dispatch to succeed.');
    }
    expect(envelope.result).toEqual({
      universeId: 'explicit-provenance-universe',
      event: {
        name: 'SummerSlam',
        venue: 'Ford Field'
      }
    });
  });

  it.each([
    ['bookEvent', 'event', { name: 'Canonical event' }],
    ['trackStoryline', 'beat', { turn: 'Canonical heel turn' }]
  ] as const)(
    'unwraps canonical %s module payloads without an explicit universeId',
    async (action, wrapperKey, domainPayload) => {
      mockDispatchModuleAction.mockImplementationOnce(
        async (_moduleName: string, dispatchedAction: string, payload: unknown) => {
          expect(dispatchedAction).toBe(action);
          return action === 'bookEvent'
            ? normalizeBackstageBookerActionPayload('bookEvent', payload)
            : normalizeBackstageBookerActionPayload('trackStoryline', payload);
        }
      );

      const envelope = await routeGptRequest({
        gptId: 'backstage',
        body: {
          action,
          payload: { [wrapperKey]: domainPayload }
        },
        requestId: `req-backstage-canonical-default-${action}`
      });

      expect(envelope).toMatchObject({
        ok: true,
        result: {
          universeId: 'legacy',
          [wrapperKey]: domainPayload
        }
      });
    }
  );

  it.each([
    ['bookEvent', 'event', { name: 'Legacy outer event' }],
    ['trackStoryline', 'beat', { turn: 'Legacy outer beat' }]
  ] as const)(
    'preserves ambiguous flattened %s object fields as legacy domain records',
    async (action, wrapperKey, domainPayload) => {
      mockDispatchModuleAction.mockImplementationOnce(
        async (_moduleName: string, dispatchedAction: string, payload: unknown) => {
          expect(dispatchedAction).toBe(action);
          return action === 'bookEvent'
            ? normalizeBackstageBookerActionPayload('bookEvent', payload)
            : normalizeBackstageBookerActionPayload('trackStoryline', payload);
        }
      );

      const envelope = await routeGptRequest({
        gptId: 'backstage',
        body: {
          action,
          [wrapperKey]: domainPayload
        },
        requestId: `req-backstage-legacy-ambiguous-${action}`
      });

      expect(envelope).toMatchObject({
        ok: true,
        result: {
          universeId: 'legacy',
          [wrapperKey]: { [wrapperKey]: domainPayload }
        }
      });
    }
  );

  it('removes flattened dispatch envelope fields from a legacy open event payload', async () => {
    mockDispatchModuleAction.mockImplementationOnce(
      async (_moduleName: string, dispatchedAction: string, payload: unknown) => {
        expect(dispatchedAction).toBe('bookEvent');
        return normalizeBackstageBookerActionPayload('bookEvent', payload);
      }
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'bookEvent',
        universeId: 'flattened-universe',
        event: 'WrestleMania',
        venue: 'MSG',
        context: { transport: true },
        mode: 'transport-mode',
        hrc: { transport: true },
        content: 'transport-content'
      },
      requestId: 'req-backstage-flattened-event'
    });

    expect(envelope).toMatchObject({
      ok: true,
      result: {
        universeId: 'flattened-universe',
        event: {
          event: 'WrestleMania',
          venue: 'MSG'
        }
      }
    });
  });

  it('fails closed before executing an unattested queued Backstage mutation', async () => {
    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'updateRoster',
        payload: [],
      },
      requestId: 'req-booker-queued-unattested',
      enforceQueuedBackstageMutationAdmission: true,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_MUTATION_ADMISSION_REQUIRED',
      },
      _route: {
        module: 'BACKSTAGE:BOOKER',
        action: 'updateRoster',
      },
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('executes only the exact queued Backstage mutation covered by admission', async () => {
    const refreshedRoster = [{ name: 'Rhea Ripley', overall: 96 }];
    mockDispatchModuleAction.mockResolvedValueOnce(refreshedRoster);
    const backstageMutationAdmission = buildQueuedGptBackstageMutationAdmission({
      action: 'updateRoster',
      principalId: 'operator:queued-backstage-test',
    });
    const admitted = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'updateRoster',
        payload: [],
      },
      requestId: 'req-booker-queued-admitted',
      enforceQueuedBackstageMutationAdmission: true,
      queuedBackstageMutationAdmission: backstageMutationAdmission,
    });

    expect(admitted).toMatchObject({
      ok: true,
      result: refreshedRoster,
      _route: {
        module: 'BACKSTAGE:BOOKER',
        action: 'updateRoster',
      },
    });
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'BACKSTAGE:BOOKER',
      'updateRoster',
      []
    );

    mockDispatchModuleAction.mockClear();
    const drifted = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'trackStoryline',
        payload: {},
      },
      requestId: 'req-booker-queued-drifted',
      enforceQueuedBackstageMutationAdmission: true,
      queuedBackstageMutationAdmission: backstageMutationAdmission,
    });

    expect(drifted).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_MUTATION_ADMISSION_MISMATCH',
      },
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it.each(['backstage', 'backstage-booker'])(
    'maps typed roster validation failures for canonical alias %s without persistence',
    async (gptId) => {
      mockDispatchModuleAction.mockImplementationOnce(
        async (_moduleName: string, action: string, payload: unknown) => {
          expect(action).toBe('updateRoster');
          return normalizeBackstageBookerActionPayload('updateRoster', payload);
        }
      );

      const envelope = await routeGptRequest({
        gptId,
        body: {
          action: 'updateRoster',
          payload: { name: 'not-an-array', overall: 90 },
        },
        requestId: `req-${gptId}-invalid-roster`,
      });

      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
          message: 'Roster payload must be an array.',
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'updateRoster',
        },
      });
      expect(mockDispatchModuleAction).toHaveBeenCalledWith(
        'BACKSTAGE:BOOKER',
        'updateRoster',
        expect.objectContaining({ name: 'not-an-array', overall: 90 })
      );
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    }
  );

  it.each(['backstage', 'backstage-booker'])(
    'maps typed storyline validation failures for canonical alias %s without persistence',
    async (gptId) => {
      mockDispatchModuleAction.mockImplementationOnce(
        async (_moduleName: string, action: string, payload: unknown) => {
          expect(action).toBe('trackStoryline');
          return normalizeBackstageBookerActionPayload('trackStoryline', payload);
        }
      );

      const envelope = await routeGptRequest({
        gptId,
        body: {
          action: 'trackStoryline',
          payload: [],
        },
        requestId: `req-${gptId}-invalid-storyline`,
      });

      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
          message: 'Storyline beat payload must be a JSON object.',
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'trackStoryline',
        },
      });
      expect(mockDispatchModuleAction).toHaveBeenCalledWith(
        'BACKSTAGE:BOOKER',
        'trackStoryline',
        []
      );
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    }
  );

  it('maps closed canon contract failures to a bounded validation envelope', async () => {
    mockDispatchModuleAction.mockImplementationOnce(
      async (_moduleName: string, action: string, payload: unknown) => (
        normalizeBackstageBookerActionPayload(
          action as 'upsertStoryline',
          payload
        )
      )
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'upsertStoryline',
        payload: {
          mutationId: '8d64dad3-f080-4bac-88ec-994005dc7152',
          expectedVersion: 0,
          storyline: {},
        },
      },
      requestId: 'req-backstage-invalid-canon',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_BOOKER_INVALID',
        message: 'Invalid Backstage Booker upsertStoryline payload.',
        details: {
          action: 'upsertStoryline',
          issues: expect.any(Array),
        },
      },
    });
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('rejects a schema-driven continuity request without its explicit universe scope', () => {
    expect(() => normalizeBackstageBookerSchemaDrivenActionPayload(
      'queryContinuity',
      { query: 'Who is the current champion?' }
    )).toThrow(BackstageBookerContractError);
  });

  it('preserves the Phase One module-error envelope for generic contract failures', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageBookerContractError('simulateMatch', [
        { instancePath: '/match', message: 'match is required' }
      ])
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'simulateMatch',
        payload: {},
      },
      requestId: 'req-backstage-phase-one-contract-compatibility',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'MODULE_ERROR',
        message: 'Invalid Backstage Booker simulateMatch payload.',
      },
    });
    expect(envelope.error).not.toHaveProperty('details');
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('preserves bounded canon domain conflicts for HTTP status mapping', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT')
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'upsertStoryline',
        payload: {},
      },
      requestId: 'req-backstage-canon-conflict',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_STORYLINE_VERSION_CONFLICT',
        message: 'The Backstage storyline changed before this mutation could be applied.',
      },
    });
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('maps classified canon outages to the retryable unavailable envelope', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageCanonUnavailableError('appendCanonBeat')
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'appendCanonBeat',
        payload: {},
      },
      requestId: 'req-backstage-canon-unavailable',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
        message: 'Backstage canon persistence is temporarily unavailable.',
        details: { retryable: true },
      },
    });
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('preserves the safe nonretryable Booker output-incomplete envelope', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageBookerOutputIncompleteError()
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return the current continuity.',
        },
      },
      requestId: 'req-backstage-output-incomplete',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE,
        message: BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE,
        details: { retryable: false },
      },
      _route: {
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-backstage-output-incomplete',
        error: BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE,
      })
    );
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('preserves only bounded Booker integrity-repair diagnostics', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageBookerIntegrityFailedError({
        integrityIssues: ['abrupt_mid_sentence_ending'],
        originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
        repairedIntegrityIssues: ['abrupt_mid_sentence_ending'],
        repairAttempted: true,
        repairFailureReason: 'revalidation_failed',
      })
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'PRIVATE-PROMPT-MUST-NOT-ESCAPE',
        },
      },
      requestId: 'req-backstage-integrity-failed',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE,
        message: BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE,
        details: {
          retryable: false,
          integrityIssues: ['abrupt_mid_sentence_ending'],
          originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
          repairedIntegrityIssues: ['abrupt_mid_sentence_ending'],
          repairAttempted: true,
          repairFailureReason: 'revalidation_failed',
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(
      'PRIVATE-PROMPT-MUST-NOT-ESCAPE'
    );
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-backstage-integrity-failed',
        error: BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE,
      })
    );
  });

  it('preserves the original issue when structural repair is safely skipped', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageBookerIntegrityFailedError({
        integrityIssues: ['abrupt_mid_sentence_ending'],
        repairAttempted: false,
        repairFailureReason: 'insufficient_time',
      })
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: { prompt: 'Book a bounded ending.' },
      },
      requestId: 'req-backstage-integrity-skipped',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE,
        details: {
          integrityIssues: ['abrupt_mid_sentence_ending'],
          originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
          repairedIntegrityIssues: [],
          repairAttempted: false,
          repairFailureReason: 'insufficient_time',
        },
      },
    });
  });

  it('preserves the safe nonretryable continuity-query internal-failure envelope', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageContinuityQueryFailedError()
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Return the current continuity.',
        },
      },
      requestId: 'req-backstage-continuity-failed',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE,
        message: BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE,
        details: { retryable: false },
      },
      _route: {
        module: 'BACKSTAGE:BOOKER',
        action: 'queryContinuity',
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-backstage-continuity-failed',
        error: BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE,
      })
    );
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'The requested Backstage Notion scope was not found.'],
    ['ambiguous', 'The requested Backstage Notion scope is ambiguous.'],
  ] as const)(
    'preserves the safe nonretryable Notion scope %s envelope',
    async (reason, message) => {
      mockDispatchModuleAction.mockRejectedValueOnce(
        new BackstageNotionScopeResolutionError(reason)
      );

      const envelope = await routeGptRequest({
        gptId: 'backstage-booker',
        body: {
          action: 'queryContinuity',
          payload: {
            universeId: 'my-universe-2k26',
            query: 'Who is the current champion?',
            retrievalScope: { pageTitle: 'Monday Night Raw' },
          },
        },
        requestId: `req-backstage-scope-${reason}`,
      });

      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_NOTION_SCOPE_RESOLUTION_ERROR_CODE,
          message,
          details: { retryable: false, reason },
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'queryContinuity',
        },
      });
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    }
  );

  it('preserves the safe nonretryable invalid continuity-cursor envelope', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageNotionCursorInvalidError()
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'queryContinuity',
        payload: {
          universeId: 'my-universe-2k26',
          query: 'Continue the scoped continuity read.',
          retrievalMode: 'complete_scope',
          cursor: 'stale-or-invalid-cursor',
        },
      },
      requestId: 'req-backstage-cursor-invalid',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_CODE,
        message: BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_MESSAGE,
        details: { retryable: false },
      },
      _route: {
        module: 'BACKSTAGE:BOOKER',
        action: 'queryContinuity',
      },
    });
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'generateBooking',
      {
        universeId: 'my-universe-2k26',
        prompt: 'Review the current show state.',
      },
    ],
    [
      'generateBookingWithHRC',
      {
        universeId: 'my-universe-2k26',
        prompt: 'Review the current show state with HRC.',
      },
    ],
    [
      'simulateMatch',
      {
        universeId: 'my-universe-2k26',
        match: {
          wrestler1: 'Becky Lynch',
          wrestler2: 'Lyra Valkyria',
          matchType: 'singles',
        },
        rosters: [],
      },
    ],
  ] as const)(
    'preserves the bounded Notion index outage for %s dispatch',
    async (action, payload) => {
      mockDispatchModuleAction.mockRejectedValueOnce(
        new BackstageNotionIndexUnavailableError()
      );

      const envelope = await routeGptRequest({
        gptId: 'backstage-booker',
        body: { action, payload },
        requestId: `req-backstage-notion-index-unavailable-${action}`,
      });

      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
          message: BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_MESSAGE,
          details: { retryable: true },
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action,
        },
      });
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    }
  );

  it('preserves a bounded retryable authority-state outage without logging its cause', async () => {
    const sensitiveCause = 'postgres://private-user:private-password@internal/authority';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageNotionAuthorityUnavailableError(
        'my-universe-2k26',
        new Error(sensitiveCause)
      )
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Review the current show state.',
        },
      },
      requestId: 'req-backstage-notion-authority-unavailable',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE',
        message: 'The Backstage Notion authority state is temporarily unavailable.',
        details: { retryable: true },
      },
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(sensitiveCause);
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it.each(['backstage', 'backstage-booker'])(
    'preserves a nonretryable Notion-authority write denial for canonical alias %s',
    async (gptId) => {
      const universeId = 'my-universe-2k26';
      const mutationActions = [
        'appendCanonBeat',
        'bookEvent',
        'saveStoryline',
        'trackStoryline',
        'upsertStoryline',
        'updateRoster',
      ] as const;

      for (const action of mutationActions) {
        mockDispatchModuleAction.mockRejectedValueOnce(
          new BackstageNotionAuthorityReadOnlyError(universeId)
        );

        const envelope = await routeGptRequest({
          gptId,
          body: {
            action,
            payload: { universeId },
          },
          requestId: `req-backstage-notion-authority-read-only-${gptId}-${action}`,
        });

        expect(envelope).toMatchObject({
          ok: false,
          error: {
            code: BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_CODE,
            message: BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_MESSAGE,
            details: { retryable: false },
          },
          _route: {
            module: 'BACKSTAGE:BOOKER',
            action,
          },
        });
      }

      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    }
  );

  it('maps the authoritative simulation roster requirement as caller validation', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageRosterValidationError(
        'An explicit numeric roster is required for Notion-authoritative match simulation.'
      )
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'simulateMatch',
        payload: {
          universeId: 'my-universe-2k26',
          match: {
            wrestler1: 'Rhea Ripley',
            wrestler2: 'Bianca Belair',
            matchType: 'Singles',
          },
          rosters: [],
        },
      },
      requestId: 'req-backstage-authority-roster-required',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
        message:
          'An explicit numeric roster is required for Notion-authoritative match simulation.',
      },
    });
  });

  it('does not expose unclassified canon repository details through the dispatch envelope', async () => {
    const sensitiveRepositoryMessage =
      'relation "backstage_storyline_threads" does not exist at /srv/arcanos/repository.ts:1382';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockDispatchModuleAction.mockRejectedValueOnce(
      new Error(sensitiveRepositoryMessage)
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'upsertStoryline',
        payload: {},
      },
      requestId: 'req-backstage-canon-unclassified-repository-error',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'MODULE_ERROR',
        message: 'Backstage canon request could not be completed.',
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(sensitiveRepositoryMessage);
    expect(JSON.stringify(envelope)).not.toContain('backstage_storyline_threads');
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-backstage-canon-unclassified-repository-error',
        module: 'BACKSTAGE:BOOKER',
        action: 'upsertStoryline',
        error: sensitiveRepositoryMessage,
      })
    );
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
  });

  it('suppresses prompt-debug content and raw failures for protected queued generation', async () => {
    const privatePrompt = 'private-protected-queue-prompt-sentinel';
    const privateFailure = 'private-protected-queue-failure-sentinel';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockIsBackstageProtectedQueuedExecution.mockReturnValue(true);
    mockDispatchModuleAction.mockRejectedValueOnce(new Error(privateFailure));

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      requestId: 'req-protected-queued-booker-failure',
      traceId: 'trace-protected-queued-booker-failure',
      runtimeExecutionMode: 'background',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'MODULE_ERROR',
        message: 'Protected Backstage generation failed.',
      },
    });
    expect(mockSuppressPromptDebugTraceContent).toHaveBeenCalled();
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privatePrompt);
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privateFailure);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privatePrompt);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateFailure);
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-protected-queued-booker-failure',
        error: 'Protected Backstage generation failed.',
      })
    );
  });

  it('keeps an early protected provider abort classified and logged as a redacted execution failure', async () => {
    const privateAbort = 'private-provider-abort-sentinel-before-deadline';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockIsBackstageProtectedQueuedExecution.mockReturnValue(true);
    mockDispatchModuleAction.mockRejectedValueOnce(Object.assign(
      new Error(privateAbort),
      { name: 'AbortError' }
    ));

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'private-aborted-booking-prompt',
        },
      },
      requestId: 'req-protected-provider-abort',
      traceId: 'trace-protected-provider-abort',
      runtimeExecutionMode: 'background',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'MODULE_ERROR',
        message: 'Protected Backstage generation failed.',
      },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-protected-provider-abort',
        error: 'Protected Backstage generation failed.',
      })
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateAbort);
    expect(logger.error).not.toHaveBeenCalledWith(
      'gpt.dispatch.timeout',
      expect.anything()
    );
  });

  it('does not persist a generic transcript for successful protected queued generation', async () => {
    const privatePrompt = 'private-protected-success-prompt-sentinel';
    const privateResult = 'private-protected-success-result-sentinel';
    mockIsBackstageProtectedQueuedExecution.mockReturnValue(true);
    mockDispatchModuleAction.mockResolvedValueOnce(privateResult);

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      requestId: 'req-protected-queued-booker-success',
      traceId: 'trace-protected-queued-booker-success',
      runtimeExecutionMode: 'background',
    });

    expect(envelope).toMatchObject({ ok: true, result: privateResult });
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    expect(mockSuppressPromptDebugTraceContent).toHaveBeenCalled();
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privatePrompt);
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privateResult);
  });

  it('rejects background generation without a protected or legacy worker context', async () => {
    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Book the next Raw card.',
        },
      },
      requestId: 'req-unprotected-background-booker',
      runtimeExecutionMode: 'background',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'BACKSTAGE_ASYNC_PROTECTED_JOB_REQUIRED' },
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('redacts prompt traces and failures for legacy queued generation', async () => {
    const privatePrompt = 'private-legacy-queue-prompt-sentinel';
    const privateFailure = 'private-legacy-queue-failure-sentinel';
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockIsBackstageLegacyQueuedExecution.mockReturnValue(true);
    mockDispatchModuleAction.mockRejectedValueOnce(new Error(privateFailure));

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      requestId: 'req-legacy-queued-booker-failure',
      runtimeExecutionMode: 'background',
      logger,
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'MODULE_ERROR',
        message: 'Legacy Backstage generation failed during compatibility drain.',
      },
    });
    expect(mockSuppressPromptDebugTraceContent).toHaveBeenCalled();
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privatePrompt);
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privateFailure);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privatePrompt);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateFailure);
    expect(logger.error).toHaveBeenCalledWith(
      'gpt.dispatch.error',
      expect.objectContaining({
        requestId: 'req-legacy-queued-booker-failure',
        error: 'Legacy Backstage generation failed during compatibility drain.',
      })
    );
  });

  it('keeps successful legacy queued generation out of generic transcript persistence', async () => {
    const privatePrompt = 'private-legacy-success-prompt-sentinel';
    const privateResult = 'private-legacy-success-result-sentinel';
    mockIsBackstageLegacyQueuedExecution.mockReturnValue(true);
    mockDispatchModuleAction.mockResolvedValueOnce(privateResult);

    const envelope = await routeGptRequest({
      gptId: 'backstage-booker',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      requestId: 'req-legacy-queued-booker-success',
      runtimeExecutionMode: 'background',
    });

    expect(envelope).toMatchObject({ ok: true, result: privateResult });
    expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    expect(mockSuppressPromptDebugTraceContent).toHaveBeenCalled();
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privatePrompt);
    expect(JSON.stringify(mockRecordPromptDebugTrace.mock.calls)).not.toContain(privateResult);
  });

  it.each(['backstage', 'backstage-booker'])(
    'maps transactional roster failures for canonical alias %s to a retryable persistence code',
    async (gptId) => {
      mockDispatchModuleAction.mockRejectedValueOnce(
        new BackstageRosterPersistenceError({ retryable: true })
      );

      const envelope = await routeGptRequest({
        gptId,
        body: {
          action: 'updateRoster',
          payload: [{ name: 'Rhea Ripley', overall: 96 }],
        },
        requestId: `req-${gptId}-roster-persistence-failure`,
      });

      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
          message: 'Roster update persistence could not be confirmed.',
          details: { retryable: true },
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'updateRoster',
        },
      });
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
    }
  );

  it.each(['backstage', 'backstage-booker'])(
    'maps non-transient storyline persistence failures for canonical alias %s without persistence side effects',
    async (gptId) => {
      mockDispatchModuleAction.mockRejectedValueOnce(
        new BackstageStorylinePersistenceError(
          new Error('sensitive database invariant detail')
        )
      );

      const envelope = await routeGptRequest({
        gptId,
        body: {
          action: 'trackStoryline',
          payload: { sequence: 25, summary: 'Close the rivalry chapter.' },
        },
        requestId: `req-${gptId}-storyline-persistence-failure`,
      });

      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
          message: BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_MESSAGE,
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'trackStoryline',
        },
      });
      expect(JSON.stringify(envelope)).not.toContain(
        BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
      );
      expect(JSON.stringify(envelope)).not.toContain('sensitive database invariant detail');
      expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
      expect(mockPersistModuleConversation).not.toHaveBeenCalled();
      expect(mockExecuteNaturalLanguageMemoryCommand).not.toHaveBeenCalled();
    }
  );

  it('does not remap a roster-shaped error from another Backstage action', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageRosterValidationError('Roster payload must be an array.')
    );

    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: {
        action: 'trackStoryline',
        payload: {},
      },
      requestId: 'req-backstage-non-roster-error',
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'MODULE_ERROR',
        message: 'Roster payload must be an array.',
      },
      _route: {
        module: 'BACKSTAGE:BOOKER',
        action: 'trackStoryline',
      },
    });
  });

  it("surfaces NO_DEFAULT_ACTION for legacy 'ask' actions when the module has no canonical query action", async () => {
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
          code: 'NO_DEFAULT_ACTION',
          message: "Requested action 'ask' is not available for module BACKSTAGE:BOOKER",
          details: expect.objectContaining({
            requestedAction: 'ask',
          }),
        }),
        _route: expect.objectContaining({
          module: 'BACKSTAGE:BOOKER',
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
