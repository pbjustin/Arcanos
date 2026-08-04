import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockRebuildGptModuleMap = jest.fn();
const mockValidateGptRegistry = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockExecuteNaturalLanguageMemoryCommand = jest.fn();
const mockParseNaturalLanguageMemoryCommand = jest.fn();
const mockExtractNaturalLanguageSessionId = jest.fn();
const mockExtractNaturalLanguageStorageLabel = jest.fn();
const mockHasNaturalLanguageMemoryCue = jest.fn();
const mockLoadMemory = jest.fn();
const mockSaveMemory = jest.fn();
const mockSaveMessage = jest.fn();
const mockQuery = jest.fn();

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
  getGptModuleMap: mockGetGptModuleMap,
  rebuildGptModuleMap: mockRebuildGptModuleMap,
  validateGptRegistry: mockValidateGptRegistry,
}));

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  dispatchModuleAction: mockDispatchModuleAction,
  getModuleMetadata: mockGetModuleMetadata,
  initializeModuleRegistry: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('@services/naturalLanguageMemory.js', () => ({
  executeNaturalLanguageMemoryCommand: mockExecuteNaturalLanguageMemoryCommand,
  parseNaturalLanguageMemoryCommand: mockParseNaturalLanguageMemoryCommand,
  extractNaturalLanguageSessionId: mockExtractNaturalLanguageSessionId,
  extractNaturalLanguageStorageLabel: mockExtractNaturalLanguageStorageLabel,
  hasNaturalLanguageMemoryCue: mockHasNaturalLanguageMemoryCue,
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES: Object.freeze({}),
  applyBackstageRosterMutation: jest.fn(),
  loadMemory: mockLoadMemory,
  query: mockQuery,
  saveMemory: mockSaveMemory,
  transaction: jest.fn(),
}));

jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
  saveMessage: mockSaveMessage,
}));

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: jest.fn(),
  collectRepoImplementationEvidence: jest.fn(),
  shouldInspectRepoPrompt: jest.fn(() => false),
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');

describe('GPT memory interception conversation persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: ['arcanos-core'],
      missingGptIds: [],
      registeredGptIds: ['arcanos-core'],
      registeredGptCount: 1,
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:CORE',
      actions: ['query', 'system_state'],
      route: 'core',
      defaultAction: 'query',
    });
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'recall' });
    mockHasNaturalLanguageMemoryCue.mockReturnValue(true);
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      success: true,
      intent: 'recall',
      operation: 'recalled',
      message: 'Found the release marker.',
      data: [{ key: 'release-marker', value: 'ready' }],
    });
    mockLoadMemory.mockReset().mockResolvedValue(null);
    mockSaveMemory.mockReset().mockResolvedValue(undefined);
    mockSaveMessage.mockReset().mockResolvedValue(undefined);
  });

  it('persists an authorized recall under the explicit session scope', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'Recall the release marker from memory.',
        sessionId: 'memory-session-123',
      },
      requestId: 'req-memory-persistence-1',
      memoryPlaneAuthorized: true,
    });

    expect(envelope).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        handledBy: 'memory-dispatcher',
        memory: expect.objectContaining({
          operation: 'recalled',
        }),
      }),
    }));
    expect(mockExecuteNaturalLanguageMemoryCommand).toHaveBeenCalledWith({
      input: 'Recall the release marker from memory.',
      sessionId: 'memory-session-123',
    });
    expect(mockSaveMessage).toHaveBeenCalledTimes(2);
    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      1,
      'memory-session-123',
      'conversations_core',
      expect.objectContaining({
        role: 'user',
        module: 'ARCANOS:CORE',
        action: 'memory',
      })
    );
    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      2,
      'memory-session-123',
      'conversations_core',
      expect.objectContaining({
        role: 'assistant',
        module: 'ARCANOS:CORE',
        action: 'memory',
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'module-history:core',
      expect.objectContaining({
        sessionId: 'memory-session-123',
        entries: [
          expect.objectContaining({
            sessionId: 'memory-session-123',
            action: 'memory',
          }),
        ],
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'module-summary:core',
      expect.objectContaining({
        latestAction: 'memory',
        recent: [
          expect.objectContaining({
            sessionId: 'memory-session-123',
          }),
        ],
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'module-last-session:core',
      expect.objectContaining({
        sessionId: 'memory-session-123',
        moduleName: 'ARCANOS:CORE',
      })
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('keeps an authorized recall without explicit session scope write-free', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'Recall the release marker from memory.',
      },
      requestId: 'req-memory-persistence-2',
      memoryPlaneAuthorized: true,
    });

    expect(envelope).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        handledBy: 'memory-dispatcher',
      }),
    }));
    expect(mockExecuteNaturalLanguageMemoryCommand).toHaveBeenCalledWith({
      input: 'Recall the release marker from memory.',
      sessionId: undefined,
    });
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockLoadMemory).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('returns a successful recall when every persistence adapter is unavailable', async () => {
    mockLoadMemory.mockRejectedValue(new Error('memory read unavailable'));
    mockSaveMemory.mockRejectedValue(new Error('memory write unavailable'));
    mockSaveMessage.mockRejectedValue(new Error('session write unavailable'));

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'Recall the release marker from memory.',
        sessionId: 'memory-session-degraded',
      },
      requestId: 'req-memory-persistence-3',
      memoryPlaneAuthorized: true,
    });

    expect(envelope).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        handledBy: 'memory-dispatcher',
        memory: expect.objectContaining({
          operation: 'recalled',
        }),
      }),
    }));
    expect(mockExecuteNaturalLanguageMemoryCommand).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(2);
    expect(mockLoadMemory).toHaveBeenCalledTimes(2);
    expect(mockSaveMemory).toHaveBeenCalledTimes(3);
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
