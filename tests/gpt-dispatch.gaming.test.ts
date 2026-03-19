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
const mockBuildRepoInspectionAnswer = jest.fn();
const mockCollectRepoImplementationEvidence = jest.fn();
const mockShouldInspectRepoPrompt = jest.fn();

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
    mockGetModuleMetadata.mockImplementation((moduleName: string) => {
      if (moduleName === 'ARCANOS:GAMING') {
        return {
          name: 'ARCANOS:GAMING',
          actions: ['query'],
          route: 'gaming',
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
      gaming_response: 'Gaming pipeline response',
    });
  });

  it('dispatches exact arcanos-gaming requests to the gaming module even when the prompt mentions repo tooling', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
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

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', {
      prompt: 'Ping the gaming backend and inspect whether repo tools exist before SWTOR tips ingestion.',
      schema: 'gaming',
      target: 'gaming_guides',
      game: 'SWTOR',
    });
    expect(mockCollectRepoImplementationEvidence).not.toHaveBeenCalled();
    expect(envelope).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          gaming_response: 'Gaming pipeline response',
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
          prompt: 'Inspect the repo tools before answering my SWTOR guide question.',
        },
      },
      requestId: 'req-gaming-override-1',
    });

    expect(mockDispatchModuleAction).toHaveBeenCalledWith('ARCANOS:GAMING', 'query', {
      prompt: 'Inspect the repo tools before answering my SWTOR guide question.',
    });
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

  it('fails validation when arcanos-gaming query payload has no prompt', async () => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-gaming',
      body: {
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
});
