import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
  BackstageRosterPersistenceError,
  BackstageRosterValidationError,
} from '../src/shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_CODE,
  BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE_ERROR_CODE,
  BackstageCanonUnavailableError,
  BackstageNotionAuthorityReadOnlyError,
  BackstageNotionAuthorityUnavailableError,
} from '../src/services/backstageBookerContracts.js';
import {
  BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
  BackstageNotionIndexUnavailableError,
} from '../src/services/backstageNotionRag.js';

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

const { executeQueuedGptRequest, startHeartbeatLoop } = await import(
  '../src/workers/jobRunner.js'
);
const { createAbortError, getRequestAbortSignal } = await import('@arcanos/runtime');
const {
  buildProtectedBackstageQueuedGptJobInput,
  buildQueuedGptBackstageMutationAdmission,
} = await import(
  '../src/shared/gpt/asyncGptJob.js'
);
const { unprotectBackstageQueuedGptJobOutput } = await import(
  '../src/shared/backstage/backstageQueuedJobResultProtection.js'
);
const {
  isBackstageNotionEnrichmentAuthorized,
  isBackstageProtectedQueuedExecution,
} = await import(
  '../src/services/backstageNotionEnrichmentAuthorization.js'
);

const originalBackstagePayloadKey =
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
const originalWorkerJobTimeout = process.env.BOOKER_WORKER_JOB_TIMEOUT_MS;

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
  if (originalBackstagePayloadKey === undefined) {
    delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  } else {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      originalBackstagePayloadKey;
  }
  if (originalWorkerJobTimeout === undefined) {
    delete process.env.BOOKER_WORKER_JOB_TIMEOUT_MS;
  } else {
    process.env.BOOKER_WORKER_JOB_TIMEOUT_MS = originalWorkerJobTimeout;
  }
});

describe('normal worker queued Backstage mutation admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDispatchModuleAction.mockReset();
    mockGetJobById.mockResolvedValue(null);
    mockGetGptModuleMap.mockResolvedValue({
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' },
      'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
    });
    mockRebuildGptModuleMap.mockResolvedValue({
      backstage: { route: 'backstage', module: 'BACKSTAGE:BOOKER' },
      'backstage-booker': { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
      'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' },
    });
    mockValidateGptRegistry.mockReturnValue({
      requiredGptIds: [],
      missingGptIds: [],
      registeredGptIds: ['backstage'],
      registeredGptCount: 1,
    });
    mockGetModuleMetadata.mockImplementation((moduleName: string) =>
      moduleName === 'ARCANOS:CORE'
        ? {
            name: 'ARCANOS:CORE',
            actions: ['query'],
            route: 'arcanos-core',
            defaultAction: 'query',
            defaultTimeoutMs: 60_000,
          }
        : {
            name: 'BACKSTAGE:BOOKER',
            actions: [
              'updateRoster',
              'trackStoryline',
              'upsertStoryline',
              'appendCanonBeat',
              'generateBooking',
              'generateBookingWithHRC',
              'queryContinuity',
            ],
            route: 'backstage',
            defaultAction: 'updateRoster',
            defaultTimeoutMs: 60_000,
          }
    );
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExtractNaturalLanguageSessionId.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockHasDagOrchestrationIntentCue.mockReturnValue(false);
    mockHasNaturalLanguageMemoryCue.mockReturnValue(false);
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({ operation: 'noop' });
    mockDetectBackstageBookerIntent.mockReturnValue(null);
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x61).toString('base64');
    delete process.env.BOOKER_WORKER_JOB_TIMEOUT_MS;
  });

  it('renews the real claimed-job heartbeat loop before each live lease expires', async () => {
    jest.useFakeTimers();
    const recordHeartbeat = jest.fn(async () => ({
      id: 'heartbeat-job',
      claim_generation: '7',
    }));
    const autonomyService = {
      getClaimOptions: () => ({ leaseMs: 15_000 }),
      recordHeartbeat,
    };
    const loop = startHeartbeatLoop(
      autonomyService as never,
      { id: 'heartbeat-job', claim_generation: '7' },
      'worker-heartbeat-test'
    );

    try {
      await jest.advanceTimersByTimeAsync(140_001);
      expect(recordHeartbeat).toHaveBeenCalledTimes(28);
      for (const call of recordHeartbeat.mock.calls) {
        expect(call[0]).toEqual({
          id: 'heartbeat-job',
          claim_generation: '7',
        });
        expect(call[1]).toMatchObject({
          source: 'job-heartbeat',
          shouldApplyResult: expect.any(Function),
        });
      }

      loop.stop();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(recordHeartbeat).toHaveBeenCalledTimes(28);
    } finally {
      loop.stop();
      jest.useRealTimers();
    }
  });

  it('decrypts protected generation only in the worker authorization context and seals the retrievable result', async () => {
    const privatePrompt = 'private-worker-booking-prompt-sentinel';
    const privateResult = 'private-worker-booking-result-sentinel';
    let authorizedInsideDispatch = false;
    let protectedQueueInsideDispatch = false;
    mockDispatchModuleAction.mockImplementationOnce(async () => {
      authorizedInsideDispatch = isBackstageNotionEnrichmentAuthorized();
      protectedQueueInsideDispatch = isBackstageProtectedQueuedExecution();
      return privateResult;
    });
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      prompt: privatePrompt,
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-booker',
      traceId: 'trace-worker-booker',
      correlationId: 'trace-worker-booker',
      executionModeReason: 'backstage_notion_authority_context',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '11111111-1111-4111-8111-111111111111',
      rawInput,
    });

    expect(outcome.status).toBe('completed');
    expect(authorizedInsideDispatch).toBe(true);
    expect(protectedQueueInsideDispatch).toBe(true);
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
    expect(isBackstageProtectedQueuedExecution()).toBe(false);
    expect(JSON.stringify(rawInput)).not.toContain(privatePrompt);
    expect(JSON.stringify(outcome.output)).not.toContain(privateResult);
    expect(unprotectBackstageQueuedGptJobOutput({
      jobId: '11111111-1111-4111-8111-111111111111',
      rawInput,
      output: outcome.output,
    })).toMatchObject({
      ok: true,
      result: privateResult,
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        traceId: 'trace-worker-booker',
      },
    });
    expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
  });

  it('aborts through the heartbeat error callback before the active lease can expire', async () => {
    jest.useFakeTimers();
    const renewalFailure = new Error('heartbeat renewal unavailable');
    const recordHeartbeat = jest.fn(async () => {
      throw renewalFailure;
    });
    const onHeartbeatError = jest.fn((error: unknown) => {
      expect(error).toBe(renewalFailure);
    });
    const autonomyService = {
      getClaimOptions: () => ({ leaseMs: 15_000 }),
      recordHeartbeat,
    };
    const loop = startHeartbeatLoop(
      autonomyService as never,
      { id: 'heartbeat-error-job', claim_generation: '8' },
      'worker-heartbeat-error-test',
      undefined,
      onHeartbeatError
    );

    try {
      await jest.advanceTimersByTimeAsync(5_001);
      expect(recordHeartbeat).toHaveBeenCalledTimes(1);
      expect(onHeartbeatError).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(recordHeartbeat).toHaveBeenCalledTimes(1);
      expect(onHeartbeatError).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
      jest.useRealTimers();
    }
  });

  it.each([
    ['direct generation', 'backstage-booker', { action: 'generateBooking' }],
    [
      'nested HRC generation alias',
      'backstage-booker',
      { payload: { action: [null, ['', ['generateBookingWithHRC']]] } },
    ],
    ['default generation', 'backstage-booker', {}],
    ['legacy-route direct generation', 'backstage', { action: 'generateBooking' }],
    [
      'legacy-route nested HRC generation alias',
      'backstage',
      { payload: { action: [null, ['', ['generateBookingWithHRC']]] } },
    ],
    ['legacy-route default generation', 'backstage', {}],
  ])('rejects legacy plaintext %s before worker dispatch', async (_label, gptId, body) => {
    const privatePrompt = 'private-legacy-worker-generation-sentinel';
    const outcome = await executeQueuedGptRequest({
      jobId: '77777777-7777-4777-8777-777777777777',
      rawInput: {
        gptId,
        body: {
          ...body,
          payload: {
            ...((body as { payload?: Record<string, unknown> }).payload ?? {}),
            universeId: 'my-universe-2k26',
            prompt: privatePrompt,
          },
        },
      },
    });

    expect(outcome).toEqual({
      status: 'failed',
      output: null,
      errorMessage: 'Protected Backstage generation job payload is required.',
      retryable: false,
    });
    expect(JSON.stringify(outcome)).not.toContain(privatePrompt);
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('rejects a configured Backstage GPT alias plaintext generation before dispatch', async () => {
    mockGetGptModuleMap.mockResolvedValueOnce({
      'booker-configured-alias': {
        route: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
      },
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '45454545-4545-4454-8454-454545454545',
      rawInput: {
        gptId: 'booker-configured-alias',
        body: {
          action: 'generateBooking',
          payload: {
            universeId: 'my-universe-2k26',
            prompt: 'private-configured-alias-booking-sentinel',
          },
        },
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'Protected Backstage generation job payload is required.',
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it.each([
    ['core query handoff', 'arcanos-core'],
    ['Backstage query upgrade', 'backstage-booker'],
  ])('rejects legacy plaintext automatic Booker generation from %s', async (_label, gptId) => {
    mockDetectBackstageBookerIntent.mockReturnValueOnce({
      score: 6,
      reason: 'booking_verb+wrestling_brand',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '46464646-4646-4464-8464-464646464646',
      rawInput: {
        gptId,
        body: {
          action: 'query',
          prompt: 'Book six Raw matches for the next WWE show.',
        },
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'Protected Backstage generation job payload is required.',
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('preserves a non-booking queued core query', async () => {
    mockDispatchModuleAction.mockResolvedValueOnce('Core query result.');

    const outcome = await executeQueuedGptRequest({
      jobId: '47474747-4747-4474-8474-474747474747',
      rawInput: {
        gptId: 'arcanos-core',
        body: {
          action: 'query',
          prompt: 'Explain deterministic finite automata.',
        },
      },
    });

    expect(outcome.status).toBe('completed');
    expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit queued CORE intent routing despite booking language', async () => {
    mockDetectBackstageBookerIntent.mockReturnValueOnce({
      score: 6,
      reason: 'booking_verb+wrestling_brand',
    });
    mockDispatchModuleAction.mockResolvedValueOnce('Core query result.');

    const outcome = await executeQueuedGptRequest({
      jobId: '48484848-4848-4484-8484-484848484848',
      rawInput: {
        gptId: 'arcanos-core',
        body: {
          action: 'query',
          prompt: 'Book six Raw matches as a hypothetical classification example.',
        },
        bypassIntentRouting: true,
      },
    });

    expect(outcome.status).toBe('completed');
    expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['array query', { action: [null, ['', ['query']]] }],
    ['payload operation query', { payload: { operation: 'query' } }],
  ] as const)(
    'canonicalizes a queued CORE %s alias before admission and dispatch',
    async (_caseName, actionFields) => {
      mockDetectBackstageBookerIntent.mockReturnValueOnce({
        score: 6,
        reason: 'booking_verb+wrestling_brand',
      });
      mockDispatchModuleAction.mockResolvedValueOnce('Core query result.');

      const outcome = await executeQueuedGptRequest({
        jobId: '49494949-4949-4494-8494-494949494949',
        rawInput: {
          gptId: 'arcanos-core',
          body: {
            ...actionFields,
            prompt: 'Book six Raw matches as a hypothetical classification example.',
          },
          bypassIntentRouting: true,
        },
      });

      expect(outcome.status).toBe('completed');
      expect(mockDispatchModuleAction).toHaveBeenCalledWith(
        'ARCANOS:CORE',
        'query',
        expect.anything(),
      );
    }
  );

  it.each(['ask', 'chat'] as const)(
    'rejects a queued CORE %s alias that would auto-route to plaintext Booker generation',
    async (action) => {
      mockDetectBackstageBookerIntent.mockReturnValueOnce({
        score: 6,
        reason: 'booking_verb+wrestling_brand',
      });

      const outcome = await executeQueuedGptRequest({
        jobId: '50505050-5050-4050-8050-505050505050',
        rawInput: {
          gptId: 'arcanos-core',
          body: {
            action,
            prompt: 'Book six Raw matches for the next WWE show.',
          },
        },
      });

      expect(outcome).toMatchObject({
        status: 'failed',
        retryable: false,
        errorMessage: 'Protected Backstage generation job payload is required.',
      });
      expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    }
  );

  it('continues to execute a legacy plaintext non-generation Backstage action', async () => {
    mockDispatchModuleAction.mockResolvedValueOnce({ answer: 'continuity answer' });

    const outcome = await executeQueuedGptRequest({
      jobId: '66666666-6666-4666-8666-666666666666',
      rawInput: {
        gptId: 'backstage-booker',
        body: {
          action: 'queryContinuity',
          payload: {
            universeId: 'my-universe-2k26',
            query: 'Who is champion?',
          },
        },
      },
    });

    expect(outcome.status).toBe('completed');
    expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['array action', { action: [null, ['', ['queryContinuity']]] }],
    ['payload operation', { payload: { operation: 'queryContinuity' } }],
  ] as const)(
    'canonicalizes a legacy Backstage continuity %s before dispatch',
    async (_caseName, actionFields) => {
      mockDispatchModuleAction.mockResolvedValueOnce({ answer: 'continuity answer' });

      const outcome = await executeQueuedGptRequest({
        jobId: '51515151-5151-4151-8151-515151515151',
        rawInput: {
          gptId: 'backstage-booker',
          body: {
            ...actionFields,
            payload: {
              ...('payload' in actionFields ? actionFields.payload : {}),
              universeId: 'my-universe-2k26',
              query: 'Who is champion?',
            },
          },
        },
      });

      expect(outcome.status).toBe('completed');
      expect(mockDispatchModuleAction).toHaveBeenCalledWith(
        'BACKSTAGE:BOOKER',
        'queryContinuity',
        expect.anything(),
      );
    }
  );

  it('fails closed at dispatch when registry recovery reveals plaintext background generation', async () => {
    mockGetGptModuleMap
      .mockRejectedValueOnce(new Error('transient registry lookup failure'))
      .mockResolvedValueOnce({
        'booker-recovered-alias': {
          route: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
        },
      });

    const outcome = await executeQueuedGptRequest({
      jobId: '52525252-5252-4252-8252-525252525252',
      rawInput: {
        gptId: 'booker-recovered-alias',
        body: {
          action: 'generateBooking',
          prompt: 'private-recovered-alias-generation-sentinel',
        },
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'BACKSTAGE_ASYNC_PROTECTED_JOB_REQUIRED: Background Backstage generation requires a protected queued execution context.',
      output: {
        ok: false,
        error: { code: 'BACKSTAGE_ASYNC_PROTECTED_JOB_REQUIRED' },
      },
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('fails a malformed protected marker without plaintext fallback or dispatch', async () => {
    const outcome = await executeQueuedGptRequest({
      jobId: '55555555-5555-4555-8555-555555555555',
      rawInput: {
        gptId: 'backstage-booker',
        protectedBackstage: {
          version: 99,
          ciphertext: 'private-malformed-ciphertext-sentinel',
        },
        body: {
          action: 'generateBooking',
          payload: { prompt: 'private-malformed-plaintext-sentinel' },
        },
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      output: null,
      errorMessage: 'Invalid GPT job.input: Protected Backstage job payload is invalid.',
    });
    expect(JSON.stringify(outcome)).not.toContain('private-malformed-ciphertext-sentinel');
    expect(JSON.stringify(outcome)).not.toContain('private-malformed-plaintext-sentinel');
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('keeps protected execution and result sealing when Notion enrichment was not authorized', async () => {
    const privatePrompt = 'private-worker-no-notion-prompt-sentinel';
    const privateResult = 'private-worker-no-notion-result-sentinel';
    let authorizedInsideDispatch = true;
    let protectedQueueInsideDispatch = false;
    mockDispatchModuleAction.mockImplementationOnce(async () => {
      authorizedInsideDispatch = isBackstageNotionEnrichmentAuthorized();
      protectedQueueInsideDispatch = isBackstageProtectedQueuedExecution();
      return privateResult;
    });
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      prompt: privatePrompt,
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: false,
      requestId: 'request-worker-no-notion',
      traceId: 'trace-worker-no-notion',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '88888888-8888-4888-8888-888888888888',
      rawInput,
    });

    expect(outcome.status).toBe('completed');
    expect(authorizedInsideDispatch).toBe(false);
    expect(protectedQueueInsideDispatch).toBe(true);
    expect(JSON.stringify(rawInput)).not.toContain(privatePrompt);
    expect(JSON.stringify(outcome.output)).not.toContain(privateResult);
    expect(unprotectBackstageQueuedGptJobOutput({
      jobId: '88888888-8888-4888-8888-888888888888',
      rawInput,
      output: outcome.output,
    })).toMatchObject({ ok: true, result: privateResult });
  });

  it('propagates the protected HRC action through worker dispatch metadata', async () => {
    mockDispatchModuleAction.mockResolvedValueOnce({
      storyline: 'Protected HRC result.',
      headcanon: { score: 88 },
    });
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBookingWithHRC',
      body: {
        action: 'generateBookingWithHRC',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Generate and evaluate a complete Raw card.',
        },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-hrc',
      traceId: 'trace-worker-hrc',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '99999999-9999-4999-8999-999999999999',
      rawInput,
    });

    expect(outcome.status).toBe('completed');
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'BACKSTAGE:BOOKER',
      'generateBookingWithHRC',
      expect.objectContaining({
        __arcanosRequestedAction: 'generateBookingWithHRC',
        prompt: 'Generate and evaluate a complete Raw card.',
      })
    );
  });

  it('persists protected worker failure as one stable terminal encrypted error', async () => {
    const privateFailure = 'private-provider-failure-sentinel';
    mockDispatchModuleAction.mockRejectedValueOnce(new Error(privateFailure));
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches.',
        },
      },
      prompt: 'Return exactly six matches.',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-failure',
      traceId: 'trace-worker-failure',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '22222222-2222-4222-8222-222222222222',
      rawInput,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'MODULE_ERROR: Protected Backstage generation failed.',
    });
    expect(JSON.stringify(outcome)).not.toContain(privateFailure);
    expect(unprotectBackstageQueuedGptJobOutput({
      jobId: '22222222-2222-4222-8222-222222222222',
      rawInput,
      output: outcome.output,
    })).toMatchObject({
      ok: false,
      error: { code: 'MODULE_ERROR' },
    });
    expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled provider at the finite worker deadline and returns a terminal error', async () => {
    jest.useFakeTimers();
    process.env.BOOKER_WORKER_JOB_TIMEOUT_MS = '120000';
    let activeProviderSignal: AbortSignal | undefined;
    let releaseProvider!: () => void;
    let providerSettled = false;
    let outcomeSettled = false;
    mockDispatchModuleAction.mockImplementationOnce(() => new Promise(resolve => {
      activeProviderSignal = getRequestAbortSignal();
      releaseProvider = () => {
        providerSettled = true;
        resolve('late provider output must be fenced');
      };
    }));
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return a production-sized card.',
        },
      },
      prompt: 'Return a production-sized card.',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-timeout',
      traceId: 'trace-worker-timeout',
    });

    try {
      const outcomePromise = executeQueuedGptRequest({
        jobId: '44444444-4444-4444-8444-444444444444',
        rawInput,
      });
      void outcomePromise.finally(() => {
        outcomeSettled = true;
      }).catch(() => undefined);
      await jest.advanceTimersByTimeAsync(110_001);
      expect(activeProviderSignal?.aborted).toBe(true);
      expect(providerSettled).toBe(false);
      expect(outcomeSettled).toBe(false);
      await jest.advanceTimersByTimeAsync(2_000);
      const outcome = await outcomePromise;

      expect(providerSettled).toBe(false);
      expect(outcomeSettled).toBe(true);
      expect(outcome).toMatchObject({
        status: 'failed',
        retryable: false,
        errorMessage: 'BACKSTAGE_ASYNC_TIMEOUT: Protected Backstage generation reached its worker deadline.',
      });
      expect(unprotectBackstageQueuedGptJobOutput({
        jobId: '44444444-4444-4444-8444-444444444444',
        rawInput,
        output: outcome.output,
      })).toMatchObject({
        ok: false,
        error: { code: 'BACKSTAGE_ASYNC_TIMEOUT' },
      });
      releaseProvider();
      await Promise.resolve();
      expect(outcome).toMatchObject({
        status: 'failed',
        errorMessage: 'BACKSTAGE_ASYNC_TIMEOUT: Protected Backstage generation reached its worker deadline.',
      });
    } finally {
      releaseProvider?.();
      jest.useRealTimers();
    }
  });

  it('uses the persisted first-start time so a stale reclaim cannot reset the worker deadline', async () => {
    process.env.BOOKER_WORKER_JOB_TIMEOUT_MS = '120000';
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return a production-sized card.',
        },
      },
      prompt: 'Return a production-sized card.',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-stale-reclaim',
      traceId: 'trace-worker-stale-reclaim',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '66666666-6666-4666-8666-666666666666',
      rawInput,
      startedAt: new Date(Date.now() - 110_001),
    });

    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'BACKSTAGE_ASYNC_TIMEOUT: Protected Backstage generation reached its worker deadline.',
    });
    expect(unprotectBackstageQueuedGptJobOutput({
      jobId: '66666666-6666-4666-8666-666666666666',
      rawInput,
      output: outcome.output,
    })).toMatchObject({
      ok: false,
      error: { code: 'BACKSTAGE_ASYNC_TIMEOUT' },
    });
  });

  it('does not misclassify an early provider AbortError as the worker deadline', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(Object.assign(
      new Error('provider transport aborted before the deadline'),
      { name: 'AbortError' }
    ));
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return a production-sized card.',
        },
      },
      prompt: 'Return a production-sized card.',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-provider-abort',
      traceId: 'trace-worker-provider-abort',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '77777777-7777-4777-8777-777777777777',
      rawInput,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'MODULE_ERROR: Protected Backstage generation failed.',
    });
    expect(unprotectBackstageQueuedGptJobOutput({
      jobId: '77777777-7777-4777-8777-777777777777',
      rawInput,
      output: outcome.output,
    })).toMatchObject({
      ok: false,
      error: { code: 'MODULE_ERROR' },
    });
  });

  it('propagates durable cancellation to the active provider request', async () => {
    const parentController = new AbortController();
    let activeProviderSignal: AbortSignal | undefined;
    let providerStarted!: () => void;
    const providerStartedPromise = new Promise<void>(resolve => {
      providerStarted = resolve;
    });
    mockDispatchModuleAction.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      activeProviderSignal = getRequestAbortSignal();
      providerStarted();
      activeProviderSignal?.addEventListener('abort', () => {
        reject(activeProviderSignal?.reason ?? createAbortError());
      }, { once: true });
    }));
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return a production-sized card.',
        },
      },
      prompt: 'Return a production-sized card.',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-cancel-active',
      traceId: 'trace-worker-cancel-active',
    });

    const outcomePromise = executeQueuedGptRequest({
      jobId: '55555555-5555-4555-8555-555555555555',
      rawInput,
      cancellationSignal: parentController.signal,
    });
    await providerStartedPromise;
    parentController.abort(createAbortError('durable protected cancellation'));
    const outcome = await outcomePromise;

    expect(activeProviderSignal?.aborted).toBe(true);
    expect(outcome).toEqual({
      status: 'cancelled',
      output: null,
      errorMessage: 'Protected Backstage generation cancellation requested.',
      retryable: false,
    });
  });

  it('does not reflect a protected cancellation reason across the worker boundary', async () => {
    const privateCancellationReason = 'private-protected-cancellation-sentinel';
    mockGetJobById.mockResolvedValueOnce({
      cancel_requested_at: new Date('2026-08-23T12:00:00.000Z'),
      cancel_reason: privateCancellationReason,
    });
    const rawInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Return exactly six matches.',
        },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-worker-cancelled',
      traceId: 'trace-worker-cancelled',
    });

    const outcome = await executeQueuedGptRequest({
      jobId: '33333333-3333-4333-8333-333333333333',
      rawInput,
    });

    expect(outcome).toEqual({
      status: 'cancelled',
      output: null,
      errorMessage: 'Protected Backstage generation cancellation requested.',
      retryable: false,
    });
    expect(JSON.stringify(outcome)).not.toContain(privateCancellationReason);
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
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

  it('does not retry a Notion-authoritative write denial', async () => {
    mockDispatchModuleAction.mockRejectedValueOnce(
      new BackstageNotionAuthorityReadOnlyError('phase-two')
    );

    const outcome = await executeQueuedGptRequest({
      jobId: 'job-backstage-notion-authority-read-only',
      rawInput: {
        gptId: 'backstage',
        body: {
          action: 'upsertStoryline',
          payload: {
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
          },
        },
        requestId: 'req-backstage-notion-authority-read-only',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'upsertStoryline',
          principalId: 'operator:normal-worker-test',
        }),
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      retryable: false,
      output: {
        ok: false,
        error: {
          code: BACKSTAGE_NOTION_AUTHORITY_READ_ONLY_ERROR_CODE,
          details: { retryable: false },
        },
      },
    });
  });

  it.each([
    [
      BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
      () => new BackstageNotionIndexUnavailableError(),
    ],
    [
      BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE_ERROR_CODE,
      () => new BackstageNotionAuthorityUnavailableError('phase-two'),
    ],
  ] as const)(
    'rejects legacy plaintext generation before a transient %s outage can dispatch',
    async (errorCode, buildError) => {
      mockDispatchModuleAction.mockRejectedValueOnce(buildError());

      const outcome = await executeQueuedGptRequest({
        jobId: `job-${errorCode.toLowerCase()}`,
        rawInput: {
          gptId: 'backstage',
          body: {
            action: 'generateBooking',
            payload: {
              universeId: 'phase-two',
              prompt: 'Review the current show state.',
            },
          },
          requestId: `req-${errorCode.toLowerCase()}`,
        },
      });

      expect(outcome).toMatchObject({
        status: 'failed',
        retryable: false,
        output: null,
        errorMessage: 'Protected Backstage generation job payload is required.',
      });
      expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    }
  );
});
