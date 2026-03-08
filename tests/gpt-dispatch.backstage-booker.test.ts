import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockPersistModuleConversation = jest.fn();
const mockExecuteNaturalLanguageMemoryCommand = jest.fn();
const mockParseNaturalLanguageMemoryCommand = jest.fn();
const mockExtractNaturalLanguageSessionId = jest.fn();
const mockExtractNaturalLanguageStorageLabel = jest.fn();
const mockHasNaturalLanguageMemoryCue = jest.fn();
const mockDetectBackstageBookerIntent = jest.fn();

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
  extractNaturalLanguageStorageLabel: mockExtractNaturalLanguageStorageLabel,
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
      tutor: { route: 'tutor', module: 'ARCANOS:TUTOR' },
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' }
    });
    mockGetModuleMetadata.mockImplementation((moduleName: string) => {
      if (moduleName === 'BACKSTAGE:BOOKER') {
        return {
          name: 'BACKSTAGE:BOOKER',
          actions: ['bookEvent', 'updateRoster', 'trackStoryline', 'simulateMatch', 'generateBooking', 'generateBookingWithHRC', 'saveStoryline'],
          route: 'backstage'
        };
      }

      return {
        name: 'ARCANOS:TUTOR',
        actions: ['query'],
        route: 'tutor'
      };
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockDetectBackstageBookerIntent.mockReturnValue({
      score: 6,
      reason: 'booking_verb+storyline_request+wrestling_brand'
    });
    mockDispatchModuleAction.mockResolvedValue('Generated rivalry matrix');
  });

  it('reroutes tutor booking prompts to BACKSTAGE:BOOKER generateBooking', async () => {
    const envelope = await routeGptRequest({
      gptId: 'tutor',
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
});
