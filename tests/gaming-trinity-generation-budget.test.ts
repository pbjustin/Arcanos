import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TrinityRunOptions } from '../src/core/logic/trinityTypes.js';
import { GAMING_HYBRID_INTAKE } from '../src/shared/gaming/gamingGuideIntakeCore.js';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { resolveGamingGenerationBudget } from '../src/services/gamingConfig.js';

const responsesCreate = jest.fn();
const runStructuredReasoning = jest.fn();
const reflectionMock = jest.fn();
const authorityModel = 'ft:gpt-4.1:synthetic:gaming-budget-authority';
const previousAuthorityModel = process.env.FINETUNED_MODEL_ID;
const previousReflectionTimeout = process.env.TRINITY_REFLECTION_STAGE_TIMEOUT_MS;
jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({ runStructuredReasoning }));
jest.unstable_mockModule('@services/openai/chatFlow/index.js', () => ({
  createGPT5Reasoning: reflectionMock
}));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }), storePattern: jest.fn()
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false
  }), noteTrinityMitigationOutcome: jest.fn(), recordTrinityStageFailure: jest.fn()
}));
const { runTrinityWritingPipeline } = await import('../src/core/logic/trinityWritingPipeline.js');
const { createRuntimeBudgetWithLimit, getSafeRemainingMs } = await import('../src/platform/resilience/runtimeBudget.js');
const { createAbortError, runWithRequestAbortTimeout } = await import('@arcanos/runtime');
const client = { models: { retrieve: jest.fn().mockResolvedValue({ id: 'gpt-6-luna' }) },
  responses: { create: responsesCreate } } as never;
const prompt = 'Give a grounded build using <untrusted_evidence>Guide [1]: use the supported starter equipment.</untrusted_evidence>';
const answer = 'Use the supported starter equipment. [1]';
const reasoning = { reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [],
  alternatives_considered: [], chosen_path_justification: '', response_mode: 'answer',
  achievable_subtasks: ['give a supported build'], blocked_subtasks: [], user_visible_caveats: [],
  claim_tags: [], final_answer: answer };
const response = (text: string, model = 'gpt-6-luna') => ({ id: 'budget-synthetic', model,
  status: 'completed', output_text: text, output: [], usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } });

function startGeneration(configuredStageTimeoutMs?: number, watchdogTimeoutMs = 35_000,
  generationPrompt = prompt, gamingClearAnswerAudit?: TrinityRunOptions['gamingClearAnswerAudit']) {
  const runtimeBudget = createRuntimeBudgetWithLimit(35_000, 500);
  const allocations: { stage: string; timeoutMs: number; elapsedMs: number; additionalDownstreamReserveMs: number }[] = [];
  const runOptions: TrinityRunOptions = {
    gamingGuideIntakePolicy: 'compact-v1', intentMode: 'EXECUTE_TASK', answerMode: 'explained',
    disableOptionalSideEffects: true, redactAuditContent: true, watchdogModelTimeoutMs: watchdogTimeoutMs,
    modelStageTimeoutMs: 12_000, toolBackedCapabilities: { verifyProvidedData: true },
    ...(gamingClearAnswerAudit ? { gamingClearAnswerAudit } : {}),
    resolveModelStageTimeoutMs: (stage, budget, remainingWatchdogMs, additionalDownstreamReserveMs = 0) => {
      const elapsedMs = Date.now() - budget.startedAt;
      const timeoutMs = resolveGamingGenerationBudget({ mode: 'build', stage, pipelineTimeoutMs: 35_000,
        pipelineElapsedMs: elapsedMs, runtimeRemainingMs: Math.min(getSafeRemainingMs(budget), remainingWatchdogMs),
        configuredStageTimeoutMs, additionalDownstreamReserveMs }).effectiveStageTimeoutMs;
      allocations.push({ stage, timeoutMs, elapsedMs, additionalDownstreamReserveMs });
      if (timeoutMs <= 0) throw Object.assign(createAbortError('Budget exhausted.'), { timeoutPhase: stage });
      return timeoutMs;
    }
  };
  const operation = runWithRequestAbortTimeout({ timeoutMs: 35_000 }, () => runTrinityWritingPipeline({
    input: { prompt: generationPrompt, moduleId: 'ARCANOS:GAMING', sourceEndpoint: 'arcanos-gaming.hybrid-build',
      requestedAction: 'query', body: { mode: 'build', prompt: generationPrompt, [GAMING_HYBRID_INTAKE]: true } },
    context: { client, runtimeBudget, runOptions }
  }));
  return { operation, allocations };
}

describe('Gaming allocation through the real Trinity stage dispatch', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 100_000 });
    process.env.FINETUNED_MODEL_ID = authorityModel;
    jest.clearAllMocks();
    responsesCreate.mockReset();
    runStructuredReasoning.mockReset();
    reflectionMock.mockReset().mockResolvedValue({ content: JSON.stringify({
      clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5
    }) });
    delete process.env.TRINITY_REFLECTION_STAGE_TIMEOUT_MS;
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previousAuthorityModel === undefined) delete process.env.FINETUNED_MODEL_ID;
    else process.env.FINETUNED_MODEL_ID = previousAuthorityModel;
    if (previousReflectionTimeout === undefined) delete process.env.TRINITY_REFLECTION_STAGE_TIMEOUT_MS;
    else process.env.TRINITY_REFLECTION_STAGE_TIMEOUT_MS = previousReflectionTimeout;
  });

  it('lets reasoning cross the old 12-second default after a five-second intake, with one stage attempt', async () => {
    responsesCreate.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 5_000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response(answer, authorityModel)), 1_000)));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reasoning), 13_000)));
    const { operation, allocations } = startGeneration();
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(allocations.find(entry => entry.stage === 'reasoning')).toEqual({ stage: 'reasoning', timeoutMs: 20_500,
      elapsedMs: 5_000, additionalDownstreamReserveMs: 0 });
    await jest.advanceTimersByTimeAsync(12_000);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    const result = await operation;
    expect(result.result).toBe(answer);
    expect(result.fallbackFlag).toBe(false);
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(allocations.find(entry => entry.stage === 'final')?.timeoutMs).toBe(12_500);
  });

  it('aborts a reasoning stage that exceeds its safe remaining window without another attempt', async () => {
    responsesCreate.mockResolvedValueOnce(response('Question: build. Evidence [1].'));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(() => {}));
    const { operation } = startGeneration();
    const failure = expect(operation).rejects.toMatchObject({ name: 'AbortError', timeoutPhase: 'reasoning' });
    await jest.advanceTimersByTimeAsync(25_500);
    await failure;
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('honors a narrow explicit operator stage cap through Trinity', async () => {
    responsesCreate.mockResolvedValueOnce(response('Question: build. Evidence [1].'));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(() => {}));
    const { operation, allocations } = startGeneration(2_000);
    const failure = expect(operation).rejects.toMatchObject({ name: 'AbortError', timeoutPhase: 'reasoning' });
    await jest.advanceTimersByTimeAsync(2_000);
    await failure;
    expect(allocations.find(entry => entry.stage === 'reasoning')?.timeoutMs).toBe(2_000);
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
  });

  it('reserves downstream stages within a shorter Trinity watchdog after intake elapsed time', async () => {
    responsesCreate.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 5_000)));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(() => {}));
    const { operation, allocations } = startGeneration(undefined, 20_000);
    const failure = expect(operation).rejects.toMatchObject({ name: 'AbortError', timeoutPhase: 'reasoning' });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(allocations.find(entry => entry.stage === 'reasoning')?.timeoutMs).toBe(6_000);
    await jest.advanceTimersByTimeAsync(6_000);
    await failure;
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reflectionTimeoutMs: 3_000, watchdogTimeoutMs: 35_000, reasoningDurationMs: 17_000,
      expectedReasoningTimeoutMs: 17_500, expectedFinalTimeoutMs: 5_500 },
    { reflectionTimeoutMs: 7_000, watchdogTimeoutMs: 30_000, reasoningDurationMs: 8_000,
      expectedReasoningTimeoutMs: 9_000, expectedFinalTimeoutMs: 6_000 }
  ])('preserves final and answer-audit time after $reflectionTimeoutMs ms of critical reflection', async ({
    reflectionTimeoutMs, watchdogTimeoutMs, reasoningDurationMs, expectedReasoningTimeoutMs, expectedFinalTimeoutMs
  }) => {
    process.env.TRINITY_REFLECTION_STAGE_TIMEOUT_MS = String(reflectionTimeoutMs);
    const criticalPrompt = 'Audit my tank setup and threat management in the supported game. '
      + 'Use the grounded starter equipment from the guide. '.repeat(12) + prompt;
    responsesCreate
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 5_000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response(answer, authorityModel)), 5_000)));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reasoning), reasoningDurationMs)));
    reflectionMock.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ content: 'Supported tank setup.' }), reflectionTimeoutMs)));
    const audit = jest.fn(async (text: string) => {
      await new Promise(resolve => setTimeout(resolve, 3_000));
      return { assessment: createGamingClearAssessment({
        profile: 'answer', questionProfile: 'walkthrough', subjectId: 'budget-answer', subjectHash: gamingClearHash(text),
        contextFingerprint: gamingClearContextFingerprint('budget-answer'), evidenceRefs: ['record-1'],
        gates: { identity: 'verified', security: 'verified', compatibility: 'verified', provenance: 'verified',
          claimSupport: 'verified', freshness: 'not_applicable' },
        dimensions: Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
          { status: 'evaluated', score: 5, reasonCodes: ['SUPPORTED'], evidenceRefs: ['record-1'], unresolvedFacts: [] }
        ])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'], findings: []
      }) };
    });
    const { operation, allocations } = startGeneration(undefined, watchdogTimeoutMs, criticalPrompt, audit);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(allocations.filter(entry => ['model-validation', 'intake', 'reasoning'].includes(entry.stage))
      .every(entry => entry.additionalDownstreamReserveMs === reflectionTimeoutMs)).toBe(true);
    expect(allocations.find(entry => entry.stage === 'reasoning')?.timeoutMs).toBe(expectedReasoningTimeoutMs);
    await jest.advanceTimersByTimeAsync(reasoningDurationMs + reflectionTimeoutMs);
    expect(allocations.find(entry => entry.stage === 'final')).toEqual({ stage: 'final',
      timeoutMs: expectedFinalTimeoutMs, elapsedMs: 5_000 + reasoningDurationMs + reflectionTimeoutMs,
      additionalDownstreamReserveMs: 0 });
    await jest.advanceTimersByTimeAsync(8_000);
    const result = await operation;
    expect(result.result).toBe(answer);
    expect(result.fallbackFlag).toBe(false);
    expect(result.tierInfo).toEqual(expect.objectContaining({ tier: 'critical', reflectionApplied: true }));
    expect(result.gamingClearAudit?.decision).toBe('accept');
    expect(reflectionMock).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBeLessThan(100_000 + watchdogTimeoutMs - 1_000);
  });
});
