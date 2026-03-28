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
  __esModule: true,
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

jest.unstable_mockModule('../src/shared/typeGuards.js', () => ({
  isRecord(value: unknown) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');

function buildValidation(map: Record<string, unknown>) {
  const registeredIds = Object.keys(map);
  const missingRequiredGpts = ['arcanos-core', 'core'].filter((id) => !registeredIds.includes(id));
  return {
    requiredGptIds: ['arcanos-core', 'core'],
    missingGptIds: missingRequiredGpts,
    registeredGptIds: registeredIds,
    registeredGptCount: registeredIds.length
  };
}

describe('routeGptRequest registry recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetModuleMetadata.mockReturnValue({
      name: 'ARCANOS:CORE',
      actions: ['query'],
      route: 'core',
      defaultAction: 'query',
    });
    mockDispatchModuleAction.mockResolvedValue({ result: 'ok' });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockShouldInspectRepoPrompt.mockReturnValue(false);
    mockBuildRepoInspectionAnswer.mockReturnValue('repo-answer');
    mockCollectRepoImplementationEvidence.mockResolvedValue({
      status: 'implemented',
      checks: [],
      evidence: {}
    });
    mockValidateGptRegistry.mockImplementation(buildValidation);
  });

  it('rebuilds the GPT registry once and continues when arcanos-core can be recovered', async () => {
    mockGetGptModuleMap.mockResolvedValue({});
    mockRebuildGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
      core: { route: 'core', module: 'ARCANOS:CORE' }
    });

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: { prompt: 'Recover the registry.' },
      requestId: 'req-registry-1',
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    expect(mockRebuildGptModuleMap).toHaveBeenCalledTimes(1);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'ARCANOS:CORE',
      'query',
      expect.objectContaining({ prompt: 'Recover the registry.' })
    );
    expect(envelope.ok).toBe(true);
  });

  it('returns a recovery hint when the registry is still missing the requested GPT after rebuild', async () => {
    mockGetGptModuleMap.mockResolvedValue({});
    mockRebuildGptModuleMap.mockResolvedValue({});

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: { prompt: 'Recover the registry.' },
      requestId: 'req-registry-2',
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    expect(envelope.ok).toBe(false);
    if (envelope.ok) {
      throw new Error('Expected unknown GPT error');
    }
    expect(envelope.error.code).toBe('UNKNOWN_GPT');
    expect(envelope.error.details).toEqual(expect.objectContaining({
      recoveryAttempted: true,
      requiredGptIds: ['arcanos-core', 'core'],
      missingRequiredGpts: ['arcanos-core', 'core'],
    }));
    expect(String((envelope.error.details as Record<string, unknown>).recoveryHint)).toContain('Registry rehydration ran');
  });
});
