import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type OpenAI from 'openai';

const mockCreateSingleChatCompletion = jest.fn();
const mockRunStructuredReasoning = jest.fn();
const mockRunClearAudit = jest.fn();
const mockRecordTrinityJudgedFeedback = jest.fn();
const mockRunSelfImproveCycle = jest.fn();
const mockStorePattern = jest.fn();
const mockTrackEscalation = jest.fn();
const mockRecordTrinityStageFailure = jest.fn();
const mockNoteTrinityMitigationOutcome = jest.fn();
const mockRetrieveModel = jest.fn();

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'test',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true,
  setDefaultModel: jest.fn(),
  getDefaultModel: () => 'arcanos-intake-model',
  getComplexModel: () => 'arcanos-final-model',
  getFallbackModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5-reasoning-model'
}));

jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createChatCompletionWithFallback: mockCreateSingleChatCompletion,
  createSingleChatCompletion: mockCreateSingleChatCompletion,
  ensureModelMatchesExpectation: (_response: unknown, expectedModel: string) => expectedModel
}));

jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({
  runStructuredReasoning: mockRunStructuredReasoning
}));

jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: jest.fn(() => ({
    relevantEntries: [],
    contextSummary: 'No memory context available.',
    accessLog: []
  })),
  storePattern: mockStorePattern
}));

jest.unstable_mockModule('../src/core/audit/runClearAudit.js', () => ({
  runClearAudit: mockRunClearAudit
}));

jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: mockRecordTrinityJudgedFeedback
}));

jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({
  runSelfImproveCycle: mockRunSelfImproveCycle
}));

jest.unstable_mockModule('@analytics/escalationTracker.js', () => ({
  trackEscalation: mockTrackEscalation
}));

jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null,
    stage: null,
    bypassFinalStage: false,
    forceDirectAnswer: false,
    verified: false
  }),
  noteTrinityMitigationOutcome: mockNoteTrinityMitigationOutcome,
  recordTrinityStageFailure: mockRecordTrinityStageFailure
}));

const { runThroughBrain } = await import('../src/core/logic/trinity.js');
const { createRuntimeBudget } = await import('@platform/resilience/runtimeBudget.js');
const { getRequestAbortSignal, runWithRequestAbortContext } = await import('@arcanos/runtime');

const client = {
  models: {
    retrieve: mockRetrieveModel
  }
} as unknown as OpenAI;

function completion(content: string, activeModel: string) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    activeModel,
    fallbackFlag: false,
    usage: {
      prompt_tokens: 5,
      completion_tokens: 5,
      total_tokens: 10
    },
    id: `${activeModel}-response`,
    created: 1
  };
}

function primeSuccessfulPipeline(): void {
  mockCreateSingleChatCompletion
    .mockResolvedValueOnce(completion('Framed request.', 'arcanos-intake-model'))
    .mockResolvedValueOnce(completion('Release summary.', 'arcanos-final-model'));
  mockRunStructuredReasoning.mockResolvedValue({
    reasoning_steps: ['Summarize the supplied material.'],
    assumptions: [],
    constraints: [],
    tradeoffs: [],
    alternatives_considered: [],
    chosen_path_justification: 'A concise summary directly answers the request.',
    response_mode: 'answer',
    achievable_subtasks: ['summarize'],
    blocked_subtasks: [],
    user_visible_caveats: [],
    claim_tags: [],
    final_answer: 'Reasoned release summary.'
  });
  mockRunClearAudit.mockResolvedValue({
    clarity: 5,
    leverage: 5,
    efficiency: 5,
    alignment: 5,
    resilience: 5,
    overall: 5
  });
}

function activeRequestContext(controller: AbortController) {
  return {
    requestId: 'trinity-cancellation-test',
    controller,
    signal: controller.signal,
    deadlineAt: Date.now() + 30_000,
    timeoutMs: 30_000
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Trinity cancellation and optional side effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateSingleChatCompletion.mockReset();
    mockRunStructuredReasoning.mockReset();
    mockRunClearAudit.mockReset();
    mockRecordTrinityJudgedFeedback.mockReset();
    mockRunSelfImproveCycle.mockReset();
    mockRecordTrinityStageFailure.mockReset();
    mockNoteTrinityMitigationOutcome.mockReset();
    mockRetrieveModel.mockReset();
    mockRetrieveModel.mockResolvedValue({ id: 'arcanos-intake-model' });
    mockRunSelfImproveCycle.mockResolvedValue(undefined);
    mockRecordTrinityJudgedFeedback.mockResolvedValue({
      enabled: true,
      attempted: true,
      source: 'clear_audit'
    });
    mockRecordTrinityStageFailure.mockReturnValue('retry_once');
  });

  it('skips feedback persistence and detached self-improvement for normal results when disabled', async () => {
    primeSuccessfulPipeline();

    const result = await runThroughBrain(
      client,
      'Assess this launch plan and note any limitation around competitor moves.',
      undefined,
      undefined,
      { disableOptionalSideEffects: true },
      createRuntimeBudget()
    );

    expect(mockRunClearAudit).toHaveBeenCalledTimes(1);
    expect(mockRunSelfImproveCycle).not.toHaveBeenCalled();
    expect(mockRecordTrinityJudgedFeedback).not.toHaveBeenCalled();
    expect(result.judgedFeedback).toEqual({
      enabled: false,
      attempted: false,
      source: 'clear_audit',
      reason: 'disabled_by_caller'
    });
  });

  it('skips feedback persistence for exact-literal and direct-answer results when disabled', async () => {
    const exactResult = await runThroughBrain(
      client,
      'Write exactly this token and nothing else: CANCEL-SAFE',
      undefined,
      undefined,
      { disableOptionalSideEffects: true },
      createRuntimeBudget()
    );

    mockCreateSingleChatCompletion.mockResolvedValueOnce(
      completion('The release is ready.', 'gpt-4.1')
    );
    const directResult = await runThroughBrain(
      client,
      'State that the release is ready.',
      undefined,
      undefined,
      { answerMode: 'direct', disableOptionalSideEffects: true },
      createRuntimeBudget()
    );

    expect(exactResult.judgedFeedback?.reason).toBe('disabled_by_caller');
    expect(directResult.judgedFeedback?.reason).toBe('disabled_by_caller');
    expect(mockRecordTrinityJudgedFeedback).not.toHaveBeenCalled();
  });

  it('treats a parent abort during intake as terminal instead of starting direct-answer recovery', async () => {
    const controller = new AbortController();
    const parentAbort = Object.assign(new Error('client disconnected'), { name: 'AbortError' });
    mockCreateSingleChatCompletion.mockImplementationOnce(async () => {
      controller.abort(parentAbort);
      throw parentAbort;
    });

    await expect(runWithRequestAbortContext(
      activeRequestContext(controller),
      () => runThroughBrain(
        client,
        'Assess this launch plan and note any limitation around competitor moves.',
        undefined,
        undefined,
        { disableOptionalSideEffects: true },
        createRuntimeBudget()
      )
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(mockCreateSingleChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockRecordTrinityStageFailure).not.toHaveBeenCalled();
  });

  it('preserves the aggregate signal and waits for a delayed direct-model drain', async () => {
    const controller = new AbortController();
    const parentAbort = Object.assign(new Error('research workflow cancelled'), {
      name: 'AbortError'
    });
    const modelStarted = createDeferred();
    const releaseModel = createDeferred();
    let observedSignal: AbortSignal | undefined;
    let observedAggregateFlag = false;
    let modelObservedAbort = false;
    let modelSettled = false;
    let trinitySettled = false;
    mockCreateSingleChatCompletion.mockImplementationOnce(
      async (_client: unknown, params: {
        signal?: AbortSignal;
        preserveAggregateAbortContext?: boolean;
      }) => {
        observedSignal = params.signal;
        observedAggregateFlag = params.preserveAggregateAbortContext === true;
        modelStarted.resolve();
        return await new Promise((_resolve, reject) => {
          const onAbort = () => {
            modelObservedAbort = true;
            void releaseModel.promise.then(() => {
              modelSettled = true;
              reject(params.signal?.reason);
            });
          };
          if (params.signal?.aborted) {
            onAbort();
          } else {
            params.signal?.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    );

    const trinity = Promise.resolve(runWithRequestAbortContext(
      activeRequestContext(controller),
      () => runThroughBrain(
        client,
        'State the bounded research conclusion directly.',
        undefined,
        undefined,
        {
          answerMode: 'direct',
          disableOptionalSideEffects: true,
          preserveAggregateAbortContext: true
        },
        createRuntimeBudget()
      )
    ));
    void trinity.then(
      () => { trinitySettled = true; },
      () => { trinitySettled = true; },
    );

    await modelStarted.promise;
    expect(observedSignal).toBe(controller.signal);
    expect(observedAggregateFlag).toBe(true);
    expect(mockRetrieveModel).not.toHaveBeenCalled();
    controller.abort(parentAbort);
    await Promise.resolve();
    expect(modelObservedAbort).toBe(true);
    expect(modelSettled).toBe(false);
    expect(trinitySettled).toBe(false);

    releaseModel.resolve();
    await expect(trinity).rejects.toMatchObject({ name: 'AbortError' });
    expect(modelSettled).toBe(true);
    expect(trinitySettled).toBe(true);
    expect(mockCreateSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('awaits delayed cooperative drain for a locally timed Trinity stage', async () => {
    const controller = new AbortController();
    const parentAbort = Object.assign(new Error('research workflow cancelled in audit'), {
      name: 'AbortError'
    });
    const auditStarted = createDeferred();
    const releaseAudit = createDeferred();
    let auditSignal: AbortSignal | undefined;
    let auditSettled = false;
    let trinitySettled = false;
    primeSuccessfulPipeline();
    mockRunClearAudit.mockImplementationOnce(async () => {
      auditSignal = getRequestAbortSignal();
      auditStarted.resolve();
      return await new Promise((_resolve, reject) => {
        const onAbort = () => {
          void releaseAudit.promise.then(() => {
            auditSettled = true;
            reject(auditSignal?.reason);
          });
        };
        if (auditSignal?.aborted) {
          onAbort();
        } else {
          auditSignal?.addEventListener('abort', onAbort, { once: true });
        }
      });
    });

    const trinity = Promise.resolve(runWithRequestAbortContext(
      activeRequestContext(controller),
      () => runThroughBrain(
        client,
        'Assess this launch plan and note any limitation around competitor moves.',
        undefined,
        undefined,
        {
          disableOptionalSideEffects: true,
          preserveAggregateAbortContext: true
        },
        createRuntimeBudget()
      )
    ));
    void trinity.then(
      () => { trinitySettled = true; },
      () => { trinitySettled = true; },
    );

    await auditStarted.promise;
    expect(auditSignal).toBe(controller.signal);
    controller.abort(parentAbort);
    await Promise.resolve();
    expect(auditSettled).toBe(false);
    expect(trinitySettled).toBe(false);

    releaseAudit.resolve();
    await expect(trinity).rejects.toMatchObject({ name: 'AbortError' });
    expect(auditSettled).toBe(true);
    expect(trinitySettled).toBe(true);
  });

  it('treats a parent abort caught by CLEAR audit as terminal', async () => {
    const controller = new AbortController();
    const parentAbort = Object.assign(new Error('client disconnected'), { name: 'AbortError' });
    primeSuccessfulPipeline();
    mockRunClearAudit.mockImplementationOnce(async () => {
      controller.abort(parentAbort);
      throw parentAbort;
    });

    await expect(runWithRequestAbortContext(
      activeRequestContext(controller),
      () => runThroughBrain(
        client,
        'Assess this launch plan and note any limitation around competitor moves.',
        undefined,
        undefined,
        { disableOptionalSideEffects: true },
        createRuntimeBudget()
      )
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(mockCreateSingleChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockRunSelfImproveCycle).not.toHaveBeenCalled();
    expect(mockRecordTrinityJudgedFeedback).not.toHaveBeenCalled();
  });

  it('preserves simple-tier recovery for a local stage abort while the parent remains active', async () => {
    const controller = new AbortController();
    const localAbort = Object.assign(new Error('intake stage timed out'), { name: 'AbortError' });
    mockCreateSingleChatCompletion
      .mockRejectedValueOnce(localAbort)
      .mockResolvedValueOnce(completion('Recovered direct answer.', 'gpt-4.1'));

    const result = await runWithRequestAbortContext(
      activeRequestContext(controller),
      () => runThroughBrain(
        client,
        'Assess this launch plan and note any limitation around competitor moves.',
        undefined,
        undefined,
        { disableOptionalSideEffects: true },
        createRuntimeBudget()
      )
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(mockCreateSingleChatCompletion).toHaveBeenCalledTimes(2);
    expect(mockRecordTrinityStageFailure).toHaveBeenCalledTimes(1);
  });
});
