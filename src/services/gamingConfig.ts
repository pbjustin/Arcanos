import { getEnv, getEnvIntegerAtLeast, getOptionalEnvIntegerAtLeast } from "@platform/runtime/env.js";
import type { GamingMode } from "@services/gamingModes.js";

export const DEFAULT_GAMING_MODULE_TIMEOUT_MS = 60_000;
export const DEFAULT_GAMING_WEB_CONTEXT_CHARS = 5_000;
export const DEFAULT_GAMING_WEB_CONTEXT_MAX_URLS = 15;
export const DEFAULT_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS = 5_000;
export const DEFAULT_GAMING_RAG_MAX_SOURCES = 4;
export const DEFAULT_GAMING_RAG_MAX_CHUNKS = 6;
export const DEFAULT_GAMING_RAG_CHUNK_CHARS = 900;
export const DEFAULT_GAMING_RAG_META_TTL_MS = 15 * 60_000;
export const DEFAULT_GAMING_RAG_GUIDE_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_GAMING_PIPELINE_TIMEOUT_MS = 35_000;
export const DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS = 50_000;
export const DEFAULT_GAMING_STAGE_TIMEOUT_MS = 12_000;
export const DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS = 15_000;
export const GAMING_REQUEST_TIMEOUT_HEADROOM_MS = 1_000;
export const GAMING_PROVIDER_DISPATCH_HEADROOM_MS = 5_000;
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

export function getGamingWebContextMaxUrls(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS",
    DEFAULT_GAMING_WEB_CONTEXT_MAX_URLS,
    0
  );
}

export function getGamingWebContextFetchTimeoutMs(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS",
    DEFAULT_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS,
    1
  );
}

export function getGamingRagEnabled(): boolean {
  const rawValue = getEnv("ARCANOS_GAMING_RAG_ENABLED");
  return rawValue === undefined ? true : !["0", "false", "no", "off"].includes(rawValue.trim().toLowerCase());
}

export function getGamingRagMaxSources(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_RAG_MAX_SOURCES",
    DEFAULT_GAMING_RAG_MAX_SOURCES,
    0
  );
}

export function getGamingRagMaxChunks(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_RAG_MAX_CHUNKS",
    DEFAULT_GAMING_RAG_MAX_CHUNKS,
    0
  );
}

export function getGamingRagChunkChars(): number {
  return getEnvIntegerAtLeast(
    "ARCANOS_GAMING_RAG_CHUNK_CHARS",
    DEFAULT_GAMING_RAG_CHUNK_CHARS,
    200
  );
}

export function getGamingRagTtlMs(mode: GamingMode, patchSensitive: boolean): number {
  const fallback = mode === "meta" || patchSensitive
    ? DEFAULT_GAMING_RAG_META_TTL_MS
    : DEFAULT_GAMING_RAG_GUIDE_TTL_MS;
  const genericTtlMs = getEnvIntegerAtLeast("ARCANOS_GAMING_RAG_TTL_MS", fallback, 1);
  const modeTtlMs = getEnvIntegerAtLeast(
    `ARCANOS_GAMING_RAG_${mode.toUpperCase()}_TTL_MS`,
    genericTtlMs,
    1
  );

  return patchSensitive
    ? Math.min(modeTtlMs, getEnvIntegerAtLeast("ARCANOS_GAMING_RAG_META_TTL_MS", DEFAULT_GAMING_RAG_META_TTL_MS, 1))
    : modeTtlMs;
}

function clampToRequestRemaining(timeoutMs: number, remainingRequestMs: number | null): number {
  if (remainingRequestMs === null) {
    return timeoutMs;
  }

  return Math.max(1, Math.min(timeoutMs, remainingRequestMs - GAMING_REQUEST_TIMEOUT_HEADROOM_MS));
}

function getDefaultGamingPipelineTimeoutMs(mode: GamingMode): number {
  const modeDefault = mode === "guide" ? DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS : DEFAULT_GAMING_PIPELINE_TIMEOUT_MS;
  const configuredModuleTimeoutMs = getOptionalEnvIntegerAtLeast("ARCANOS_GAMING_MODULE_TIMEOUT_MS", 1);
  if (configuredModuleTimeoutMs !== undefined) {
    const moduleBoundTimeoutMs = Math.max(1, configuredModuleTimeoutMs - GAMING_PROVIDER_DISPATCH_HEADROOM_MS);
    return configuredModuleTimeoutMs > DEFAULT_GAMING_MODULE_TIMEOUT_MS
      ? Math.max(modeDefault, moduleBoundTimeoutMs)
      : Math.min(modeDefault, moduleBoundTimeoutMs);
  }

  return modeDefault;
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
