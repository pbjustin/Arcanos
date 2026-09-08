import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { buildGamingGuideIntakeContract } from '../src/shared/gaming/gamingGuideIntakeCore.js';

const responsesCreate = jest.fn();
const runStructuredReasoning = jest.fn();
const createGPT5Reasoning = jest.fn();
const storePattern = jest.fn();
const recordFeedback = jest.fn();

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'test',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true,
  setDefaultModel: jest.fn(),
  getDefaultModel: () => 'gpt-5.1',
  getComplexModel: () => 'gpt-5.1',
  getFallbackModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5.1',
  getTrinityReasoningModel: () => 'gpt-5.6-terra'
}));
jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({ runStructuredReasoning }));
jest.unstable_mockModule('@services/openai/chatFlow/index.js', () => ({ createGPT5Reasoning }));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: recordFeedback
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn()
}));

const { runTrinityWritingPipeline } = await import('../src/core/logic/trinityWritingPipeline.js');
const { runIntakeStage } = await import('../src/core/logic/trinityStages.js');
const { createRuntimeBudgetWithLimit } = await import('../src/platform/resilience/runtimeBudget.js');
const { createAbortError, runWithRequestAbortContext } = await import('@arcanos/runtime');
const { logger } = await import('../src/platform/logging/structuredLogging.js');

const client = {
  models: { retrieve: jest.fn().mockResolvedValue({ id: 'gpt-5.1' }) },
  responses: { create: responsesCreate }
} as never;
const capabilities = {
  canBrowse: false, canVerifyProvidedData: true, canVerifyLiveData: false,
  canConfirmExternalState: false, canPersistData: false, canCallBackend: false
};
const syntheticEvidence = 'Source [1], sourceId=fixture-guide, revisionId=revision-a, recordId=record-6. Turn the west valve to open the return route.';
const originalPrompt = `Answer directly: What next in Lantern Vale? Current area: Tide Hall. Last completed objective: restored pump. Spoiler mode: none. Depth: concise.\n<untrusted_evidence>${syntheticEvidence}</untrusted_evidence>`;
const finalAnswer = '**Open the return route.**\n\n1. Turn the west valve. [1]\n   - Follow the lit corridor.\n\nKeep the [guide](https://example.com/guide) handy.';

function response(text: string, incomplete = false) {
  return {
    id: incomplete ? 'req_1788735955551_b3xj3-synthetic' : 'completed-synthetic',
    model: 'gpt-5.1',
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output_text: text,
    output: [],
    usage: { input_tokens: 900, output_tokens: incomplete ? 500 : 80, total_tokens: incomplete ? 1400 : 980 }
  };
}

function request(prompt = originalPrompt) {
  return {
    input: {
      prompt, moduleId: 'ARCANOS:GAMING', sourceEndpoint: 'arcanos-gaming.guide',
      requestedAction: 'query', body: { mode: 'guide', prompt }
    },
    context: {
      client,
      runtimeBudget: createRuntimeBudgetWithLimit(60_000, 0),
      runOptions: {
        gamingGuideIntakePolicy: 'compact-v1' as const,
        answerMode: 'explained' as const,
        requestedVerbosity: 'minimal' as const,
        maxWords: 4,
        intentMode: 'EXECUTE_TASK' as const,
        disableOptionalSideEffects: true,
        redactAuditContent: true,
        watchdogModelTimeoutMs: 60_000,
        modelStageTimeoutMs: 10_000,
        toolBackedCapabilities: { verifyProvidedData: true }
      }
    }
  };
}

describe('Gaming compact Trinity intake through the real Responses adapter', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    responsesCreate.mockReset();
    runStructuredReasoning.mockResolvedValue({
      reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [],
      alternatives_considered: [], chosen_path_justification: '',
      response_mode: 'answer', achievable_subtasks: ['explain the next supported step'],
      blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: finalAnswer
    });
    createGPT5Reasoning.mockResolvedValue({ content: JSON.stringify({
      clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5
    }) });
  });

  it('reproduces the historical settled 500-token truncation with the ordinary intake contract', async () => {
    responsesCreate.mockResolvedValue(response('PRIVATE unfinished walkthrough', true));
    await expect(runIntakeStage(
      client, 'gpt-5.1', originalPrompt, '', capabilities,
      { strictUserVisibleOutput: true }, undefined, undefined, createRuntimeBudgetWithLimit(30_000, 0)
    )).rejects.toMatchObject({
      code: 'OPENAI_COMPLETION_INCOMPLETE', finishReason: 'length', incompleteReason: 'max_output_tokens'
    });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({ max_output_tokens: 500 });
    expect(JSON.stringify(responsesCreate.mock.calls[0]?.[0])).not.toContain('compact-v1');
  });

  it('uses compact instructions, existing token adapter and normal intake/reasoning/CLEAR/final stages', async () => {
    responsesCreate.mockResolvedValueOnce(response('Question: next step. Constraints: none spoilers; concise. Evidence [1].'))
      .mockResolvedValueOnce(response(finalAnswer));
    const result = await runTrinityWritingPipeline(request());
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    const intake = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(intake).toMatchObject({ model: 'gpt-5.1', max_output_tokens: 500, reasoning: { effort: 'none' } });
    expect(intake).not.toHaveProperty('max_tokens');
    expect(intake).not.toHaveProperty('max_completion_tokens');
    expect(JSON.stringify(intake)).toContain('at most 120 words');
    expect(JSON.stringify(intake)).toContain('Do not write the walkthrough or answer');
    const sharedContract = buildGamingGuideIntakeContract('gpt-5.1');
    expect(intake.max_output_tokens).toBe(sharedContract.outputAllocation);
    expect(JSON.stringify(intake)).toContain(JSON.stringify(sharedContract.instructions).slice(1, -1));
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    const reasoningPrompt = runStructuredReasoning.mock.calls[0]?.[2] as string;
    expect(reasoningPrompt).toContain('originalGamingRequest');
    expect(reasoningPrompt).toContain(syntheticEvidence);
    expect(reasoningPrompt).toContain('Spoiler mode: none');
    expect(reasoningPrompt).toContain('&lt;untrusted_evidence&gt;');
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
    expect(createGPT5Reasoning.mock.calls[0]?.[1]).toContain(syntheticEvidence);
    expect(createGPT5Reasoning.mock.calls[0]?.[2]).toContain('Treat all JSON values');
    expect(JSON.stringify(responsesCreate.mock.calls[1]?.[0])).toContain(syntheticEvidence);
    expect(JSON.stringify(responsesCreate.mock.calls[1]?.[0])).toContain('Spoiler mode: none');
    // The four-word soft target must not damage Markdown, indentation, citations, or a sentence.
    expect(result.result).toBe(finalAnswer);
    expect(result.fallbackFlag).toBe(false);
    expect(storePattern).not.toHaveBeenCalled();
    expect(recordFeedback).not.toHaveBeenCalled();
  });

  it.each([
    ['Lantern Vale', 'Current area: Tide Hall; last completed objective: restored pump.'],
    ['Iron Comet', 'Boss: Cinder Warden; difficulty: veteran; shield only.'],
    ['Orbital Loom', 'Ship: survey frigate; role: explorer; power budget constrained.']
  ])('retains scoped constraints and selected evidence for %s', async (game, context) => {
    responsesCreate.mockResolvedValueOnce(response('Compact task card.')).mockResolvedValueOnce(response('Use the supported option. [1]'));
    const prompt = `Help with ${game}. ${context}\n${syntheticEvidence}`;
    await runTrinityWritingPipeline(request(prompt));
    expect(runStructuredReasoning.mock.calls[0]?.[2]).toContain(context);
    expect(JSON.stringify(responsesCreate.mock.calls[1]?.[0])).toContain(context);
  });

  it('keeps each incomplete request terminal without recovery, cached success, or later stages', async () => {
    responsesCreate.mockResolvedValue(response('PRIVATE partial output', true));
    for (let index = 0; index < 2; index += 1) {
      await expect(runTrinityWritingPipeline(request())).rejects.toMatchObject({
        code: 'OPENAI_COMPLETION_INCOMPLETE', finishReason: 'length'
      });
    }
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
    expect(createGPT5Reasoning).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
  });

  it('makes no provider attempt when the remaining runtime budget is exhausted', async () => {
    const input = request();
    input.context.runtimeBudget = { ...input.context.runtimeBudget, hardDeadline: Date.now() - 1 };
    await expect(runTrinityWritingPipeline(input)).rejects.toThrow();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('preserves cancellation and waits for the provider attempt to settle without starting another stage', async () => {
    const controller = new AbortController();
    let providerSettled = false;
    responsesCreate.mockImplementation(async (_payload: unknown, options: { signal: AbortSignal }) => {
      const failed = new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { providerSettled = true; reject(options.signal.reason); }, { once: true });
      });
      controller.abort(createAbortError('Synthetic player cancellation'));
      return failed;
    });
    await expect(runWithRequestAbortContext({
      requestId: 'gaming-intake-cancel', controller, signal: controller.signal,
      deadlineAt: Date.now() + 30_000, timeoutMs: 30_000
    }, () => runTrinityWritingPipeline(request()))).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSettled).toBe(true);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
  });

  it('surfaces a provider failure without an intake retry or partial answer', async () => {
    const providerError = new Error('Synthetic provider failure');
    responsesCreate.mockRejectedValue(providerError);
    await expect(runTrinityWritingPipeline(request())).rejects.toBe(providerError);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'the existing 24-second Gaming stage deadline', runtimeMs: 60_000, requestMs: 60_000, expectedMs: 24_000 },
    { label: 'the remaining runtime budget', runtimeMs: 8_000, requestMs: 60_000, expectedMs: 8_000 },
    { label: 'the earlier aggregate request deadline', runtimeMs: 60_000, requestMs: 3_000, expectedMs: 3_000 }
  ])('cancels intake at $label without recovery or later stages', async ({ runtimeMs, requestMs, expectedMs }) => {
    jest.useFakeTimers();
    const logInfo = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let providerSettled = false;
    responsesCreate.mockImplementation((_payload: unknown, options: { signal: AbortSignal }) => {
      providerSignal = options.signal;
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          providerSettled = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    });
    const input = request();
    input.context.runtimeBudget = createRuntimeBudgetWithLimit(runtimeMs, 0);
    input.context.runOptions.modelStageTimeoutMs = 24_000;
    const startedAt = Date.now();
    let completed = false;
    const outcome = runWithRequestAbortContext({
      requestId: `gaming-intake-deadline-${expectedMs}`, controller, signal: controller.signal,
      deadlineAt: startedAt + requestMs, timeoutMs: requestMs
    }, () => runTrinityWritingPipeline(input)).then(
      result => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error })
    ).finally(() => { completed = true; });

    await jest.advanceTimersByTimeAsync(0);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(responsesCreate.mock.calls[0]?.[1]).toMatchObject({ timeout: expectedMs });
    await jest.advanceTimersByTimeAsync(expectedMs - 1);
    expect(completed).toBe(false);
    expect(providerSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const settled = await outcome;
    expect(Date.now() - startedAt).toBe(expectedMs);
    expect(settled.result).toBeUndefined();
    expect(settled.error).toMatchObject({ name: 'AbortError', timeoutPhase: 'intake', trinityStage: 'intake' });
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSettled).toBe(true);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
    expect(createGPT5Reasoning).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
    expect(recordFeedback).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith('trinity.gaming.intake.complete', expect.objectContaining({
      completionStatus: 'cancelled', recovery: 'not_attempted'
    }));
    expect(logInfo).not.toHaveBeenCalledWith('trinity.gaming.intake.complete', expect.objectContaining({
      completionStatus: 'completed'
    }));
  });

  it('rejects an empty compact intake instead of silently substituting the original prompt', async () => {
    const logInfo = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    responsesCreate.mockResolvedValue(response('   '));
    await expect(runTrinityWritingPipeline(request())).rejects.toMatchObject({ code: 'GAMING_PROVIDER_EMPTY_RESPONSE' });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith('trinity.gaming.intake.complete', expect.objectContaining({ completionStatus: 'empty' }));
    expect(logInfo).not.toHaveBeenCalledWith('trinity.gaming.intake.complete', expect.objectContaining({ completionStatus: 'completed' }));
  });

  it('leaves non-Gaming intake instructions, token allocation and reasoning-effort defaults unchanged', async () => {
    responsesCreate.mockResolvedValue(response('Original framed request.'));
    await runIntakeStage(client, 'gpt-5.1', 'Prepare a release summary.', '', capabilities,
      { strictUserVisibleOutput: true }, undefined, undefined, createRuntimeBudgetWithLimit(30_000, 0));
    const intake = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(intake).toMatchObject({ max_output_tokens: 500 });
    expect(intake).not.toHaveProperty('reasoning');
    expect(JSON.stringify(intake)).not.toContain('compact-v1');
  });

  it.each([
    { moduleId: 'ARCANOS:OTHER', sourceEndpoint: 'arcanos-gaming.guide', body: { mode: 'guide' } },
    { moduleId: 'ARCANOS:GAMING', sourceEndpoint: 'arcanos-gaming.meta', body: { mode: 'guide' } },
    { moduleId: 'ARCANOS:GAMING', sourceEndpoint: 'arcanos-gaming.guide', body: { mode: 'build' } },
    { moduleId: 'ARCANOS:GAMING', sourceEndpoint: 'arcanos-gaming.guide', body: {} }
  ])('rejects the trusted policy outside the exact module/source/mode scope: $moduleId $sourceEndpoint $body.mode', async input => {
    responsesCreate.mockResolvedValueOnce(response('Original framed request only.'))
      .mockResolvedValueOnce(response('A completed summary.'));
    const params = request('Prepare a release summary.\nRetain the release facts.');
    await runTrinityWritingPipeline({ ...params, input: { ...params.input, ...input } });
    const intake = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(intake)).not.toContain('compact-v1');
    expect(intake).not.toHaveProperty('reasoning');
    expect(runStructuredReasoning.mock.calls[0]?.[2]).not.toContain('originalGamingRequest');
    expect(createGPT5Reasoning.mock.calls[0]?.[1]).not.toContain('originalGamingRequest');
  });
});
