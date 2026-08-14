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
  BackstageCanonDomainError,
} from '../src/core/db/repositories/backstageBookerRepository.js';
import {
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BackstageBookerContractError,
  BackstageCanonUnavailableError,
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
const { normalizeBackstageBookerActionPayload } = await import(
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
          actions: ['bookEvent', 'updateRoster', 'trackStoryline', 'simulateMatch', 'generateBooking', 'generateBookingWithHRC', 'saveStoryline', 'upsertStoryline', 'appendCanonBeat'],
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
