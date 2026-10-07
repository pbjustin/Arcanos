import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TrinityRunOptions } from '../src/core/logic/trinityTypes.js';
import { GAMING_HYBRID_INTAKE } from '../src/shared/gaming/gamingGuideIntakeCore.js';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { resolveGamingGenerationBudget } from '../src/services/gamingConfig.js';
import { resolveGamingExecutionBudget } from '../src/shared/gaming/gamingExecutionBudgetCore.js';

const responsesCreate = jest.fn();
const runStructuredReasoning = jest.fn();
const reflectionMock = jest.fn();
const modelsRetrieve = jest.fn();
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
const { detectTier } = await import('../src/core/logic/trinityTier.js');
const { createRuntimeBudgetWithLimit, getSafeRemainingMs } = await import('../src/platform/resilience/runtimeBudget.js');
const { createAbortError, getRequestAbortSignal, runWithRequestAbortTimeout } = await import('@arcanos/runtime');
const { runGamingClearAnswerAudit } = await import('../src/services/gamingClearAnswerAudit.js');
const client = { models: { retrieve: modelsRetrieve },
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
  generationPrompt = prompt, gamingClearAnswerAudit?: TrinityRunOptions['gamingClearAnswerAudit'],
  executionBudget?: ReturnType<typeof resolveGamingExecutionBudget>, compactIntake = true, directAnswer = false) {
  const pipelineTimeoutMs = executionBudget?.pipelineTimeoutMs ?? 35_000;
  const runtimeBudget = createRuntimeBudgetWithLimit(pipelineTimeoutMs, 500);
  const allocations: { stage: string; timeoutMs: number; elapsedMs: number; additionalDownstreamReserveMs: number }[] = [];
  const stageBudgets: ({ stage: string } & ReturnType<typeof resolveGamingGenerationBudget>)[] = [];
  const runOptions: TrinityRunOptions = {
    ...(compactIntake ? { gamingGuideIntakePolicy: 'compact-v1' as const } : {}),
    intentMode: 'EXECUTE_TASK', answerMode: directAnswer ? 'direct' : 'explained',
    disableOptionalSideEffects: true, redactAuditContent: true, watchdogModelTimeoutMs: watchdogTimeoutMs,
    modelStageTimeoutMs: 12_000, toolBackedCapabilities: { verifyProvidedData: true },
    ...(gamingClearAnswerAudit ? { gamingClearAnswerAudit } : {}),
    resolveModelStageTimeoutMs: (stage, budget, remainingWatchdogMs, additionalDownstreamReserveMs = 0) => {
      const elapsedMs = Date.now() - budget.startedAt;
      const allocation = resolveGamingGenerationBudget({ mode: 'build', stage, pipelineTimeoutMs,
        pipelineElapsedMs: elapsedMs, runtimeRemainingMs: Math.min(getSafeRemainingMs(budget), remainingWatchdogMs),
        ...(executionBudget ? { requestRemainingMs: executionBudget.requestRemainingMs - elapsedMs } : {}),
        configuredStageTimeoutMs, additionalDownstreamReserveMs });
      const timeoutMs = allocation.effectiveStageTimeoutMs;
      allocations.push({ stage, timeoutMs, elapsedMs, additionalDownstreamReserveMs });
      stageBudgets.push({ stage, ...allocation });
      if (timeoutMs <= 0) throw Object.assign(createAbortError('Budget exhausted.'), { timeoutPhase: stage });
      return timeoutMs;
    }
  };
  const runPipeline = () => runWithRequestAbortTimeout({ timeoutMs: pipelineTimeoutMs,
    parentSignal: getRequestAbortSignal() }, () => runTrinityWritingPipeline({
    input: { prompt: generationPrompt, moduleId: 'ARCANOS:GAMING',
      sourceEndpoint: compactIntake ? 'arcanos-gaming.hybrid-build' : 'arcanos-gaming.build',
      requestedAction: 'query', body: { mode: 'build', prompt: generationPrompt,
        ...(compactIntake ? { [GAMING_HYBRID_INTAKE]: true } : {}) } },
    context: { client, runtimeBudget, runOptions }
  }));
  const operation = executionBudget
    ? runWithRequestAbortTimeout({ timeoutMs: executionBudget.mcpOperationTimeoutMs }, runPipeline)
    : runPipeline();
  return { operation, allocations, stageBudgets };
}

function createAcceptedAnswerAudit() {
  return jest.fn(async (text: string) => {
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
    modelsRetrieve.mockReset().mockResolvedValue({ id: 'gpt-6-luna' });
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
    { path: 'compact hybrid', compactIntake: true, directAnswer: false, watchdogTimeoutMs: 20_000 },
    { path: 'ordinary Gaming', compactIntake: false, directAnswer: false, watchdogTimeoutMs: 20_000 },
    { path: 'direct Gaming', compactIntake: false, directAnswer: true, watchdogTimeoutMs: 20_000 },
    { path: 'compact hybrid', compactIntake: true, directAnswer: false, watchdogTimeoutMs: 35_000 },
    { path: 'ordinary Gaming', compactIntake: false, directAnswer: false, watchdogTimeoutMs: 35_000 },
    { path: 'direct Gaming', compactIntake: false, directAnswer: true, watchdogTimeoutMs: 35_000 }
  ])('respects a $watchdogTimeoutMs ms watchdog during mandatory $path answer audit', async ({ compactIntake, directAnswer, watchdogTimeoutMs }) => {
    const startedAt = Date.now();
    const evidenceRefs = ['record-1'];
    const dimensions = Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
      { status: 'evaluated', score: 5, reasonCodes: ['SUPPORTED'], evidenceRefs, unresolvedFacts: [] }
    ])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
    const evidenceAssessment = createGamingClearAssessment({
      profile: 'evidence', questionProfile: 'walkthrough', subjectId: 'selected-evidence', subjectHash: gamingClearHash(prompt),
      contextFingerprint: gamingClearContextFingerprint('selected-evidence'), evidenceRefs,
      gates: { identity: 'verified', security: 'verified', compatibility: 'verified', provenance: 'verified',
        claimSupport: 'verified', freshness: 'not_applicable' }, dimensions, findings: []
    });
    const knowledge = { context: prompt,
      sources: [{ sourceId: 'source-1', url: 'https://example.com/starter-guide', sourceType: 'guide',
        game: 'Fixture Quest', fetchedAt: '2026-10-04T00:00:00.000Z', snippet: 'Use the supported starter equipment.' }],
      evidence: [{ sourceId: 'source-1', revisionId: 'revision-1', recordId: 'record-1', recordType: 'guide' as const,
        publicUrl: 'https://example.com/starter-guide', text: 'Use the supported starter equipment.', lexicalScore: 1, combinedScore: 1,
        provenance: { fetchedAt: '2026-10-04T00:00:00.000Z' } }] };
    if (directAnswer) responsesCreate
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response(answer, authorityModel)), 15_500)));
    else responsesCreate
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 3_000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response(answer, authorityModel)), 5_500)));
    responsesCreate.mockImplementationOnce((_payload: unknown, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response(JSON.stringify({ dimensions, findings: [] }))), 5_000);
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        }, { once: true });
      }));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reasoning), 7_000)));
    const audit = jest.fn((text: string, runtimeBudget: Parameters<typeof runGamingClearAnswerAudit>[2], remainingWatchdogMs?: number) =>
      runGamingClearAnswerAudit(client, { game: 'Fixture Quest', prompt: 'How do I use the supported starter equipment?',
        mode: 'guide', answer: text, knowledge, evidenceAssessment }, runtimeBudget, 'routine', remainingWatchdogMs));
    const { operation } = startGeneration(undefined, watchdogTimeoutMs, prompt, audit, undefined, compactIntake, directAnswer);
    await jest.advanceTimersByTimeAsync(20_500);
    const result = await operation;
    expect(result.gamingClearAudit).toMatchObject(watchdogTimeoutMs === 20_000
      ? { assessmentStatus: 'unavailable', decision: 'unavailable', findings: [expect.objectContaining({ code: 'AUDIT_TIMEOUT' })] }
      : { assessmentStatus: 'completed', decision: 'accept' });
    expect(result.guardInfo).toMatchObject({ effectiveLimit: Math.min(watchdogTimeoutMs, 34_500),
      elapsedMs: watchdogTimeoutMs === 20_000 ? 19_000 : 20_500 });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledTimes(directAnswer ? 2 : 3);
    expect(responsesCreate.mock.calls[directAnswer ? 1 : 2][1]).toMatchObject({ timeout: watchdogTimeoutMs === 20_000 ? 3_500 : 12_000, maxRetries: 0 });
    expect(startedAt + result.guardInfo!.elapsedMs).toBeLessThan(startedAt + watchdogTimeoutMs);
  });

  it('completes the live 17,317ms reasoning shape and a 12-second final with bounded answer audit', async () => {
    // Expire the shared model-validation cache so this trace includes real validation dispatch.
    jest.setSystemTime(1_000_000);
    const startedAt = Date.now();
    const executionBudget = resolveGamingExecutionBudget({});
    expect(executionBudget.mcpOperationTimeoutMs).toBe(60_000);
    expect(executionBudget.pipelineTimeoutMs).toBe(50_000);
    modelsRetrieve.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ id: 'gpt-6-luna' }), 500)));
    responsesCreate
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 4_000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response(answer, authorityModel)), 12_000)));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reasoning), 17_317)));
    const audit = createAcceptedAnswerAudit();
    const { operation, allocations, stageBudgets } = startGeneration(undefined, executionBudget.pipelineTimeoutMs,
      prompt, audit, executionBudget);
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });

    await jest.advanceTimersByTimeAsync(500 + 4_000);
    expect(modelsRetrieve).toHaveBeenCalledTimes(1);
    expect(allocations.find(entry => entry.stage === 'reasoning')).toMatchObject({
      elapsedMs: 4_500, timeoutMs: 36_000
    });
    await jest.advanceTimersByTimeAsync(17_317);
    expect(allocations.find(entry => entry.stage === 'final')).toMatchObject({
      elapsedMs: 21_817, timeoutMs: 23_683
    });
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(8_515);
    expect(settled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(12_000 - 8_515);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(3_000);

    const result = await operation;
    expect(result.result).toBe(answer);
    expect(result.fallbackFlag).toBe(false);
    expect(result.gamingClearAudit?.decision).toBe('accept');
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(reflectionMock).not.toHaveBeenCalled();
    expect(stageBudgets.every(budget => budget.effectiveStageTimeoutMs > 0
      && budget.effectiveStageTimeoutMs <= budget.generationRemainingMs - budget.downstreamReserveMs)).toBe(true);
    expect(stageBudgets.find(budget => budget.stage === 'final')?.downstreamReserveMs).toBe(4_000);
    expect(Date.now() - startedAt).toBe(36_817);
    expect(Date.now() - startedAt).toBeLessThan(executionBudget.pipelineTimeoutMs - executionBudget.terminalReserveMs);
    expect(executionBudget.mcpOperationTimeoutMs).toBeGreaterThanOrEqual(
      executionBudget.pipelineTimeoutMs + executionBudget.outerHeadroomMs);
  });

  it('clamps the live trace to a caller with only 30 seconds and aborts before its deadline', async () => {
    jest.setSystemTime(2_000_000);
    const startedAt = Date.now();
    const executionBudget = resolveGamingExecutionBudget({ requestRemainingMs: 30_000 });
    expect(executionBudget.mcpOperationTimeoutMs).toBe(30_000);
    expect(executionBudget.pipelineTimeoutMs).toBe(20_000);
    modelsRetrieve.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ id: 'gpt-6-luna' }), 500)));
    responsesCreate.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 4_000)));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reasoning), 17_317)));
    const audit = createAcceptedAnswerAudit();
    const { operation, allocations, stageBudgets } = startGeneration(undefined, executionBudget.pipelineTimeoutMs,
      prompt, audit, executionBudget);
    const failure = expect(operation).rejects.toMatchObject({ name: 'AbortError', timeoutPhase: 'reasoning' });

    await jest.advanceTimersByTimeAsync(4_500);
    expect(allocations.find(entry => entry.stage === 'reasoning')).toMatchObject({
      elapsedMs: 4_500, timeoutMs: 6_000
    });
    await jest.advanceTimersByTimeAsync(6_000);
    await failure;
    expect(Date.now() - startedAt).toBe(10_500);
    expect(Date.now() - startedAt).toBeLessThan(executionBudget.requestRemainingMs);
    expect(stageBudgets.every(budget => budget.effectiveStageTimeoutMs > 0
      && budget.effectiveStageTimeoutMs <= budget.generationRemainingMs - budget.downstreamReserveMs)).toBe(true);
    expect(allocations.some(entry => entry.stage === 'final' || entry.stage === 'direct-answer')).toBe(false);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    { path: 'compact hybrid', compactIntake: true, failure: 'timeout' },
    { path: 'compact hybrid', compactIntake: true, failure: 'rejection' },
    { path: 'ordinary Gaming', compactIntake: false, failure: 'timeout' },
    { path: 'ordinary Gaming', compactIntake: false, failure: 'rejection' }
  ])('does not rerun $path generation or repair after mandatory answer-audit $failure', async ({ compactIntake, failure }) => {
    const evidenceRefs = ['record-1'];
    const dimensions = Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
      { status: 'evaluated', score: 5, reasonCodes: ['SUPPORTED'], evidenceRefs, unresolvedFacts: [] }
    ])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
    const evidenceAssessment = createGamingClearAssessment({
      profile: 'evidence', questionProfile: 'walkthrough', subjectId: 'selected-evidence', subjectHash: gamingClearHash(prompt),
      contextFingerprint: gamingClearContextFingerprint('selected-evidence'), evidenceRefs,
      gates: { identity: 'verified', security: 'verified', compatibility: 'verified', provenance: 'verified',
        claimSupport: 'verified', freshness: 'not_applicable' }, dimensions, findings: []
    });
    const knowledge = { context: prompt,
      sources: [{ sourceId: 'source-1', url: 'https://example.com/starter-guide', sourceType: 'guide',
        game: 'Fixture Quest', fetchedAt: '2026-10-04T00:00:00.000Z', snippet: 'Use the supported starter equipment.' }],
      evidence: [{ sourceId: 'source-1', revisionId: 'revision-1', recordId: 'record-1', recordType: 'guide' as const,
        publicUrl: 'https://example.com/starter-guide', text: 'Use the supported starter equipment.', lexicalScore: 1, combinedScore: 1,
        provenance: { fetchedAt: '2026-10-04T00:00:00.000Z' } }] };
    responsesCreate.mockResolvedValueOnce(response('Question: build. Evidence [1].'))
      .mockResolvedValueOnce(response(answer, authorityModel));
    runStructuredReasoning.mockResolvedValueOnce(reasoning);
    if (failure === 'timeout') responsesCreate.mockRejectedValueOnce(createAbortError('synthetic answer-audit timeout'));
    else responsesCreate.mockResolvedValueOnce(response(JSON.stringify({ dimensions,
      findings: [{ code: 'UNSUPPORTED_MECHANIC', severity: 'blocking', evidenceRefs }] })));
    const audit = jest.fn((text: string, runtimeBudget: Parameters<typeof runGamingClearAnswerAudit>[2]) =>
      runGamingClearAnswerAudit(client, { game: 'Fixture Quest', prompt: 'How do I use the supported starter equipment?',
        mode: 'guide', answer: text, knowledge, evidenceAssessment }, runtimeBudget));
    const { operation, allocations } = startGeneration(undefined, 35_000, prompt, audit, undefined, compactIntake);
    await jest.advanceTimersByTimeAsync(0);
    const result = await operation;
    expect(result.result).toBe(audit.mock.calls[0][0]);
    expect(result.result.replace(/\s+/gu, ' ')).toBe(answer);
    expect(result.fallbackFlag).toBe(false);
    expect(result.gamingClearAudit).toMatchObject(failure === 'timeout'
      ? { assessmentStatus: 'unavailable', findings: [expect.objectContaining({ code: 'AUDIT_TIMEOUT' })] }
      : { assessmentStatus: 'completed', decision: 'reject', findings: [expect.objectContaining({ code: 'UNSUPPORTED_MECHANIC' })] });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledTimes(3); // One intake, one final, one audit.
    expect(responsesCreate.mock.calls[2][1]).toMatchObject({ maxRetries: 0 });
    expect(reflectionMock).not.toHaveBeenCalled(); // The legacy ledger audit cannot replace the failed answer audit.
    expect(allocations.filter(entry => entry.stage === 'final')).toHaveLength(1);
    expect(allocations.some(entry => entry.stage === 'direct-answer')).toBe(false);
  });

  it.each([
    { path: 'compact hybrid', compactIntake: true, traceStartMs: 3_000_000 },
    { path: 'ordinary Gaming', compactIntake: false, traceStartMs: 4_000_000 }
  ])('times out $path final beyond its complete safe allocation with no recovery attempt', async ({ compactIntake, traceStartMs }) => {
    jest.setSystemTime(traceStartMs);
    expect(detectTier(prompt)).toBe('simple');
    const startedAt = Date.now();
    const executionBudget = resolveGamingExecutionBudget({});
    modelsRetrieve.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ id: 'gpt-6-luna' }), 500)));
    responsesCreate
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response('Question: build. Evidence [1].')), 4_000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(response(answer, authorityModel)), 25_000)));
    runStructuredReasoning.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reasoning), 17_317)));
    const audit = createAcceptedAnswerAudit();
    const { operation, allocations } = startGeneration(undefined, executionBudget.pipelineTimeoutMs,
      prompt, audit, executionBudget, compactIntake);
    const failure = expect(operation).rejects.toMatchObject({ name: 'AbortError', timeoutPhase: 'final' });

    await jest.advanceTimersByTimeAsync(500 + 4_000 + 17_317);
    const finalBudget = allocations.find(entry => entry.stage === 'final')?.timeoutMs;
    expect(finalBudget).toBe(23_683);
    await jest.advanceTimersByTimeAsync(finalBudget!);
    await failure;
    expect(Date.now() - startedAt).toBe(45_500);
    expect(Date.now() - startedAt).toBeLessThan(executionBudget.pipelineTimeoutMs - executionBudget.terminalReserveMs);
    expect(allocations.filter(entry => entry.stage === 'final')).toHaveLength(1);
    expect(allocations.some(entry => entry.stage === 'direct-answer')).toBe(false);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(runStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
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
    const audit = createAcceptedAnswerAudit();
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
