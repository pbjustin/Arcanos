import { getEnv, getEnvBoolean, getEnvIntegerAtLeast, getEnvNumber, getOptionalEnvIntegerAtLeast } from "@platform/runtime/env.js";
import type { GamingMode } from "@services/gamingModes.js";
import { resolveGamingGenerationBudget } from "@shared/gaming/gamingGenerationBudgetCore.js";
import { resolveGamingExecutionBudget } from "@shared/gaming/gamingExecutionBudgetCore.js";

export {
  DEFAULT_GAMING_STAGE_TIMEOUT_MS, DEFAULT_GAMING_GUIDE_STAGE_TIMEOUT_MS,
  GAMING_REQUEST_TIMEOUT_HEADROOM_MS, GAMING_RUNTIME_BUDGET_SAFETY_BUFFER_MS,
  GAMING_GENERATION_FINAL_STAGE_RESERVE_MS, GAMING_GENERATION_ANSWER_AUDIT_RESERVE_MS,
  GAMING_GENERATION_TERMINAL_HEADROOM_MS, resolveGamingGenerationBudget,
  type GamingGenerationStage
} from "@shared/gaming/gamingGenerationBudgetCore.js";
export {
  DEFAULT_GAMING_MODULE_TIMEOUT_MS, DEFAULT_GAMING_PIPELINE_TIMEOUT_MS,
  DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS, GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS,
  GAMING_EXECUTION_OUTER_HEADROOM_MS, GAMING_PROVIDER_DISPATCH_HEADROOM_MS,
  resolveGamingExecutionBudget
} from "@shared/gaming/gamingExecutionBudgetCore.js";

export const DEFAULT_GAMING_WEB_CONTEXT_CHARS = 5_000;
export const DEFAULT_GAMING_WEB_CONTEXT_MAX_URLS = 15;
export const DEFAULT_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS = 5_000;
export const DEFAULT_GAMING_RAG_MAX_SOURCES = 4;
export const DEFAULT_GAMING_RAG_MAX_CHUNKS = 6;
export const DEFAULT_GAMING_RAG_CHUNK_CHARS = 900;
export const DEFAULT_GAMING_RAG_META_TTL_MS = 15 * 60_000;
export const DEFAULT_GAMING_RAG_GUIDE_TTL_MS = 24 * 60 * 60_000;
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

/** Operator limits are caps, not adaptive defaults: mode-specific wins over generic. */
export function getGamingConfiguredStageTimeoutMs(mode: GamingMode): number | undefined {
  return getOptionalEnvIntegerAtLeast(`ARCANOS_GAMING_${mode.toUpperCase()}_STAGE_TIMEOUT_MS`, 1)
    ?? getOptionalEnvIntegerAtLeast("ARCANOS_GAMING_STAGE_TIMEOUT_MS", 1);
}

export function getGamingModuleTimeoutMs(): number {
  return resolveGamingExecutionBudget({
    moduleTimeoutMs: getOptionalEnvIntegerAtLeast("ARCANOS_GAMING_MODULE_TIMEOUT_MS", 1)
  }).mcpOperationTimeoutMs;
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

export function getGamingCanaryAuditEnabled(): boolean {
  const railwayEnvironment = (
    getEnv("RAILWAY_ENVIRONMENT_NAME")
    || getEnv("RAILWAY_ENVIRONMENT")
    || ""
  ).trim().toLowerCase();
  return railwayEnvironment !== "production"
    && getEnvBoolean("ARCANOS_GAMING_CANARY_AUDIT_ENABLED", false);
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

/** Mode-specific pipeline override wins; all operator values remain parent-bounded caps. */
export function getGamingConfiguredPipelineTimeoutMs(mode: GamingMode): number | undefined {
  return getOptionalEnvIntegerAtLeast(`ARCANOS_GAMING_${mode.toUpperCase()}_PIPELINE_TIMEOUT_MS`, 1)
    ?? getOptionalEnvIntegerAtLeast("ARCANOS_GAMING_PIPELINE_TIMEOUT_MS", 1);
}

export function getGamingPipelineTimeoutMs(
  mode: GamingMode,
  remainingRequestMs: number | null
): number {
  return getGamingExecutionBudget(mode, remainingRequestMs).pipelineTimeoutMs;
}

export function getGamingExecutionBudget(mode: GamingMode, remainingRequestMs: number | null) {
  return resolveGamingExecutionBudget({
    moduleTimeoutMs: getGamingModuleTimeoutMs(),
    requestRemainingMs: remainingRequestMs,
    configuredPipelineTimeoutMs: getGamingConfiguredPipelineTimeoutMs(mode)
  });
}

export function getGamingStageTimeoutMs(mode: GamingMode, pipelineTimeoutMs: number): number {
  return resolveGamingGenerationBudget({ mode, stage: "intake", pipelineTimeoutMs,
    configuredStageTimeoutMs: getGamingConfiguredStageTimeoutMs(mode) }).effectiveStageTimeoutMs;
}
