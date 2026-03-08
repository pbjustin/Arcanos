import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockTryExecuteNaturalLanguageMemoryRouteShortcut = jest.fn();
const mockTryExecuteBackstageBookerRouteShortcut = jest.fn();

jest.unstable_mockModule('@services/naturalLanguageMemoryRouteShortcut.js', () => ({
  tryExecuteNaturalLanguageMemoryRouteShortcut: mockTryExecuteNaturalLanguageMemoryRouteShortcut
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  tryExecuteBackstageBookerRouteShortcut: mockTryExecuteBackstageBookerRouteShortcut
}));

const { tryExecutePromptRouteShortcut } = await import('../src/services/promptRouteShortcuts.js');

describe('promptRouteShortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTryExecuteNaturalLanguageMemoryRouteShortcut.mockResolvedValue(null);
    mockTryExecuteBackstageBookerRouteShortcut.mockResolvedValue(null);
  });

  it('returns the normalized memory shortcut result before later shortcuts', async () => {
    mockTryExecuteNaturalLanguageMemoryRouteShortcut.mockResolvedValue({
      resultText: 'Persisted memory text',
      memory: {
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId: 'raw_memory_session',
        message: 'Loaded latest saved memory.'
      }
    });

    const shortcut = await tryExecutePromptRouteShortcut({
      prompt: 'Recall: raw_memory_session',
      sessionId: 'raw_memory_session'
    });

    expect(shortcut).toEqual({
      shortcutId: 'memory',
      resultText: 'Persisted memory text',
      response: {
        requestIdPrefix: 'memory',
        module: 'memory-dispatcher',
        activeModel: 'memory-dispatcher',
        routingStage: 'MEMORY-DISPATCH',
        auditFlag: 'MEMORY_SHORTCUT_ACTIVE',
        sessionId: 'raw_memory_session',
        contextSummary: 'Memory dispatcher retrieved for session raw_memory_session.'
      },
      dispatcher: {
        module: 'memory-dispatcher',
        action: 'retrieved',
        reason: 'retrieve'
      }
    });
    expect(mockTryExecuteBackstageBookerRouteShortcut).not.toHaveBeenCalled();
  });

  it('returns the normalized backstage-booker shortcut when memory does not match', async () => {
    mockTryExecuteBackstageBookerRouteShortcut.mockResolvedValue({
      resultText: 'Backstage rivalry output',
      dispatcher: {
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        reason: 'booking_verb+storyline_request+wrestling_brand'
      }
    });

    const shortcut = await tryExecutePromptRouteShortcut({
      prompt: 'Generate three rivalries for RAW after WrestleMania.',
      sessionId: 'RAW_RIVALRY_TEST'
    });

    expect(shortcut).toEqual({
      shortcutId: 'backstage-booker',
      resultText: 'Backstage rivalry output',
      response: {
        requestIdPrefix: 'booker',
        module: 'BACKSTAGE:BOOKER',
        activeModel: 'backstage-booker',
        routingStage: 'BACKSTAGE-BOOKER-DISPATCH',
        auditFlag: 'BACKSTAGE_BOOKER_SHORTCUT_ACTIVE',
        sessionId: 'RAW_RIVALRY_TEST',
        contextSummary: 'Backstage Booker generated a booking response for session RAW_RIVALRY_TEST. Trigger: booking_verb+storyline_request+wrestling_brand.'
      },
      dispatcher: {
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        reason: 'booking_verb+storyline_request+wrestling_brand'
      }
    });
  });
});
