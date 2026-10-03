import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_GAMING_PIPELINE_TIMEOUT_MS,
  GAMING_EXECUTION_OUTER_HEADROOM_MS,
  GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS,
  resolveGamingExecutionBudget
} from "../src/shared/gaming/gamingExecutionBudgetCore.js";
import { resolveGamingGenerationBudget } from "../src/shared/gaming/gamingGenerationBudgetCore.js";

describe("Gaming provider-backed execution envelope", () => {
  it("keeps one 60s request class around a 50s multi-stage pipeline", () => {
    expect(resolveGamingExecutionBudget()).toEqual({
      mcpOperationTimeoutMs: 60_000,
      pipelineTimeoutMs: 50_000,
      requestRemainingMs: 60_000,
      outerHeadroomMs: 10_000,
      providerDispatchHeadroomMs: 5_000,
      terminalReserveMs: 1_000
    });
  });

  it("clamps a 30s remaining caller to a 20s pipeline", () => {
    const budget = resolveGamingExecutionBudget({ requestRemainingMs: 30_000 });
    expect(budget.mcpOperationTimeoutMs).toBe(30_000);
    expect(budget.pipelineTimeoutMs).toBe(20_000);
    expect(budget.requestRemainingMs).toBe(30_000);
  });

  it("respects both lower module and pipeline operator caps", () => {
    const moduleBound = resolveGamingExecutionBudget({ moduleTimeoutMs: 45_000 });
    expect(moduleBound.mcpOperationTimeoutMs).toBe(45_000);
    expect(moduleBound.pipelineTimeoutMs).toBe(35_000);
    expect(resolveGamingExecutionBudget({ moduleTimeoutMs: 45_000,
      configuredPipelineTimeoutMs: 12_000 }).pipelineTimeoutMs).toBe(12_000);
  });

  it("cannot expand safe request or pipeline limits through larger overrides", () => {
    expect(resolveGamingExecutionBudget({ moduleTimeoutMs: 90_000,
      requestRemainingMs: 120_000, configuredPipelineTimeoutMs: 90_000 })).toMatchObject({
      mcpOperationTimeoutMs: GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS,
      pipelineTimeoutMs: DEFAULT_GAMING_PIPELINE_TIMEOUT_MS,
      requestRemainingMs: 120_000
    });
    expect(resolveGamingExecutionBudget({ moduleTimeoutMs: 40_000,
      requestRemainingMs: 30_000, configuredPipelineTimeoutMs: 60_000 }).pipelineTimeoutMs).toBe(20_000);
  });

  it("reserves outer work from the actual remaining deadline at provider dispatch", () => {
    const budget = resolveGamingExecutionBudget({ requestRemainingMs: 56_000 });
    expect(budget.pipelineTimeoutMs).toBe(46_000);
    expect(budget.outerHeadroomMs).toBe(GAMING_EXECUTION_OUTER_HEADROOM_MS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not create usable time from exhausted or invalid caller budget %s", requestRemainingMs => {
      expect(resolveGamingExecutionBudget({ requestRemainingMs })).toMatchObject({
        mcpOperationTimeoutMs: 0, pipelineTimeoutMs: 0, outerHeadroomMs: 0, terminalReserveMs: 0
      });
    });

  it.each([500, 5_000, 9_999, 10_000])(
    "admits no pipeline when the %sms parent only supplies required outer work", requestRemainingMs => {
      const budget = resolveGamingExecutionBudget({ requestRemainingMs });
      expect(budget.pipelineTimeoutMs).toBe(0);
      expect(budget.mcpOperationTimeoutMs).toBe(requestRemainingMs);
      expect(budget.outerHeadroomMs).toBe(requestRemainingMs);
    });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not turn invalid operator budget %s into an unlimited pipeline", configuredPipelineTimeoutMs => {
      expect(resolveGamingExecutionBudget({ configuredPipelineTimeoutMs }).pipelineTimeoutMs).toBe(0);
      expect(resolveGamingExecutionBudget({ moduleTimeoutMs: configuredPipelineTimeoutMs }).mcpOperationTimeoutMs).toBe(0);
    });

  it("uses the bounded module parent when no caller deadline is available", () => {
    expect(resolveGamingExecutionBudget({ moduleTimeoutMs: 25_000, requestRemainingMs: null }))
      .toMatchObject({ mcpOperationTimeoutMs: 25_000, requestRemainingMs: 25_000, pipelineTimeoutMs: 15_000 });
  });

  it.each([0, 500, 9_999, 10_001, 12_000, 30_000, 60_000, 120_000])(
    "preserves execution and stage parent/reserve invariants with %sms remaining", requestRemainingMs => {
      const execution = resolveGamingExecutionBudget({ requestRemainingMs, configuredPipelineTimeoutMs: 120_000 });
      expect(execution.mcpOperationTimeoutMs).toBeLessThanOrEqual(requestRemainingMs);
      expect(execution.mcpOperationTimeoutMs).toBeLessThanOrEqual(GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS);
      expect(execution.pipelineTimeoutMs + execution.outerHeadroomMs).toBeLessThanOrEqual(execution.mcpOperationTimeoutMs);
      expect(execution.pipelineTimeoutMs).toBeLessThanOrEqual(DEFAULT_GAMING_PIPELINE_TIMEOUT_MS);
      expect(execution.pipelineTimeoutMs).toBeGreaterThanOrEqual(0);
      for (const stage of ["model-validation", "intake", "reasoning", "final", "direct-answer"] as const) {
        const generation = resolveGamingGenerationBudget({ mode: "build", stage,
          pipelineTimeoutMs: execution.pipelineTimeoutMs, requestRemainingMs, configuredStageTimeoutMs: 120_000 });
        expect(generation.effectiveStageTimeoutMs).toBeGreaterThanOrEqual(0);
        expect(generation.effectiveStageTimeoutMs).toBeLessThanOrEqual(
          Math.max(0, generation.generationRemainingMs - generation.downstreamReserveMs));
        if (generation.effectiveStageTimeoutMs > 0) {
          expect(generation.effectiveStageTimeoutMs + generation.downstreamReserveMs)
            .toBeLessThanOrEqual(execution.pipelineTimeoutMs);
          expect(generation.effectiveStageTimeoutMs + execution.terminalReserveMs)
            .toBeLessThanOrEqual(execution.pipelineTimeoutMs);
        }
      }
    });
});
