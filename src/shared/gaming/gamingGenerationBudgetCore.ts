export const DEFAULT_GAMING_STAGE_TIMEOUT_MS = 12_000;
export const DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS = 24_000;
export const GAMING_REQUEST_TIMEOUT_HEADROOM_MS = 1_000;
export const GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS = 500;
export const GAMING_GENERATION_FINAL_STAGE_RESERVE_MS = 5_000;
export const GAMING_GENERATION_ANSWER_AUDIT_RESERVE_MS = 3_000;
export const GAMING_GENERATION_TERMINAL_HEADROOM_MS = 1_000;

export type GamingGenerationStage = "model-validation" | "intake" | "reasoning" | "final" | "direct-answer";

/** Allocate only existing usable time, retaining downstream work and terminal cleanup. */
export function resolveGamingGenerationBudget(params: {
  mode: "guide" | "build" | "meta";
  stage: GamingGenerationStage;
  pipelineTimeoutMs: number;
  pipelineElapsedMs?: number;
  requestRemainingMs?: number | null;
  runtimeRemainingMs?: number;
  configuredStageTimeoutMs?: number;
  additionalDownstreamReserveMs?: number;
}) {
  const boundedMs = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const pipelineRemainingMs = boundedMs(boundedMs(params.pipelineTimeoutMs)
    - boundedMs(params.pipelineElapsedMs ?? 0) - GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS);
  const requestUsableMs = params.requestRemainingMs == null ? pipelineRemainingMs
    : boundedMs(boundedMs(params.requestRemainingMs) - GAMING_REQUEST_TIMEOUT_HEADROOM_MS);
  const generationRemainingMs = Math.max(0, Math.min(pipelineRemainingMs, requestUsableMs,
    params.runtimeRemainingMs === undefined ? pipelineRemainingMs : boundedMs(params.runtimeRemainingMs)));
  const downstreamReserveMs = GAMING_GENERATION_TERMINAL_HEADROOM_MS
    + GAMING_GENERATION_ANSWER_AUDIT_RESERVE_MS
    + (params.stage === "final" || params.stage === "direct-answer" ? 0 : GAMING_GENERATION_FINAL_STAGE_RESERVE_MS)
    + boundedMs(params.additionalDownstreamReserveMs ?? 0);
  const availableStageMs = Math.max(0, Math.floor(generationRemainingMs - downstreamReserveMs));
  const intakeDefaultMs = params.mode === "guide" ? DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS : DEFAULT_GAMING_STAGE_TIMEOUT_MS;
  const defaultStageMs = params.stage === "intake" || params.stage === "model-validation"
    ? intakeDefaultMs : availableStageMs;
  const effectiveStageTimeoutMs = Math.min(availableStageMs, params.configuredStageTimeoutMs === undefined
    ? defaultStageMs : boundedMs(params.configuredStageTimeoutMs));
  return { effectiveStageTimeoutMs, generationRemainingMs, pipelineRemainingMs, downstreamReserveMs,
    configuredStageTimeoutMs: params.configuredStageTimeoutMs ?? null };
}
