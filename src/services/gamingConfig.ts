import { getEnvIntegerAtLeast, getOptionalEnvIntegerAtLeast } from "@platform/runtime/env.js";
import type { GamingMode } from "@services/gamingModes.js";

export const DEFAULT_GAMING_MODULE_TIMEOUT_MS = 60_000;
export const DEFAULT_GAMING_WEB_CONTEXT_CHARS = 5_000;
export const DEFAULT_GAMING_PIPELINE_TIMEOUT_MS = 35_000;
export const DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS = 50_000;
export const DEFAULT_GAMING_STAGE_TIMEOUT_MS = 12_000;
export const DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS = 15_000;
export const GAMING_REQUEST_TIMEOUT_HEADROOM_MS = 1_000;
export const GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS = 500;

export function getGamingModuleTimeoutMs(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_MODULE_TIMEOUT_MS",
    DEFAULT_GAMING_MODULE_TIMEOUT_MS,
    1
  );
}

export function getGamingWebContextMaxChars(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_CHARS",
    DEFAULT_GAMING_WEB_CONTEXT_CHARS,
    0
  );
}

function clampToRequestRemaining(timeoutMs: number, remainingRequestMs: number | null): number {
  if (remainingRequestMs === null) {
    return timeoutMs;
  }

  return Math.max(1, Math.min(timeoutMs, remainingRequestMs - GAMING_REQUEST_TIMEOUT_HEADROOM_MS));
}

function getDefaultGamingPipelineTimeoutMs(mode: GamingMode): number {
  const configuredModuleTimeoutMs = getOptionalEnvIntegerAtLeast("ARCANOS_GAMING_MODULE_TIMEOUT_MS", 1);
  if (configuredModuleTimeoutMs !== undefined) {
    return Math.max(1, configuredModuleTimeoutMs - GAMING_REQUEST_TIMEOUT_HEADROOM_MS);
  }

  return mode === "guide" ? DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS : DEFAULT_GAMING_PIPELINE_TIMEOUT_MS;
}

export function getGamingPipelineTimeoutMs(
  mode: GamingMode,
  remainingRequestMs: number | null
): number {
  const fallback = getDefaultGamingPipelineTimeoutMs(mode);
  const genericTimeoutMs = getEnvIntegerAtLeast("ARCANOS_GAMING_PIPELINE_TIMEOUT_MS", fallback, 1);
  const modeTimeoutMs = getEnvIntegerAtLeast(
    `ARCANOS_GAMING_${mode.toUpperCase()}_PIPELINE_TIMEOUT_MS`,
    genericTimeoutMs,
    1
  );

  return clampToRequestRemaining(modeTimeoutMs, remainingRequestMs);
}

export function getGamingStageTimeoutMs(mode: GamingMode, pipelineTimeoutMs: number): number {
  const fallback =
    mode === "guide" ? DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS : DEFAULT_GAMING_STAGE_TIMEOUT_MS;
  const genericTimeoutMs = getEnvIntegerAtLeast("ARCANOS_GAMING_STAGE_TIMEOUT_MS", fallback, 1);
  const modeTimeoutMs = getEnvIntegerAtLeast(
    `ARCANOS_GAMING_${mode.toUpperCase()}_STAGE_TIMEOUT_MS`,
    genericTimeoutMs,
    1
  );

  return Math.max(1, Math.min(modeTimeoutMs, Math.max(1, pipelineTimeoutMs - GAMING_REQUEST_TIMEOUT_HEADROOM_MS)));
}
