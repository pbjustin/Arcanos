import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const budget = await import('../src/shared/gaming/gamingGenerationBudgetCore.js');
const recovery = await import('../src/shared/gaming/gamingRecoveryResponse.js');
const allocate = jest.fn(budget.resolveGamingGenerationBudget);
const classifyFailure = jest.fn(recovery.resolveGamingGenerationFailureReason);
const classifyRecovery = jest.fn(recovery.resolveGamingRecoveryClass);
const recoveryResponse = jest.fn(recovery.buildGamingRecoveryResponse);
jest.unstable_mockModule('../src/shared/gaming/gamingGenerationBudgetCore.js', () => ({
  ...budget, resolveGamingGenerationBudget: allocate
}));
jest.unstable_mockModule('../src/shared/gaming/gamingRecoveryResponse.js', () => ({
  ...recovery, resolveGamingGenerationFailureReason: classifyFailure,
  resolveGamingRecoveryClass: classifyRecovery, buildGamingRecoveryResponse: recoveryResponse
}));
const {
  assertGamingGenerationBudgetPreviewFixture, GAMING_GENERATION_BUDGET_PREVIEW_VERSION
} = await import('../src/shared/gaming/gamingGenerationBudgetPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_GENERATION_BUDGET_CONTRACT_INVALID';

describe('sealed Gaming generation budget production-policy proof', () => {
  beforeEach(() => {
    allocate.mockReset().mockImplementation(budget.resolveGamingGenerationBudget);
    classifyFailure.mockReset().mockImplementation(recovery.resolveGamingGenerationFailureReason);
    classifyRecovery.mockReset().mockImplementation(recovery.resolveGamingRecoveryClass);
    recoveryResponse.mockReset().mockImplementation(recovery.buildGamingRecoveryResponse);
  });

  it('repeats the fixed production allocation and recovery corpus without caller input or clocks', () => {
    expect(assertGamingGenerationBudgetPreviewFixture).not.toThrow();
    expect(assertGamingGenerationBudgetPreviewFixture).not.toThrow();
    expect(GAMING_GENERATION_BUDGET_PREVIEW_VERSION).toBe('gaming-generation-budget/v1');
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'guide', stage: 'intake' }));
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'meta', stage: 'reasoning', pipelineElapsedMs: 5_000 }));
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ stage: 'direct-answer', pipelineTimeoutMs: 9_000 }));
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ stage: 'reasoning', additionalDownstreamReserveMs: 7_000 }));
    expect(classifyFailure).toHaveBeenCalledWith({ fallbackReason: 'INTAKE_UPSTREAM_TIMEOUT', evidenceSelected: true });
    expect(classifyFailure).toHaveBeenCalledWith({ fallbackReason: 'PROVIDER_COMPLETION_INCOMPLETE', evidenceSelected: true });
    expect(classifyRecovery).toHaveBeenCalledWith(expect.objectContaining({ sourceKnown: true, evidenceSelected: false, timedOut: true }));
  });

  it('withholds proof when reasoning is still capped at the former 12-second default', () => {
    allocate.mockImplementation(input => {
      const result = budget.resolveGamingGenerationBudget(input);
      return input.stage === 'reasoning' && input.configuredStageTimeoutMs === undefined
        ? { ...result, effectiveStageTimeoutMs: Math.min(12_000, result.effectiveStageTimeoutMs) } : result;
    });
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when guide intake loses its mode-specific default', () => {
    allocate.mockImplementation(input => budget.resolveGamingGenerationBudget({ ...input, mode: 'build' }));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it.each(['request', 'runtime', 'operator'] as const)('withholds proof when a %s cap is ignored', cap => {
    allocate.mockImplementation(input => budget.resolveGamingGenerationBudget({ ...input,
      ...(cap === 'request' ? { requestRemainingMs: null } : cap === 'runtime'
        ? { runtimeRemainingMs: undefined } : { configuredStageTimeoutMs: undefined }) }));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when short direct answers reserve an unused final generation stage', () => {
    allocate.mockImplementation(input => budget.resolveGamingGenerationBudget({ ...input,
      stage: input.stage === 'direct-answer' ? 'intake' : input.stage }));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when pending critical reflection consumes final-stage reserves', () => {
    allocate.mockImplementation(input => budget.resolveGamingGenerationBudget({ ...input, additionalDownstreamReserveMs: 0 }));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when final generation omits answer-audit and terminal reserves', () => {
    allocate.mockImplementation(input => {
      const result = budget.resolveGamingGenerationBudget(input);
      return input.stage === 'final' ? { ...result, effectiveStageTimeoutMs: result.generationRemainingMs, downstreamReserveMs: 0 } : result;
    });
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when exhausted or invalid pipelines become unbounded stages', () => {
    allocate.mockImplementation(input => {
      const result = budget.resolveGamingGenerationBudget(input);
      return !Number.isFinite(input.pipelineTimeoutMs) ? { ...result, effectiveStageTimeoutMs: Number.POSITIVE_INFINITY } : result;
    });
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when a known source is treated as selected timeout evidence', () => {
    classifyFailure.mockImplementation(input => input.fallbackReason === 'INTAKE_UPSTREAM_TIMEOUT'
      ? 'PROVIDER_TIMEOUT_WITH_EVIDENCE' : recovery.resolveGamingGenerationFailureReason(input));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when incomplete output is mislabeled as provider timeout', () => {
    classifyFailure.mockImplementation(input => input.fallbackReason === 'PROVIDER_COMPLETION_INCOMPLETE'
      ? 'PROVIDER_TIMEOUT_WITH_EVIDENCE' : recovery.resolveGamingGenerationFailureReason(input));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when selected evidence is lost from timeout recovery', () => {
    classifyRecovery.mockImplementation(input => input.evidenceSelected && input.timedOut
      ? 'provider_timeout_without_evidence' : recovery.resolveGamingRecoveryClass(input));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when recovery invents gameplay actions', () => {
    recoveryResponse.mockImplementation(input => `${recovery.buildGamingRecoveryResponse(input)} Upgrade your gear and stock healing items.`);
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof when a non-timeout failure receives timeout text', () => {
    recoveryResponse.mockImplementation(input => recovery.buildGamingRecoveryResponse({ ...input, timedOut: true }));
    expect(assertGamingGenerationBudgetPreviewFixture).toThrow(FAILURE);
  });

  it('returns only the fixed failure after an unexpected production-seam exception', () => {
    allocate.mockImplementation(() => { throw new Error('private-preview-budget-sentinel'); });
    let failure: unknown;
    try { assertGamingGenerationBudgetPreviewFixture(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain('private-preview-budget-sentinel');
  });
});
