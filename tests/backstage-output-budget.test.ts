import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_EXTENDED_OUTPUT_STAGE_FULL_MS,
  BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_MS,
  BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_MS,
  BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX,
  BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_DEFAULT,
  buildBackstageOutputBudgetCompletionInstruction,
  buildBackstageOutputBudgetTelemetry,
  resolveBackstageOutputBudget,
  type BackstageOutputBudgetInput,
} from '../src/shared/backstage/backstageOutputBudget.js';

const HEAVY_QUEUED_INPUT: BackstageOutputBudgetInput = {
  action: 'generateBooking',
  profile: 'queued_generation',
  requestedFormat: 'structured_booking',
  requestedTokenLimit: 2_400,
  promptCodeUnits: 1_200,
  retrievedContextCodeUnits: 6_000,
  expectedOutputWords: 1_000,
  model: 'gpt-5.1',
  modelStageTimeoutMs: 80_000,
};

describe('Backstage workload-aware output budget', () => {
  it('gives production-sized queued generation a larger finite budget', () => {
    expect(resolveBackstageOutputBudget(HEAVY_QUEUED_INPUT)).toMatchObject({
      budgetClass: 'queued_extended',
      reason: 'queued_structured_generation',
      modelCapability: 'extended_gpt5',
      tokenLimit: BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_DEFAULT,
      tokenCap: BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_DEFAULT,
    });
  });

  it('keeps continuity queries on their smaller historical budget', () => {
    expect(resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      action: 'queryContinuity',
      profile: 'continuity_sync',
      requestedFormat: 'continuity',
      requestedTokenLimit: 99_999,
    })).toMatchObject({
      budgetClass: 'continuity_small',
      reason: 'continuity_profile',
      tokenLimit: 900,
      tokenCap: 2_400,
    });
  });

  it.each([
    ['bounded synchronous generation', {
      ...HEAVY_QUEUED_INPUT,
      profile: 'bounded_sync_generation' as const,
    }, 2_400],
    ['compact direct output', {
      ...HEAVY_QUEUED_INPUT,
      requestedFormat: 'compact_direct' as const,
      requestedTokenLimit: 400,
    }, 400],
    ['bounded review output', {
      ...HEAVY_QUEUED_INPUT,
      requestedFormat: 'bounded_review' as const,
      requestedTokenLimit: 1_600,
    }, 1_600],
  ])('does not enlarge %s', (_label, input, expectedTokenLimit) => {
    expect(resolveBackstageOutputBudget(input)).toMatchObject({
      budgetClass: 'bounded_request',
      tokenLimit: expectedTokenLimit,
      tokenCap: 2_400,
    });
  });

  it('cannot exceed the application-wide finite maximum', () => {
    expect(resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      configuredWorkerTokenLimit: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({
      tokenLimit: BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX,
      tokenCap: BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX,
    });
  });

  it('does not let a queued worker configuration recreate the 2,400-token cap', () => {
    expect(resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      configuredWorkerTokenLimit: 2_400,
    })).toMatchObject({
      budgetClass: 'queued_extended',
      tokenLimit: 4_000,
      tokenCap: 4_000,
    });
  });

  it('switches deterministically at the production-workload boundary', () => {
    const belowBoundary = resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      promptCodeUnits: 1_199,
      retrievedContextCodeUnits: 5_999,
      expectedOutputWords: 499,
    });
    const atBoundary = resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      promptCodeUnits: 1_200,
      retrievedContextCodeUnits: 5_999,
      expectedOutputWords: 499,
    });

    expect(belowBoundary).toMatchObject({
      budgetClass: 'queued_extended',
      tokenLimit: 4_000,
      tokenCap: 4_000,
    });
    expect(atBoundary).toMatchObject({
      budgetClass: 'queued_extended',
      tokenLimit: 6_000,
    });
    expect(resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      promptCodeUnits: 1_200,
      retrievedContextCodeUnits: 5_999,
      expectedOutputWords: 499,
    })).toEqual(atBoundary);
  });

  it.each([
    [BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_MS - 1, 2_400],
    [BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_MS, 4_000],
    [BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_MS - 1, 4_000],
    [BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_MS, 5_000],
    [BACKSTAGE_EXTENDED_OUTPUT_STAGE_FULL_MS - 1, 5_000],
    [BACKSTAGE_EXTENDED_OUTPUT_STAGE_FULL_MS, 6_000],
  ])('honors the finite stage-time boundary at %i ms', (modelStageTimeoutMs, tokenLimit) => {
    expect(resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      modelStageTimeoutMs,
    }).tokenLimit).toBe(tokenLimit);
  });

  it('fails safely to the established cap for an unsupported model family', () => {
    expect(resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      model: 'provider-model-with-unknown-token-contract',
    })).toMatchObject({
      budgetClass: 'bounded_request',
      reason: 'unsupported_extended_model',
      modelCapability: 'baseline_fallback',
      tokenLimit: 2_400,
      tokenCap: 2_400,
    });
  });

  it('emits only closed metadata and bounded counts in telemetry', () => {
    const privateModelMarker = 'PRIVATE-MODEL-SENTINEL';
    const decision = resolveBackstageOutputBudget({
      ...HEAVY_QUEUED_INPUT,
      model: privateModelMarker,
    });
    const serializedTelemetry = JSON.stringify(
      buildBackstageOutputBudgetTelemetry(decision)
    );

    expect(serializedTelemetry).not.toContain(privateModelMarker);
    expect(buildBackstageOutputBudgetTelemetry(decision)).toMatchObject({
      modelCapability: 'baseline_fallback',
      promptCodeUnits: 1_200,
      retrievedContextCodeUnits: 6_000,
      tokenLimit: 2_400,
    });
  });

  it('builds a server-owned instruction requiring complete bounded output', () => {
    const instruction = buildBackstageOutputBudgetCompletionInstruction({
      tokenLimit: 6_000,
    });

    expect(instruction).toContain('<<BACKSTAGE_OUTPUT_BUDGET>>');
    expect(instruction).toContain('within 6000 output tokens');
    expect(instruction).toContain('Return no partial draft');
  });
});
