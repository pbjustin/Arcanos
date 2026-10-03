import { resolveGamingGenerationBudget } from './gamingGenerationBudgetCore.js';
import { resolveGamingExecutionBudget } from './gamingExecutionBudgetCore.js';
import {
  buildGamingRecoveryResponse, resolveGamingGenerationFailureReason, resolveGamingRecoveryClass,
  type GamingRecoveryInput
} from './gamingRecoveryResponse.js';

export const GAMING_GENERATION_BUDGET_PREVIEW_VERSION = 'gaming-generation-budget/v1';
export const GAMING_EXECUTION_BUDGET_PREVIEW_VERSION = 'gaming-execution-budget/v1';
const FAILURE = 'PREVIEW_GAMING_GENERATION_BUDGET_CONTRACT_INVALID';

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireAllocation(
  input: Parameters<typeof resolveGamingGenerationBudget>[0],
  timeoutMs: number,
  remainingMs: number,
  reserveMs: number
): void {
  const allocation = resolveGamingGenerationBudget(input);
  requireProof(allocation.effectiveStageTimeoutMs === timeoutMs);
  requireProof(allocation.generationRemainingMs === remainingMs);
  requireProof(allocation.downstreamReserveMs === reserveMs);
  requireProof(Number.isFinite(allocation.effectiveStageTimeoutMs) && allocation.effectiveStageTimeoutMs >= 0);
  requireProof(allocation.effectiveStageTimeoutMs <= Math.max(0, remainingMs - reserveMs));
}

function requireExecutionBudget(
  input: Parameters<typeof resolveGamingExecutionBudget>[0],
  operationMs: number,
  pipelineMs: number,
  callerRemainingMs: number,
  outerHeadroomMs = 10_000
): ReturnType<typeof resolveGamingExecutionBudget> {
  const execution = resolveGamingExecutionBudget(input);
  requireProof(execution.mcpOperationTimeoutMs === operationMs);
  requireProof(execution.pipelineTimeoutMs === pipelineMs);
  requireProof(execution.requestRemainingMs === callerRemainingMs);
  requireProof(execution.outerHeadroomMs === outerHeadroomMs);
  requireProof(execution.providerDispatchHeadroomMs === Math.min(5_000, outerHeadroomMs));
  requireProof(execution.terminalReserveMs === Math.min(1_000, pipelineMs));
  requireProof(Number.isFinite(operationMs) && operationMs >= 0 && operationMs <= 60_000);
  requireProof(Number.isFinite(pipelineMs) && pipelineMs >= 0 && pipelineMs <= 50_000);
  requireProof(pipelineMs + outerHeadroomMs <= operationMs);
  requireProof(operationMs <= callerRemainingMs);
  return execution;
}

function requireExecutionEnvelope(): void {
  requireExecutionBudget({}, 60_000, 50_000, 60_000);
  requireExecutionBudget({ requestRemainingMs: 30_000 }, 30_000, 20_000, 30_000);
  requireExecutionBudget({ requestRemainingMs: 56_000 }, 56_000, 46_000, 56_000);
  requireExecutionBudget({ moduleTimeoutMs: 45_000 }, 45_000, 35_000, 45_000);
  // The environment wrapper selects the mode-specific value; this pure seam enforces its cap.
  requireExecutionBudget({ configuredPipelineTimeoutMs: 30_000 }, 60_000, 30_000, 60_000);
  requireExecutionBudget({ moduleTimeoutMs: 45_000, configuredPipelineTimeoutMs: 12_000 },
    45_000, 12_000, 45_000);
  requireExecutionBudget({ moduleTimeoutMs: 90_000, requestRemainingMs: 120_000,
    configuredPipelineTimeoutMs: 90_000 }, 60_000, 50_000, 120_000);
  requireExecutionBudget({ moduleTimeoutMs: 40_000, requestRemainingMs: 30_000,
    configuredPipelineTimeoutMs: 60_000 }, 30_000, 20_000, 30_000);
  requireExecutionBudget({ moduleTimeoutMs: 25_000, requestRemainingMs: null },
    25_000, 15_000, 25_000);
  for (const remainingMs of [500, 5_000, 9_999, 10_000]) {
    requireExecutionBudget({ requestRemainingMs: remainingMs }, remainingMs, 0, remainingMs, remainingMs);
  }
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    requireExecutionBudget({ requestRemainingMs: invalid }, 0, 0, 0, 0);
    requireExecutionBudget({ moduleTimeoutMs: invalid }, 0, 0, 0, 0);
    requireExecutionBudget({ configuredPipelineTimeoutMs: invalid }, 60_000, 0, 60_000);
  }
}

function requireVirtualExecutionTrace(): void {
  const execution = requireExecutionBudget({}, 60_000, 50_000, 60_000);
  const validationMs = 500;
  const intakeMs = 4_000;
  const reasoningMs = 17_317;
  const finalMs = 12_000;
  const auditMs = 3_000;
  const reasoningStartedMs = validationMs + intakeMs;
  const finalStartedMs = reasoningStartedMs + reasoningMs;
  for (const mode of ['guide', 'build', 'meta'] as const) {
    requireAllocation({ mode, stage: 'reasoning', pipelineTimeoutMs: execution.pipelineTimeoutMs,
      pipelineElapsedMs: reasoningStartedMs, requestRemainingMs: execution.requestRemainingMs - reasoningStartedMs,
      runtimeRemainingMs: 45_000 }, 36_000, 45_000, 9_000);
    requireAllocation({ mode, stage: 'final', pipelineTimeoutMs: execution.pipelineTimeoutMs,
      pipelineElapsedMs: finalStartedMs, requestRemainingMs: execution.requestRemainingMs - finalStartedMs,
      runtimeRemainingMs: 27_683 }, 23_683, 27_683, 4_000);
    requireProof(reasoningMs < 36_000 && finalMs < 23_683);
    const completionMs = finalStartedMs + finalMs + auditMs;
    requireProof(completionMs === 36_817);
    requireProof(completionMs < execution.pipelineTimeoutMs - execution.terminalReserveMs);
    requireProof(completionMs + execution.outerHeadroomMs < execution.mcpOperationTimeoutMs);
    // Allocation-only overrun: timers/cancellation and public failure mapping are tested outside the sealed graph.
    requireProof(25_000 > 23_683);
    requireAllocation({ mode, stage: 'final', pipelineTimeoutMs: execution.pipelineTimeoutMs,
      pipelineElapsedMs: finalStartedMs + 23_683, requestRemainingMs: 14_500,
      runtimeRemainingMs: 4_000 }, 0, 4_000, 4_000);
  }
  const shortExecution = requireExecutionBudget({ requestRemainingMs: 30_000 }, 30_000, 20_000, 30_000);
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: shortExecution.pipelineTimeoutMs,
    pipelineElapsedMs: reasoningStartedMs, requestRemainingMs: shortExecution.requestRemainingMs - reasoningStartedMs,
    runtimeRemainingMs: 15_000 }, 6_000, 15_000, 9_000);
  requireProof(reasoningMs > 6_000 && reasoningStartedMs + 6_000 < shortExecution.requestRemainingMs);
}

function requireAdaptiveStages(): void {
  for (const mode of ['guide', 'build', 'meta'] as const) {
    for (const stage of ['model-validation', 'intake'] as const) {
      requireAllocation({ mode, stage, pipelineTimeoutMs: 35_000 }, mode === 'guide' ? 24_000 : 12_000, 34_500, 9_000);
    }
    // Five seconds of intake leave more than the former 12-second reasoning default.
    requireAllocation({ mode, stage: 'reasoning', pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 5_000, runtimeRemainingMs: 29_500 }, 20_500, 29_500, 9_000);
    requireAllocation({ mode, stage: 'final', pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 25_500 }, 5_000, 9_000, 4_000);
  }
}

function requireDeadlineCaps(): void {
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
    pipelineElapsedMs: 5_000, configuredStageTimeoutMs: 2_000 }, 2_000, 29_500, 9_000);
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
    requestRemainingMs: 12_000, configuredStageTimeoutMs: 50_000 }, 2_000, 11_000, 9_000);
  requireAllocation({ mode: 'guide', stage: 'final', pipelineTimeoutMs: 35_000,
    runtimeRemainingMs: 7_000 }, 3_000, 7_000, 4_000);
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
    requestRemainingMs: 9_000 }, 0, 8_000, 9_000);
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
    pipelineElapsedMs: 35_000 }, 0, 0, 9_000);
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
    requestRemainingMs: null, runtimeRemainingMs: 0 }, 0, 0, 9_000);
  requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
    configuredStageTimeoutMs: 2_000.9 }, 2_000, 34_500, 9_000);
  for (const invalid of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: invalid }, 0, 0, 9_000);
    requireAllocation({ mode: 'build', stage: 'reasoning', pipelineTimeoutMs: 35_000,
      configuredStageTimeoutMs: invalid }, 0, 34_500, 9_000);
  }
}

function requireShortDirectAnswer(): void {
  requireAllocation({ mode: 'build', stage: 'intake', pipelineTimeoutMs: 9_000,
    runtimeRemainingMs: 8_500 }, 0, 8_500, 9_000);
  requireAllocation({ mode: 'build', stage: 'direct-answer', pipelineTimeoutMs: 9_000,
    runtimeRemainingMs: 8_500 }, 4_500, 8_500, 4_000);
}

function requireCriticalReflectionReserves(): void {
  for (const stage of ['model-validation', 'intake', 'reasoning'] as const) {
    requireAllocation({ mode: 'build', stage, pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 5_000, runtimeRemainingMs: 29_500, additionalDownstreamReserveMs: 3_000 },
    stage === 'reasoning' ? 17_500 : 12_000, 29_500, 12_000);
    requireAllocation({ mode: 'build', stage, pipelineTimeoutMs: 35_000,
      pipelineElapsedMs: 5_000, runtimeRemainingMs: 25_000, additionalDownstreamReserveMs: 7_000 },
    9_000, 25_000, 16_000);
  }
  // After 5s intake, 17s reasoning and 3s reflection, final still has audit/cleanup time.
  requireAllocation({ mode: 'build', stage: 'final', pipelineTimeoutMs: 35_000,
    pipelineElapsedMs: 25_000, runtimeRemainingMs: 9_500 }, 5_500, 9_500, 4_000);
  // A shorter watchdog after 5s intake, 8s reasoning and 7s reflection stays authoritative.
  requireAllocation({ mode: 'build', stage: 'final', pipelineTimeoutMs: 35_000,
    pipelineElapsedMs: 20_000, runtimeRemainingMs: 10_000 }, 6_000, 10_000, 4_000);
}

function requireHonestTimeoutRecovery(): void {
  const request = { game: 'Synthetic Lantern Quest', prompt: 'How do I defeat the Glass Warden?', mode: 'build' as const };
  for (const fallbackReason of ['INTAKE_UPSTREAM_TIMEOUT', 'INTAKE_UNKNOWN_TIMEOUT']) {
    for (const evidenceSelected of [true, false]) {
      requireProof(resolveGamingGenerationFailureReason({ fallbackReason, evidenceSelected })
        === (evidenceSelected ? 'PROVIDER_TIMEOUT_WITH_EVIDENCE' : 'PROVIDER_TIMEOUT_WITHOUT_EVIDENCE'));
      // A known catalog source alone never qualifies a timeout as grounded evidence.
      const recovery: GamingRecoveryInput = { ...request, sourceKnown: true, evidenceSelected, timedOut: true };
      requireProof(resolveGamingRecoveryClass(recovery)
        === (evidenceSelected ? 'provider_timeout_with_evidence' : 'provider_timeout_without_evidence'));
      const response = buildGamingRecoveryResponse(recovery);
      requireProof(response === response.trim() && response.length > 0 && response.length <= 600);
      requireProof(response.includes('timed out'));
      requireProof(response.includes('I found the relevant guide material') === evidenceSelected);
      requireProof(!/CLEAR|Trinity|provider|upgrade|repair|stock|^\d+\./imu.test(response));
    }
  }
  for (const fallbackReason of [undefined, 'GAMING_PROVIDER_ERROR', 'GAMING_PROVIDER_UNAVAILABLE',
    'PROVIDER_COMPLETION_INCOMPLETE', 'GAMING_ANSWER_REJECTED', 'INTAKE_RETRIEVAL_TIMEOUT', 'ARBITRARY_TIMEOUT']) {
    for (const evidenceSelected of [true, false]) {
      requireProof(resolveGamingGenerationFailureReason({ fallbackReason, evidenceSelected }) === 'GENERATION_UNAVAILABLE');
    }
  }
  const unavailable = { ...request, sourceKnown: true, evidenceSelected: true, timedOut: false };
  requireProof(resolveGamingRecoveryClass(unavailable) === 'generation_unavailable');
  requireProof(!buildGamingRecoveryResponse(unavailable).includes('timed out'));
}

/** Fixed pure policy proof; no clocks, provider dispatch, SQL, cache, or retry-workflow execution. */
export function assertGamingGenerationBudgetPreviewFixture(): void {
  try {
    requireExecutionEnvelope();
    requireVirtualExecutionTrace();
    requireAdaptiveStages();
    requireDeadlineCaps();
    requireShortDirectAnswer();
    requireCriticalReflectionReserves();
    requireHonestTimeoutRecovery();
  } catch {
    throw new Error(FAILURE);
  }
}
