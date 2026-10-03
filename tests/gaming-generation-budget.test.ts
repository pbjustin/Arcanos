import { afterEach, describe, expect, it } from '@jest/globals';
import {
  GAMING_GENERATION_ANSWER_AUDIT_RESERVE_MS, GAMING_GENERATION_FINAL_STAGE_RESERVE_MS,
  GAMING_GENERATION_TERMINAL_HEADROOM_MS, getGamingConfiguredStageTimeoutMs,
  getGamingPipelineTimeoutMs, resolveGamingGenerationBudget
} from '../src/services/gamingConfig.js';

const envKeys = ['ARCANOS_GAMING_STAGE_TIMEOUT_MS', 'ARCANOS_GAMING_BUILD_STAGE_TIMEOUT_MS',
  'ARCANOS_GAMING_PIPELINE_TIMEOUT_MS', 'ARCANOS_GAMING_BUILD_PIPELINE_TIMEOUT_MS'] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of envKeys) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe('Gaming reusable generation allocation', () => {
  it.each(['guide', 'build', 'meta'] as const)('uses remaining time for %s reasoning and reserves final/audit/terminal time', mode => {
    const budget = resolveGamingGenerationBudget({ mode, stage: 'reasoning', pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 5_000, runtimeRemainingMs: 29_500 });
    expect(budget.effectiveStageTimeoutMs).toBe(20_500);
    expect(budget.effectiveStageTimeoutMs).toBeGreaterThan(12_000);
    expect(budget.downstreamReserveMs).toBe(GAMING_GENERATION_FINAL_STAGE_RESERVE_MS
      + GAMING_GENERATION_ANSWER_AUDIT_RESERVE_MS + GAMING_GENERATION_TERMINAL_HEADROOM_MS);
    expect(budget.effectiveStageTimeoutMs).toBeLessThan(budget.generationRemainingMs);
  });

  it('retains explicit narrow operator caps', () => {
    expect(resolveGamingGenerationBudget({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 5_000, configuredStageTimeoutMs: 2_000 }).effectiveStageTimeoutMs).toBe(2_000);
  });

  it('retains final, audit and terminal time after pending reflection within a shorter watchdog', () => {
    const budget = resolveGamingGenerationBudget({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 5_000, runtimeRemainingMs: 25_000, additionalDownstreamReserveMs: 7_000 });
    expect(budget.downstreamReserveMs).toBe(16_000);
    expect(budget.effectiveStageTimeoutMs).toBe(9_000);
  });

  it('clamps even an explicit large cap to a shorter parent request deadline', () => {
    const budget = resolveGamingGenerationBudget({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
      requestRemainingMs: 12_000, configuredStageTimeoutMs: 50_000 });
    expect(budget.generationRemainingMs).toBe(11_000);
    expect(budget.effectiveStageTimeoutMs).toBe(2_000);
  });

  it('does not dispatch a stage when required headroom exhausts the usable deadline', () => {
    expect(resolveGamingGenerationBudget({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
      requestRemainingMs: 9_000 }).effectiveStageTimeoutMs).toBe(0);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, 0, -1])('does not turn invalid budget %s into an unbounded stage', pipelineTimeoutMs => {
    expect(resolveGamingGenerationBudget({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs }).effectiveStageTimeoutMs).toBe(0);
  });

  it('reserves audit and terminal time after the final model stage', () => {
    const budget = resolveGamingGenerationBudget({ mode: 'guide', stage: 'final', pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 25_500 });
    expect(budget.effectiveStageTimeoutMs).toBe(5_000);
    expect(budget.downstreamReserveMs).toBe(4_000);
  });

  it('uses mode then generic override precedence and clamps pipeline limits to parent headroom', () => {
    process.env.ARCANOS_GAMING_STAGE_TIMEOUT_MS = '4000';
    process.env.ARCANOS_GAMING_BUILD_STAGE_TIMEOUT_MS = '2000';
    process.env.ARCANOS_GAMING_PIPELINE_TIMEOUT_MS = '40000';
    process.env.ARCANOS_GAMING_BUILD_PIPELINE_TIMEOUT_MS = '30000';
    expect(getGamingConfiguredStageTimeoutMs('build')).toBe(2_000);
    expect(getGamingConfiguredStageTimeoutMs('meta')).toBe(4_000);
    expect(getGamingPipelineTimeoutMs('build', null)).toBe(30_000);
    expect(getGamingPipelineTimeoutMs('build', 20_000)).toBe(19_000);
  });
});
