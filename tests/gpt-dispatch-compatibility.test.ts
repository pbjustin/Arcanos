import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockDispatchModuleAction = jest.fn();

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordDependencyCall: jest.fn(),
  recordDagTraceTimeout: jest.fn(),
  recordDispatcherFallback: jest.fn(),
  recordDispatcherMisroute: jest.fn(),
  recordDispatcherRoute: jest.fn(),
  recordMcpAutoInvoke: jest.fn(),
  recordMemoryDispatchIgnored: jest.fn(),
  recordUnknownGpt: jest.fn(),
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
  rebuildGptModuleMap: jest.fn(),
  validateGptRegistry: jest.fn(() => ({ requiredGptIds: ['arcanos-core'] })),
}));

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  getModuleMetadata: mockGetModuleMetadata,
  dispatchModuleAction: mockDispatchModuleAction
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');

describe('gpt dispatch compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGptModuleMap.mockResolvedValue({
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
});
