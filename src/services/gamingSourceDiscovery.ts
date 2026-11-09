import {
  sanitizeGamingSourceUrl, gamingSourceAcquisitionIdentity,
  normalizeGamingSourceDomain as normalizeDomain, gamingSourceDomainMatches as domainMatches,
  type GamingSourceAdmissionResult
} from "@shared/gaming/gamingSourceAcquisitionCore.js";
export { GAMING_SOURCE_ADMISSION_POLICY_VERSION } from "@shared/gaming/gamingSourceAcquisitionCore.js";
export type { GamingSourceAdmissionSubreason, GamingSourceAdmissionRejection, GamingSourceAdmissionResult }
  from "@shared/gaming/gamingSourceAcquisitionCore.js";
import { createHash } from "node:crypto";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnv } from "@platform/runtime/env.js";
import { GAMING_BUILD_RESOURCE_HARD_LIMITS } from "@services/gamingBuildResourceSchema.js";
import { buildGamingRetrievalTerms } from "@shared/gaming/gamingRetrievalPolicy.js";
import { gamingRegistryLiteralPattern } from "@shared/gaming/gamingGameRegistry.js";
import type { GamingPlayerContext } from "@shared/gaming/gamingPlayerContext.js";
import {
  getGamingDiscoveryBudgetMs,
  getGamingDiscoveryCacheMaxEntries,
  getGamingDiscoveryDomainAllowlist,
  getGamingDiscoveryDomainBlocklist,
  getGamingDiscoveryEnabled,
  getGamingDiscoveryFetchCandidateLimit,
  getGamingDiscoveryMaxProviderResponseBytes,
  getGamingDiscoveryMinCandidateScore,
  getGamingDiscoveryOfficialDomains,
  getGamingDiscoveryProvider,
  getGamingDiscoveryQueryCacheTtlMs,
  getGamingDiscoverySearchResultLimit,
  getGamingDiscoveryTimeoutMs
} from "@services/gamingConfig.js";
import type {
  GamingDiscoveryFailureReason as GamingDiscoveryFailureReasonContract,
  GamingMode
} from "@services/gamingModes.js";

export type GamingSearchFreshnessPreference = "current" | "stable";

export interface GamingSearchRequest {
  query: string;
  game?: string;
  mode: GamingMode;
  freshnessPreference: GamingSearchFreshnessPreference;
  resultLimit: number;
  signal: AbortSignal;
}

export interface GamingSearchResult {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  updatedAt?: string;
  providerRank: number;
  provider: string;
}

export interface GamingSearchProvider {
  readonly id: string;
  readonly version: string;
  isConfigured(): boolean;
  search(input: GamingSearchRequest): Promise<GamingSearchResult[]>;
}

export type GamingDiscoveryFailureReason = GamingDiscoveryFailureReasonContract;

export interface GamingDiscoveredCandidate extends GamingSearchResult {
  score: number;
  suggestedSourceType: "official" | "patch_notes" | "wiki" | "curated";
  stable: boolean;
  freshnessKnown: boolean;
  characteristics: {
    officialLikely: boolean;
    patchLikely: boolean;
    wikiLikely: boolean;
    guideLikely: boolean;
    articleLikely: boolean;
  };
}

export interface GamingDiscoveryInput extends Pick<GamingPlayerContext, "class" | "currentArea" | "constraints" | "edition" | "platform"> {
  prompt: string;
  game?: string;
  mode: GamingMode;
  patchSensitive?: boolean;
  requestedVersion?: string;
  signal?: AbortSignal;
  provider?: GamingSearchProvider;
  /** Already attempted candidates stay excluded even when search results are cached. */
  excludedUrls?: readonly string[];
  /** Evaluate two targeted queries within the same result and wall-clock ceilings. */
  queryVariants?: boolean;
  /** A caller-owned recovery grant can request new hints instead of replaying the query cache. */
  refreshSearch?: boolean;
}

export interface GamingDiscoveryResult {
  candidates: GamingDiscoveredCandidate[];
  searchProvider?: string;
  searchQueryHash?: string;
  searchQuerySummary?: {
    charCount: number;
    termCount: number;
    freshnessPreference: GamingSearchFreshnessPreference;
  };
  searchResultCount: number;
  candidateCount: number;
  rejectedCandidateCount: number;
  discoveryCacheHit: boolean;
  discoveryElapsedMs: number;
  candidateRankingElapsedMs: number;
  discoveryFailureReason?: GamingDiscoveryFailureReason;
}

type GamingDiscoveryCacheEntry = {
  expiresAt: number;
  results: GamingSearchResult[];
};

type BraveSearchApiResult = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  page_age?: unknown;
  age?: unknown;
};

type BraveSearchApiResponse = {
  web?: {
    results?: unknown;
  };
};

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_PROVIDER_VERSION = "brave-web-v1";
const MAX_SEARCH_QUERY_CHARS = 180;
const MAX_SEARCH_RESULT_URL_CHARS = 2_048;
const MAX_SEARCH_TITLE_CHARS = 240;
const MAX_SEARCH_SNIPPET_CHARS = 500;
const MAX_QUERY_TOPIC_TERMS = 12;
const MAX_PROVIDER_RANK = 100;
const SOURCE_INSTRUCTION_PATTERN = /(?:\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)|forget\s+(?:everything|all)(?:\s+(?:written|said))?\s+(?:above|before)|you\s+are\s+now|(?:reveal|print|show|expose)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)|(?:call|invoke)\s+(?:the\s+)?(?:tool|function)|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b|(?:^|\s|\[|<\|)(?:system|developer|assistant|user)(?:\s*:|\]|\|>))/i;
const QUERY_STOP_WORDS = new Set([
  "about", "access", "and", "api", "are", "auth", "bearer", "best", "can", "cookie", "could", "credential", "find", "for", "from", "game", "give", "help",
  "how", "into", "look", "looking", "me", "need", "please", "show", "that", "the", "this", "through",
  "key", "password", "secret", "session", "token", "use", "using", "want", "what", "when", "where", "which", "with", "would", "you", "your"
]);

const discoveryCache = new Map<string, GamingDiscoveryCacheEntry>();
let warnedMissingProviderConfiguration = false;

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+.'_-]*/g)
      ?.map((term) => term.replace(/^['._-]+|['._-]+$/g, ""))
      .filter((term) => term.length >= 2) ?? []
  ));
}

function stripUntrustedInstructions(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, " ")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, " ")
    .replace(/\bgh[opusr]_[A-Za-z0-9]{12,}\b/gi, " ")
    .replace(/\b(?:railway|rwy)[_-]?[A-Za-z0-9]{16,}\b/gi, " ")
    .replace(/\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s]+/gi, " ")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/g, " ")
    .replace(/\b(?:access[_-]?token|api[_-]?key|auth[_-]?token|cookie|credential|password|secret|session[_-]?id|token)\s*[:=]\s*[^\s,;]+/gi, " ")
    // Discovery sends only gameplay intent to a search provider. Explicit personal
    // asides and account/character identifiers are never useful search context.
    .replace(/\b(?:my|our)\s+(?:(?:private|personal)\s+)?(?:account|character\s+(?:name|id|identifier)|address|apartment|email|phone)\b[^;.!?\n]*/giu, " ")
    .replace(/\b(?:private|personal)\s+(?:character|account|address|apartment|email|phone)\b[^;.!?\n]*/giu, " ")
    .replace(/\b(?:account|user|player|character)\s*(?:id|identifier|name)\s*[:=]\s*\S+/giu, " ")
    .replace(/\b\d{7,}\b|\[[^\]]*REDACT[^\]]*\]/giu, " ")
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .filter((part) => !SOURCE_INSTRUCTION_PATTERN.test(part))
    .join(" ")
    .replace(/https?:\/\/\S+|\b\S+@\S+\.\S+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeSearchText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = stripUntrustedInstructions(value).slice(0, maxChars).trim();
  return cleaned || undefined;
}

function buildQueryTopicTerms(input: GamingDiscoveryInput): string[] {
  const clean = (value: string | undefined) => value ? stripUntrustedInstructions(value).slice(0, 1_000) : undefined;
  const terms = buildGamingRetrievalTerms({
    game: clean(input.game), prompt: clean(input.prompt) ?? "", mode: input.mode,
    class: clean(input.class), currentArea: clean(input.currentArea),
    constraints: input.constraints?.map(value => clean(value) ?? "").filter(Boolean)
  });
  return Array.from(new Set([...terms.focusTerms, ...terms.contextTerms]))
    .filter(term => !QUERY_STOP_WORDS.has(term)).slice(0, MAX_QUERY_TOPIC_TERMS);
}

function buildGamingDiscoveryScope(input: GamingDiscoveryInput): string | undefined {
  // Check complete sanitized fields before any clipping or boundary trimming.
  // Whitespace just beyond the ceiling must not hide a later scope qualifier.
  const fields = [input.game, input.edition, input.platform, input.requestedVersion]
    .map(value => value ? stripUntrustedInstructions(value) || undefined : undefined);
  if (fields.some(value => value && value.length > MAX_SEARCH_QUERY_CHARS)) return undefined;
  const [game, edition, platform, version] = fields;
  const gameSegment = game
    ? (game.includes(" ") ? `"${game.replace(/[\"\\]/g, " ").replace(/\s+/g, " ").trim()}"` : game)
    : "";
  const scope = [gameSegment, edition, platform, version].filter(Boolean).join(" ");
  return scope.length <= MAX_SEARCH_QUERY_CHARS ? scope : undefined;
}

export function buildGamingDiscoveryQuery(input: GamingDiscoveryInput): string {
  const scope = buildGamingDiscoveryScope(input);
  if (scope === undefined) return "";
  const topicTerms = buildQueryTopicTerms(input);
  const topicText = topicTerms.join(" ");
  let modeSegment = input.mode === "guide" ? "guide" : input.mode === "build" ? "build" : "meta";
  if (input.patchSensitive || input.mode === "meta") {
    modeSegment = "latest patch";
  } else if (/\bwalkthrough\b/i.test(topicText)) {
    modeSegment = "";
  }

  return [scope, topicText, modeSegment]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_QUERY_CHARS)
    .trim();
}

/** Alternate wording narrows the request anchor without dropping applicability scope.
 * These are search hints only; neither query establishes source or claim authority. */
export function buildGamingDiscoveryQueries(input: GamingDiscoveryInput): string[] {
  const primary = buildGamingDiscoveryQuery(input);
  const scope = buildGamingDiscoveryScope(input);
  if (scope === undefined) return [];
  const focused = buildGamingRetrievalTerms({
    game: safeSearchText(input.game, 100), prompt: stripUntrustedInstructions(input.prompt).slice(0, 1_000), mode: input.mode
  }).focusTerms.filter(term => !QUERY_STOP_WORDS.has(term)).slice(0, 8);
  const suffix = input.patchSensitive || input.mode === "meta" ? "latest patch notes"
    : input.mode === "build" ? "equipment skills build"
      : focused.some(term => /^(?:quest|walkthrough|route|location|find|reach)$/iu.test(term)) ? "walkthrough" : "mechanics guide";
  const available = MAX_SEARCH_QUERY_CHARS - scope.length - suffix.length - 2;
  const topic: string[] = [];
  for (const term of focused) {
    if ([...topic, term].join(" ").length > available) break;
    topic.push(term);
  }
  const secondary = topic.length ? `${scope} ${topic.join(" ")} ${suffix}`.replace(/\s+/gu, " ").trim() : primary;
  return [...new Set([primary, secondary].filter(Boolean))];
}

export function sanitizeGamingDiscoveryCandidateUrl(rawUrl: string): GamingSourceAdmissionResult {
  return sanitizeGamingSourceUrl(rawUrl, MAX_SEARCH_RESULT_URL_CHARS, {
    allowlist: getGamingDiscoveryDomainAllowlist(), blocklist: getGamingDiscoveryDomainBlocklist()
  });
}

/** Existing internal structured documents retain their bounded URL payload allowance.
 * Public discovery/hybrid candidates and redirect destinations always use the 2,048-character entry point.
 */
export function sanitizeGamingStructuredDocumentUrl(rawUrl: string): GamingSourceAdmissionResult {
  return sanitizeGamingSourceUrl(rawUrl, GAMING_BUILD_RESOURCE_HARD_LIMITS.maxUrlChars, {
    allowlist: getGamingDiscoveryDomainAllowlist(), blocklist: getGamingDiscoveryDomainBlocklist()
  });
}

function matchedTokenRatio(text: string, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const tokens = new Set(tokenize(text));
  return terms.filter((term) => tokens.has(term)).length / terms.length;
}

function parseDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 100) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isClearlyStale(date: string | undefined): boolean {
  if (!date) {
    return false;
  }
  return Date.now() - Date.parse(date) > 540 * 24 * 60 * 60_000;
}

function classifyCandidate(result: GamingSearchResult): GamingDiscoveredCandidate["characteristics"] {
  const parsedUrl = new URL(result.url);
  const domain = normalizeDomain(parsedUrl.hostname);
  const haystack = `${result.title} ${result.snippet ?? ""} ${result.url}`;
  const patchLikely = /\b(?:balance|hotfix|patch|release notes?|update|version)\b/i.test(haystack);
  const wikiLikely = /(?:^|\.)wiki(?:\.|$)|\bwiki\b/i.test(`${domain} ${result.title}`);
  const guideLikely = /\b(?:build|guide|progression|route|tips?|walkthrough)\b/i.test(haystack);
  const officialLikely = getGamingDiscoveryOfficialDomains().some((candidate) =>
    domainMatches(domain, candidate)
  );
  const wikiArticle = /\/index\.php$/iu.test(parsedUrl.pathname) && Boolean(parsedUrl.searchParams.get("title"))
    && !/^(?:category|special):/iu.test(parsedUrl.searchParams.get("title")!);
  const articleLikely = !/^\/?$/.test(parsedUrl.pathname)
    && (wikiArticle || !/\b(?:category|categories|index|tags?)\b|\/(?:forums?)\/?$/iu.test(parsedUrl.pathname));
  return {
    officialLikely,
    patchLikely,
    wikiLikely,
    guideLikely,
    articleLikely
  };
}

/** Compare only the existing bounded numeral suffix, without changing title identity policy. */
function discoveryInstallment(value: string): string {
  const numeral = value.toLowerCase();
  if (!/^(?=.+)(?:xxx|xx|x)?(?:ix|iv|v?i{0,3})$/u.test(numeral)) return numeral;
  const digits: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let index = 0; index < numeral.length; index += 1) {
    const current = digits[numeral[index]];
    total += current < (digits[numeral[index + 1]] ?? 0) ? -current : current;
  }
  return String(total);
}

function scoreDiscoveredCandidate(
  result: GamingSearchResult,
  input: GamingDiscoveryInput,
  topicTerms: readonly string[]
): GamingDiscoveredCandidate | undefined {
  const gameTerms = tokenize(input.game ?? "").filter((term) => !QUERY_STOP_WORDS.has(term));
  const titleAndUrl = `${result.title} ${result.url}`;
  const fullSearchText = `${titleAndUrl} ${result.snippet ?? ""}`;
  // A numbered series title must not spend a fetch slot on an explicitly
  // different installment. This negative metadata hint grants no positive identity.
  const numberedGame = /^(.*?)[\s-]+(\d+(?:\.\d+)?|[ivx]{1,6})$/iu.exec(input.game?.trim() ?? "");
  if (numberedGame) {
    const titlePattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${gamingRegistryLiteralPattern(numberedGame[1])}[\\s-]+(\\d+(?:\\.\\d+)?|[ivx]{1,6})(?=$|[^\\p{L}\\p{N}])`, "giu");
    const installments = Array.from(result.title.slice(0, MAX_SEARCH_TITLE_CHARS).matchAll(titlePattern), match => discoveryInstallment(match[1]));
    // Comparison titles can name several installments. Reject only when every
    // explicit same-series title differs; acquisition still verifies relevance.
    if (installments.length && !installments.includes(discoveryInstallment(numberedGame[2]))) return undefined;
  }
  if (tokenize(`${result.title} ${result.snippet ?? ""}`).length < 4) {
    return undefined;
  }
  const gameOverlap = matchedTokenRatio(fullSearchText, gameTerms);
  if (gameTerms.length > 0 && gameOverlap < Math.min(1, Math.max(0.5, 1 / gameTerms.length))) {
    return undefined;
  }

  const topicTitleOverlap = matchedTokenRatio(titleAndUrl, topicTerms);
  const topicSnippetOverlap = matchedTokenRatio(result.snippet ?? "", topicTerms);
  const characteristics = classifyCandidate(result);
  const evidenceDate = result.updatedAt ?? result.publishedAt;
  if (input.patchSensitive && isClearlyStale(evidenceDate)) {
    return undefined;
  }
  const rankScore = 1 / Math.max(1, Math.min(MAX_PROVIDER_RANK, result.providerRank));
  const modeScore = input.mode === "meta"
    ? (characteristics.patchLikely ? 1 : 0)
    : input.mode === "build"
      ? (/\b(?:build|gear|loadout|rotation|skill|stats?|talent|weapon)\b/i.test(fullSearchText) ? 1 : 0)
      : (characteristics.guideLikely ? 1 : 0);
  const freshnessScore = input.patchSensitive && evidenceDate
    ? Math.max(0, 1 - (Date.now() - Date.parse(evidenceDate)) / (365 * 24 * 60 * 60_000))
    : 0;
  const score = Math.max(0, Math.min(1,
    0.08
    + gameOverlap * 0.28
    + topicTitleOverlap * 0.2
    + topicSnippetOverlap * 0.1
    + modeScore * 0.1
    + rankScore * 0.08
    + (characteristics.articleLikely ? 0.04 : -0.2)
    - (topicTerms.length && topicTitleOverlap === 0 && topicSnippetOverlap === 0 ? 0.1 : 0)
    + (characteristics.officialLikely ? 0.08 : 0)
    + (characteristics.wikiLikely && input.mode === "guide" ? 0.06 : 0)
    + (characteristics.patchLikely && input.patchSensitive ? 0.08 : 0)
    + freshnessScore * 0.08
  ));
  const suggestedSourceType = characteristics.officialLikely
    ? (characteristics.patchLikely ? "patch_notes" : "official")
    : characteristics.wikiLikely
      ? "wiki"
      : "curated";
  return {
    ...result,
    score,
    suggestedSourceType,
    stable: input.mode === "guide" && !input.patchSensitive,
    freshnessKnown: Boolean(evidenceDate),
    characteristics
  };
}

function cloneSearchResults(results: GamingSearchResult[]): GamingSearchResult[] {
  return results.map((result) => ({ ...result }));
}

function pruneDiscoveryCache(now: number): void {
  for (const [key, entry] of discoveryCache.entries()) {
    if (entry.expiresAt <= now) {
      discoveryCache.delete(key);
    }
  }
  const maxEntries = getGamingDiscoveryCacheMaxEntries();
  while (discoveryCache.size >= maxEntries) {
    const oldestKey = discoveryCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    discoveryCache.delete(oldestKey);
  }
}

export function clearGamingDiscoveryCache(): void {
  discoveryCache.clear();
  warnedMissingProviderConfiguration = false;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Gaming discovery provider response exceeded the configured size limit.");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Gaming discovery provider response exceeded the configured size limit.");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function normalizeBraveResults(payload: BraveSearchApiResponse, limit: number): GamingSearchResult[] {
  const rawResults = payload.web?.results;
  if (!Array.isArray(rawResults)) {
    if (rawResults === undefined) {
      return [];
    }
    throw new Error("Gaming discovery provider returned an invalid result list.");
  }
  return rawResults.slice(0, limit).flatMap((rawResult, index): GamingSearchResult[] => {
    if (!rawResult || typeof rawResult !== "object") {
      return [];
    }
    const item = rawResult as BraveSearchApiResult;
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const title = safeSearchText(item.title, MAX_SEARCH_TITLE_CHARS);
    if (!url || !title) {
      return [];
    }
    const snippet = safeSearchText(item.description, MAX_SEARCH_SNIPPET_CHARS);
    const publishedAt = parseDate(item.page_age ?? item.age);
    return [{
      url,
      title,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      providerRank: index + 1,
      provider: "brave"
    }];
  });
}

export function createBraveGamingSearchProvider(): GamingSearchProvider {
  return {
    id: "brave",
    version: BRAVE_PROVIDER_VERSION,
    isConfigured: () => Boolean(getEnv("BRAVE_SEARCH_API_KEY")?.trim()),
    async search(input): Promise<GamingSearchResult[]> {
      const credential = getEnv("BRAVE_SEARCH_API_KEY")?.trim();
      if (!credential) {
        throw new Error("Gaming discovery search provider is not configured.");
      }
      const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
      endpoint.searchParams.set("q", input.query);
      endpoint.searchParams.set("count", String(input.resultLimit));
      endpoint.searchParams.set("result_filter", "web");
      endpoint.searchParams.set("text_decorations", "false");
      endpoint.searchParams.set("safesearch", "strict");
      if (input.freshnessPreference === "current") {
        endpoint.searchParams.set("freshness", "py");
      }
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json",
          "x-subscription-token": credential
        },
        redirect: "error",
        signal: input.signal
      });
      if (!response.ok) {
        const error = new Error(`Gaming discovery provider request failed with status ${response.status}.`);
        Object.assign(error, { status: response.status });
        throw error;
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new Error("Gaming discovery provider returned an unsupported content type.");
      }
      const rawBody = await readBoundedResponseText(response, getGamingDiscoveryMaxProviderResponseBytes());
      let payload: BraveSearchApiResponse;
      try {
        payload = JSON.parse(rawBody) as BraveSearchApiResponse;
      } catch {
        throw new Error("Gaming discovery provider returned invalid JSON.");
      }
      return normalizeBraveResults(payload, input.resultLimit);
    }
  };
}

function resolveConfiguredProvider(override?: GamingSearchProvider): GamingSearchProvider | undefined {
  if (override) {
    return override;
  }
  return getGamingDiscoveryProvider() === "brave" ? createBraveGamingSearchProvider() : undefined;
}

function safeProviderIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64) || "unknown";
}

function normalizeProviderResults(results: unknown, resultLimit: number): GamingSearchResult[] | undefined {
  if (!Array.isArray(results)) {
    return undefined;
  }
  const normalized = results.slice(0, resultLimit).flatMap((result, index): GamingSearchResult[] => {
    if (!result || typeof result !== "object") {
      return [];
    }
    const record = result as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const title = safeSearchText(record.title, MAX_SEARCH_TITLE_CHARS);
    if (!url || !title) {
      return [];
    }
    const snippet = safeSearchText(record.snippet, MAX_SEARCH_SNIPPET_CHARS);
    const publishedAt = parseDate(record.publishedAt);
    const updatedAt = parseDate(record.updatedAt);
    const rank = typeof record.providerRank === "number" && Number.isFinite(record.providerRank)
      ? Math.max(1, Math.min(MAX_PROVIDER_RANK, Math.floor(record.providerRank)))
      : index + 1;
    const provider = typeof record.provider === "string" && record.provider.trim()
      ? safeProviderIdentifier(record.provider)
      : "unknown";
    return [{
      url,
      title,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      providerRank: rank,
      provider
    }];
  });
  return results.length > 0 && normalized.length === 0 ? undefined : normalized;
}

function createDiscoveryAbort(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cancel: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cancel: () => controller.abort(),
    cleanup: () => {
      clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function runProviderSearchWithAbort(
  provider: GamingSearchProvider,
  request: GamingSearchRequest
): Promise<GamingSearchResult[]> {
  if (request.signal.aborted) {
    const error = new Error("Gaming discovery provider request was aborted.");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      const error = new Error("Gaming discovery provider request was aborted.");
      error.name = "AbortError";
      reject(error);
    };
    request.signal.addEventListener("abort", handleAbort, { once: true });
    provider.search(request).then(resolve, reject).finally(() => {
      request.signal.removeEventListener("abort", handleAbort);
    });
  });
}

function emptyDiscoveryResult(
  startedAt: number,
  reason: GamingDiscoveryFailureReason,
  params: Partial<GamingDiscoveryResult> = {}
): GamingDiscoveryResult {
  return {
    candidates: [],
    searchResultCount: 0,
    candidateCount: 0,
    rejectedCandidateCount: 0,
    discoveryCacheHit: false,
    candidateRankingElapsedMs: 0,
    ...params,
    discoveryElapsedMs: Date.now() - startedAt,
    discoveryFailureReason: reason
  };
}

/** Discover bounded public URL hints, applying URL policy and prior-attempt exclusions
 * before ranking fetch candidates. Search metadata never becomes acquired evidence.
 * @param input Sanitized gameplay intent, optional provider and cancellation scope.
 * @returns Ranked candidate hints or a controlled discovery failure within existing budgets.
 */
export async function discoverGamingSources(input: GamingDiscoveryInput): Promise<GamingDiscoveryResult> {
  const startedAt = Date.now();
  if (!getGamingDiscoveryEnabled()) {
    return emptyDiscoveryResult(startedAt, "DISCOVERY_DISABLED");
  }
  const provider = resolveConfiguredProvider(input.provider);
  const providerId = provider ? safeProviderIdentifier(provider.id) : undefined;
  if (!provider || !provider.isConfigured()) {
    if (!warnedMissingProviderConfiguration) {
      warnedMissingProviderConfiguration = true;
      logger.warn("gaming.discovery.disabled", {
        reason: "provider_unconfigured",
        searchProvider: providerId ?? getGamingDiscoveryProvider() ?? "unsupported"
      });
    }
    return emptyDiscoveryResult(startedAt, "DISCOVERY_PROVIDER_UNCONFIGURED", {
      ...(providerId ? { searchProvider: providerId } : {})
    });
  }

  const patchSensitive = input.patchSensitive === true || input.mode === "meta";
  const freshnessPreference: GamingSearchFreshnessPreference = patchSensitive ? "current" : "stable";
  const query = buildGamingDiscoveryQuery({ ...input, patchSensitive });
  if (!query) {
    return emptyDiscoveryResult(startedAt, "DISCOVERY_NO_RESULTS", { searchProvider: providerId });
  }
  const resultLimit = getGamingDiscoverySearchResultLimit();
  const queries = input.queryVariants ? buildGamingDiscoveryQueries({ ...input, patchSensitive }).slice(0, resultLimit) : [query];
  const queryHash = createHash("sha256").update(queries.length === 1 ? query : JSON.stringify(queries)).digest("hex");
  const querySummary = {
    charCount: queries.reduce((count, item) => count + item.length, 0),
    termCount: queries.reduce((count, item) => count + tokenize(item).length, 0),
    freshnessPreference
  };
  const cacheKey = createHash("sha256").update(JSON.stringify({
    provider: providerId,
    version: provider.version,
    game: input.game?.trim().toLowerCase() ?? "",
    mode: input.mode,
    queries,
    resultLimit,
    freshnessPreference
  })).digest("hex");
  const now = Date.now();
  const cached = discoveryCache.get(cacheKey);
  let searchResults: GamingSearchResult[];
  let cacheHit = false;
  if (!input.refreshSearch && cached && cached.expiresAt > now) {
    searchResults = cloneSearchResults(cached.results);
    cacheHit = true;
  } else {
    const timeoutMs = Math.min(getGamingDiscoveryTimeoutMs(), getGamingDiscoveryBudgetMs());
    const discoveryAbort = createDiscoveryAbort(input.signal, timeoutMs);
    try {
      // Variations partition the existing result ceiling and share one deadline.
      // They are independent searches, never retries after transport failures.
      const perQueryLimits = queries.map((_item, index) => Math.floor(resultLimit / queries.length)
        + (index < resultLimit % queries.length ? 1 : 0));
      const providerResults = await Promise.all(queries.map((plannedQuery, index) => runProviderSearchWithAbort(provider, {
        query: plannedQuery,
        ...(input.game ? { game: input.game } : {}),
        mode: input.mode,
        freshnessPreference,
        resultLimit: perQueryLimits[index],
        signal: discoveryAbort.signal
      })));
      const normalizedResults = providerResults.map((results, index) => normalizeProviderResults(results, perQueryLimits[index]));
      if (normalizedResults.some(results => results === undefined)) {
        return emptyDiscoveryResult(startedAt, "DISCOVERY_PROVIDER_ERROR", {
          searchProvider: providerId,
          searchQueryHash: queryHash,
          searchQuerySummary: querySummary
        });
      }
      searchResults = normalizedResults.flatMap(results => results ?? []);
      pruneDiscoveryCache(now);
      discoveryCache.set(cacheKey, {
        expiresAt: now + getGamingDiscoveryQueryCacheTtlMs(input.mode, patchSensitive),
        results: cloneSearchResults(searchResults)
      });
    } catch (error) {
      discoveryAbort.cancel();
      const timedOut = discoveryAbort.didTimeout()
        || (error instanceof Error && (error.name === "AbortError" || /timed?\s*out|timeout/i.test(error.message)));
      return emptyDiscoveryResult(startedAt, timedOut ? "DISCOVERY_PROVIDER_TIMEOUT" : "DISCOVERY_PROVIDER_ERROR", {
        searchProvider: providerId,
        searchQueryHash: queryHash,
        searchQuerySummary: querySummary
      });
    } finally {
      discoveryAbort.cleanup();
    }
  }

  if (searchResults.length === 0) {
    return emptyDiscoveryResult(startedAt, "DISCOVERY_NO_RESULTS", {
      searchProvider: providerId,
      searchQueryHash: queryHash,
      searchQuerySummary: querySummary,
      discoveryCacheHit: cacheHit
    });
  }

  const rankingStartedAt = Date.now();
  const topicTerms = buildQueryTopicTerms(input);
  const deduped = new Map<string, GamingSearchResult>();
  const excludedUrls = new Set((input.excludedUrls ?? []).flatMap(url => {
    const admission = sanitizeGamingDiscoveryCandidateUrl(url);
    return admission.url && !admission.rejected ? [gamingSourceAcquisitionIdentity(admission.url)] : [];
  }));
  let rejectedCandidateCount = 0;
  for (const result of searchResults) {
    const normalizedUrl = sanitizeGamingDiscoveryCandidateUrl(result.url);
    if (normalizedUrl.rejected || !normalizedUrl.url) {
      rejectedCandidateCount += 1;
      continue;
    }
    const acquisitionIdentity = gamingSourceAcquisitionIdentity(normalizedUrl.url);
    if (excludedUrls.has(acquisitionIdentity)) {
      rejectedCandidateCount += 1;
      continue;
    }
    const canonicalKey = createHash("sha256").update(acquisitionIdentity).digest("hex");
    const normalizedResult = { ...result, url: normalizedUrl.url };
    const existing = deduped.get(canonicalKey);
    if (!existing || normalizedResult.providerRank < existing.providerRank) {
      if (existing) {
        rejectedCandidateCount += 1;
      }
      deduped.set(canonicalKey, normalizedResult);
    } else {
      rejectedCandidateCount += 1;
    }
  }
  if (deduped.size === 0) {
    return emptyDiscoveryResult(startedAt, "DISCOVERY_ALL_CANDIDATES_REJECTED", {
      searchProvider: providerId,
      searchQueryHash: queryHash,
      searchQuerySummary: querySummary,
      searchResultCount: searchResults.length,
      rejectedCandidateCount,
      discoveryCacheHit: cacheHit,
      candidateRankingElapsedMs: Date.now() - rankingStartedAt
    });
  }

  const scoredCandidates = Array.from(deduped.values()).flatMap((result): GamingDiscoveredCandidate[] => {
    const candidate = scoreDiscoveredCandidate(result, { ...input, patchSensitive }, topicTerms);
    if (!candidate || candidate.score < getGamingDiscoveryMinCandidateScore()) {
      rejectedCandidateCount += 1;
      return [];
    }
    return [candidate];
  }).sort((left, right) =>
    right.score - left.score
    || left.providerRank - right.providerRank
    || left.url.localeCompare(right.url)
  );
  // A modest repeated-host penalty diversifies similarly suitable pages. Strong
  // topic matches still win; this ranking never establishes evidence authority.
  const candidates: GamingDiscoveredCandidate[] = [];
  const domainCounts = new Map<string, number>();
  const remaining = [...scoredCandidates];
  const adjustedScore = (candidate: GamingDiscoveredCandidate) => candidate.score
    - 0.08 * (domainCounts.get(normalizeDomain(new URL(candidate.url).hostname)) ?? 0);
  while (remaining.length && candidates.length < getGamingDiscoveryFetchCandidateLimit()) {
    remaining.sort((left, right) => adjustedScore(right) - adjustedScore(left)
      || right.score - left.score || left.providerRank - right.providerRank || left.url.localeCompare(right.url));
    const candidate = remaining.shift()!;
    candidates.push(candidate);
    const domain = normalizeDomain(new URL(candidate.url).hostname);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }
  const rankingElapsedMs = Date.now() - rankingStartedAt;
  if (candidates.length === 0) {
    return emptyDiscoveryResult(startedAt, "DISCOVERY_LOW_QUALITY", {
      searchProvider: providerId,
      searchQueryHash: queryHash,
      searchQuerySummary: querySummary,
      searchResultCount: searchResults.length,
      rejectedCandidateCount,
      discoveryCacheHit: cacheHit,
      candidateRankingElapsedMs: rankingElapsedMs
    });
  }

  return {
    candidates,
    searchProvider: providerId,
    searchQueryHash: queryHash,
    searchQuerySummary: querySummary,
    searchResultCount: searchResults.length,
    candidateCount: candidates.length,
    rejectedCandidateCount,
    discoveryCacheHit: cacheHit,
    discoveryElapsedMs: Date.now() - startedAt,
    candidateRankingElapsedMs: rankingElapsedMs
  };
}
