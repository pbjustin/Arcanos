import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
  BackstageRosterPersistenceError,
  BackstageRosterValidationError,
} from '../src/shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BackstageCanonUnavailableError,
} from '../src/services/backstageBookerContracts.js';

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

jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({
  executeQueuedGamingSourceIngestion: jest.fn(),
  GAMING_SOURCE_INGESTION_GPT_ID: 'arcanos-gaming',
  GAMING_SOURCE_INGESTION_REASON: 'gaming_source_ingestion',
  GAMING_SOURCE_INGESTION_REQUEST_PATH: '/gpt-access/gaming/sources/ingestions',
  GAMING_SOURCE_REFRESH_REQUEST_PATH: '/gpt-access/gaming/sources/refreshes',
  parseQueuedGamingSourceIngestionBody: jest.fn(),
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
      actions: ['updateRoster', 'trackStoryline', 'upsertStoryline', 'appendCanonBeat'],
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

  it('fails an admitted invalid roster non-retryably after module validation', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageRosterValidationError('Roster payload must be an array.')
    );

    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-invalid-roster',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'updateRoster',
          payload: { name: 'not-an-array', overall: 90 },
        },
        requestId: 'req-backstage-invalid-roster',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'updateRoster',
          principalId: 'operator:normal-worker-test',
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: `${BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE}: Roster payload must be an array.`,
      output: {
        ok: false,
        error: {
          code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
          message: 'Roster payload must be an array.',
        },
      },
    });
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'BACKSTAGE:BOOKER',
      'updateRoster',
      expect.objectContaining({ name: 'not-an-array', overall: 90 })
    );
  });

  it('fails an admitted roster transaction retryably without reporting completion', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageRosterPersistenceError({ retryable: true })
    );

    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-roster-persistence',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'updateRoster',
          payload: [{ name: 'Rhea Ripley', overall: 96 }],
        },
        requestId: 'req-backstage-roster-persistence',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'updateRoster',
          principalId: 'operator:normal-worker-test',
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: true,
      errorMessage:
        `${BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE}: Roster update persistence could not be confirmed.`,
      output: {
        ok: false,
        error: {
          code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
          message: 'Roster update persistence could not be confirmed.',
          details: { retryable: true },
        },
      },
    });
  });

  it('does not retry a deterministic admitted roster persistence failure', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageRosterPersistenceError({ retryable: false })
    );

    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-roster-permanent-persistence',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'updateRoster',
          payload: [{ name: 'Rhea Ripley', overall: 96 }],
        },
        requestId: 'req-backstage-roster-permanent-persistence',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'updateRoster',
          principalId: 'operator:normal-worker-test',
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      output: {
        error: {
          code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
          details: { retryable: false },
        },
      },
    });
  });

  it.each(['upsertStoryline', 'appendCanonBeat'] as const)(
    'keeps an admitted %s commit-unknown receipt completed but non-reusable',
    async (action) => {
      const mutationId = '8d64dad3-f080-4bac-88ec-994005dc7152';
      const result = {
        universeId: 'phase-two',
        mutationId,
        applied: null,
        universeRevision: null,
        storyline: null,
        ...(action === 'appendCanonBeat' ? { beat: null } : {}),
        persistence: {
          status: 'unknown',
          durable: null,
          backend: 'postgresql',
          degraded: true,
          reason: 'commit_outcome_unknown',
        },
      };
      mockDispatchModuleAction.mockResolvedValueOnce(result);
      const payload = action === 'upsertStoryline'
        ? {
            universeId: 'phase-two',
            mutationId,
            expectedVersion: 0,
            storyline: {
              key: 'summer-feud',
              title: 'Summer Feud',
              summary: null,
              status: 'draft',
              participantNames: [],
            },
          }
        : {
            universeId: 'phase-two',
            mutationId,
            storylineKey: 'summer-feud',
            expectedVersion: 1,
            beat: {
              kind: 'angle',
              summary: 'A confrontation escalates the feud.',
              occurredAt: '2026-08-14T00:00:00.000Z',
              participantNames: [],
            },
          };

      const outcome = await executeQueuedGptRequest({
        jobId: `job-backstage-${action}-commit-unknown`,
        rawInput: {
          gptId: 'backstage',
          body: { action, payload },
          requestId: `req-backstage-${action}-commit-unknown`,
          backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
            action,
            principalId: 'operator:normal-worker-test',
          }),
        },
      });

      expect(outcome).toMatchObject({
        status: 'completed',
        output: {
          ok: true,
          result,
        },
        completionAutonomyState: {
          gptResultReuse: {
            reusable: false,
            reason: 'backstage_canon_commit_outcome_unknown',
          },
        },
      });
    }
  );

  it('retries a classified canon outage with the admitted mutation payload intact', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageCanonUnavailableError('upsertStoryline')
    );
    const payload = {
      universeId: 'phase-two',
      mutationId: '8d64dad3-f080-4bac-88ec-994005dc7152',
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'draft',
        participantNames: [],
      },
    };

    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-canon-unavailable',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'upsertStoryline',
          payload,
        },
        requestId: 'req-backstage-canon-unavailable',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'upsertStoryline',
          principalId: 'operator:normal-worker-test',
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: true,
      errorMessage:
        `${BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE}: Backstage canon persistence is temporarily unavailable.`,
      output: {
        ok: false,
        error: {
          code: BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
          details: { retryable: true },
        },
      },
    });
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'BACKSTAGE:BOOKER',
      'upsertStoryline',
      expect.objectContaining(payload)
    );
  });
});
