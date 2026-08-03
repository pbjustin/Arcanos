import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetJobById = jest.fn(async (_jobId: string) => null);
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

class MockJobRepositoryUnavailableError extends Error {}

const signalListenersBeforeImport = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
};

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createClaimedJobFence: jest.fn(),
  getJobById: mockGetJobById,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  updateClaimedJobTerminal: jest.fn(),
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getStatus: jest.fn(),
  initializeDatabaseWithSchema: jest.fn(),
}));

jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({
  postgresQueueSchedulerAdapter: {},
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  WorkerAutonomyService: class {},
  classifyWorkerExecutionError: jest.fn(),
  getWorkerAutonomySettings: jest.fn(),
}));

jest.unstable_mockModule('../src/workers/taskRunners.js', () => ({
  runDagNodeJob: jest.fn(),
}));

jest.unstable_mockModule('../src/workers/trinityWorkerPipeline.js', () => ({
  runWorkerTrinityPrompt: jest.fn(),
}));

jest.unstable_mockModule('@services/trinity/adapter.js', () => ({
  isTrinityDagGptAccessEnabled: jest.fn(() => false),
  routeDagNodeToGptAccess: jest.fn(),
}));

jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn(),
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

const { executeQueuedGptRequest } = await import('../src/workers/jobRunner.js');
const { buildQueuedGptBackstageMutationAdmission } = await import(
  '../src/shared/gpt/asyncGptJob.js'
);

const introducedSignalListeners = {
  SIGINT: process
    .listeners('SIGINT')
    .filter(listener => !signalListenersBeforeImport.SIGINT.includes(listener)),
  SIGTERM: process
    .listeners('SIGTERM')
    .filter(listener => !signalListenersBeforeImport.SIGTERM.includes(listener)),
};

afterAll(() => {
  for (const listener of introducedSignalListeners.SIGINT) {
    process.removeListener('SIGINT', listener);
  }
  for (const listener of introducedSignalListeners.SIGTERM) {
    process.removeListener('SIGTERM', listener);
  }
});

describe('normal worker queued Backstage mutation admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJobById.mockResolvedValue(null);
    mockGetGptModuleMap.mockResolvedValue({
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: [],
      missingGptIds: [],
      registeredGptIds: ['backstage'],
      registeredGptCount: 1,
    });
    mockGetModuleMetadata.mockReturnValue({
      name: 'BACKSTAGE:BOOKER',
      actions: ['updateRoster', 'trackStoryline'],
      route: 'backstage',
      defaultAction: 'updateRoster',
      defaultTimeoutMs: 60_000,
    });
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockDetectBackstageBookerIntent.mockReturnValue(null);
  });

  it('fails a missing admission non-retryably before module execution', async () => {
    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-unattested',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'updateRoster',
          payload: [],
        },
        requestId: 'req-backstage-unattested',
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: expect.stringContaining('BACKSTAGE_MUTATION_ADMISSION_REQUIRED'),
      output: {
        ok: false,
        error: {
          code: 'BACKSTAGE_MUTATION_ADMISSION_REQUIRED',
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'updateRoster',
        },
      },
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('fails a mismatched admission non-retryably before module execution', async () => {
    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-drifted',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'trackStoryline',
          payload: {},
        },
        requestId: 'req-backstage-drifted',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'updateRoster',
          principalId: 'operator:normal-worker-test',
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: expect.stringContaining('BACKSTAGE_MUTATION_ADMISSION_MISMATCH'),
      output: {
        ok: false,
        error: {
          code: 'BACKSTAGE_MUTATION_ADMISSION_MISMATCH',
        },
        _route: {
          module: 'BACKSTAGE:BOOKER',
          action: 'trackStoryline',
        },
      },
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
