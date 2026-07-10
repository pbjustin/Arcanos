import { getEnv, getEnvBoolean, getEnvIntegerAtLeast, getEnvNumber, getOptionalEnvIntegerAtLeast } from "@platform/runtime/env.js";
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
export const DEFAULT_GAMING_DISCOVERY_SEARCH_RESULT_LIMIT = 8;
export const DEFAULT_GAMING_DISCOVERY_FETCH_CANDIDATE_LIMIT = 3;
export const DEFAULT_GAMING_DISCOVERY_TIMEOUT_MS = 4_000;
export const DEFAULT_GAMING_DISCOVERY_BUDGET_MS = 7_000;
export const DEFAULT_GAMING_DISCOVERY_QUERY_CACHE_TTL_MS = 2 * 60 * 60_000;
export const DEFAULT_GAMING_DISCOVERY_GUIDE_CACHE_TTL_MS = 2 * 60 * 60_000;
export const DEFAULT_GAMING_DISCOVERY_META_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_GAMING_DISCOVERY_CACHE_MAX_ENTRIES = 100;
export const DEFAULT_GAMING_DISCOVERY_MIN_CANDIDATE_SCORE = 0.45;
export const DEFAULT_GAMING_DISCOVERY_MIN_EVIDENCE_QUALITY = 0.45;
export const DEFAULT_GAMING_DISCOVERY_MAX_PROVIDER_RESPONSE_BYTES = 512_000;
const HARD_MAX_GAMING_WEB_CONTEXT_CHARS = 50_000;
const HARD_MAX_GAMING_WEB_CONTEXT_URLS = 32;
const HARD_MAX_GAMING_WEB_FETCH_TIMEOUT_MS = 30_000;
const HARD_MAX_GAMING_RAG_SOURCES = 32;
const HARD_MAX_GAMING_RAG_CHUNKS = 48;
const HARD_MAX_GAMING_RAG_CHUNK_CHARS = 4_000;
const HARD_MAX_GAMING_DISCOVERY_SEARCH_RESULTS = 10;
const HARD_MAX_GAMING_DISCOVERY_FETCH_CANDIDATES = 4;
const HARD_MAX_GAMING_DISCOVERY_TIMEOUT_MS = 10_000;
const HARD_MAX_GAMING_DISCOVERY_BUDGET_MS = 15_000;
const HARD_MAX_GAMING_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60_000;
const HARD_MAX_GAMING_DISCOVERY_CACHE_ENTRIES = 500;
const HARD_MAX_GAMING_DISCOVERY_PROVIDER_RESPONSE_BYTES = 1_000_000;
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
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_CHARS",
    DEFAULT_GAMING_WEB_CONTEXT_CHARS,
    0
  ), HARD_MAX_GAMING_WEB_CONTEXT_CHARS);
}

export function getGamingWebContextMaxUrls(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS",
    DEFAULT_GAMING_WEB_CONTEXT_MAX_URLS,
    0
  ), HARD_MAX_GAMING_WEB_CONTEXT_URLS);
}

export function getGamingWebContextFetchTimeoutMs(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS",
    DEFAULT_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS,
    1
  ), HARD_MAX_GAMING_WEB_FETCH_TIMEOUT_MS);
}

export function getGamingRagEnabled(): boolean {
  const rawValue = getEnv("ARCANOS_GAMING_RAG_ENABLED");
  return rawValue === undefined ? true : !["0", "false", "no", "off"].includes(rawValue.trim().toLowerCase());
}

export function getGamingRagMaxSources(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_RAG_MAX_SOURCES",
    DEFAULT_GAMING_RAG_MAX_SOURCES,
    0
  ), HARD_MAX_GAMING_RAG_SOURCES);
}

export function getGamingRagMaxChunks(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_RAG_MAX_CHUNKS",
    DEFAULT_GAMING_RAG_MAX_CHUNKS,
    0
  ), HARD_MAX_GAMING_RAG_CHUNKS);
}

export function getGamingRagChunkChars(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_RAG_CHUNK_CHARS",
    DEFAULT_GAMING_RAG_CHUNK_CHARS,
    200
  ), HARD_MAX_GAMING_RAG_CHUNK_CHARS);
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

export function getGamingDiscoveryEnabled(): boolean {
  return getEnvBoolean("ARCANOS_GAMING_DISCOVERY_ENABLED", false);
}

export function getGamingDiscoveryProvider(): "brave" | undefined {
  const provider = getEnv("ARCANOS_GAMING_DISCOVERY_PROVIDER", "brave").trim().toLowerCase();
  return provider === "brave" ? provider : undefined;
}

export function getGamingDiscoverySearchResultLimit(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_SEARCH_RESULT_LIMIT",
    DEFAULT_GAMING_DISCOVERY_SEARCH_RESULT_LIMIT,
    1
  ), HARD_MAX_GAMING_DISCOVERY_SEARCH_RESULTS);
}

export function getGamingDiscoveryFetchCandidateLimit(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_FETCH_CANDIDATE_LIMIT",
    DEFAULT_GAMING_DISCOVERY_FETCH_CANDIDATE_LIMIT,
    1
  ), HARD_MAX_GAMING_DISCOVERY_FETCH_CANDIDATES);
}

export function getGamingDiscoveryTimeoutMs(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_TIMEOUT_MS",
    DEFAULT_GAMING_DISCOVERY_TIMEOUT_MS,
    1
  ), HARD_MAX_GAMING_DISCOVERY_TIMEOUT_MS);
}

export function getGamingDiscoveryBudgetMs(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_BUDGET_MS",
    DEFAULT_GAMING_DISCOVERY_BUDGET_MS,
    1
  ), HARD_MAX_GAMING_DISCOVERY_BUDGET_MS);
}

export function getGamingDiscoveryQueryCacheTtlMs(mode: GamingMode, patchSensitive: boolean): number {
  const fallback = mode === "meta" || patchSensitive
    ? DEFAULT_GAMING_DISCOVERY_META_CACHE_TTL_MS
    : DEFAULT_GAMING_DISCOVERY_GUIDE_CACHE_TTL_MS;
  const genericTtlMs = Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_QUERY_CACHE_TTL_MS",
    fallback,
    1
  ), HARD_MAX_GAMING_DISCOVERY_CACHE_TTL_MS);
  const modeTtlMs = Math.min(getEnvIntegerAtLeast(
    mode === "meta" || patchSensitive
      ? "ARCANOS_GAMING_DISCOVERY_META_CACHE_TTL_MS"
      : "ARCANOS_GAMING_DISCOVERY_GUIDE_CACHE_TTL_MS",
    genericTtlMs,
    1
  ), HARD_MAX_GAMING_DISCOVERY_CACHE_TTL_MS);
  return modeTtlMs;
}

export function getGamingDiscoveryCacheMaxEntries(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_CACHE_MAX_ENTRIES",
    DEFAULT_GAMING_DISCOVERY_CACHE_MAX_ENTRIES,
    1
  ), HARD_MAX_GAMING_DISCOVERY_CACHE_ENTRIES);
}

function getGamingDiscoveryBoundedScore(key: string, fallback: number): number {
  return Math.max(0, Math.min(1, getEnvNumber(key, fallback)));
}

export function getGamingDiscoveryMinCandidateScore(): number {
  return getGamingDiscoveryBoundedScore(
    "ARCANOS_GAMING_DISCOVERY_MIN_CANDIDATE_SCORE",
    DEFAULT_GAMING_DISCOVERY_MIN_CANDIDATE_SCORE
  );
}

export function getGamingDiscoveryMinEvidenceQuality(): number {
  return getGamingDiscoveryBoundedScore(
    "ARCANOS_GAMING_DISCOVERY_MIN_EVIDENCE_QUALITY",
    DEFAULT_GAMING_DISCOVERY_MIN_EVIDENCE_QUALITY
  );
}

function getGamingDiscoveryDomainPolicy(key: string): string[] {
  return Array.from(new Set(
    (getEnv(key) ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
      .filter(Boolean)
  ));
}

export function getGamingDiscoveryDomainAllowlist(): string[] {
  return getGamingDiscoveryDomainPolicy("ARCANOS_GAMING_DISCOVERY_DOMAIN_ALLOWLIST");
}

export function getGamingDiscoveryDomainBlocklist(): string[] {
  return getGamingDiscoveryDomainPolicy("ARCANOS_GAMING_DISCOVERY_DOMAIN_BLOCKLIST");
}

export function getGamingDiscoveryOfficialDomains(): string[] {
  return getGamingDiscoveryDomainPolicy("ARCANOS_GAMING_DISCOVERY_OFFICIAL_DOMAINS");
}

export function getGamingDiscoveryMaxProviderResponseBytes(): number {
  return Math.min(getEnvIntegerAtLeast(
    "ARCANOS_GAMING_DISCOVERY_MAX_PROVIDER_RESPONSE_BYTES",
    DEFAULT_GAMING_DISCOVERY_MAX_PROVIDER_RESPONSE_BYTES,
    1_024
  ), HARD_MAX_GAMING_DISCOVERY_PROVIDER_RESPONSE_BYTES);
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
