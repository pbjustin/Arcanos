import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnv } from "@platform/runtime/env.js";
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
import type { GamingMode } from "@services/gamingModes.js";

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

export type GamingDiscoveryFailureReason =
  | "DISCOVERY_DISABLED"
  | "DISCOVERY_NOT_NEEDED"
  | "DISCOVERY_NO_RESULTS"
  | "DISCOVERY_PROVIDER_TIMEOUT"
  | "DISCOVERY_PROVIDER_ERROR"
  | "DISCOVERY_ALL_CANDIDATES_REJECTED"
  | "DISCOVERY_FETCH_FAILED"
  | "DISCOVERY_BUDGET_EXHAUSTED"
  | "DISCOVERY_LOW_QUALITY";

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

export interface GamingDiscoveryInput {
  prompt: string;
  game?: string;
  mode: GamingMode;
  patchSensitive?: boolean;
  signal?: AbortSignal;
  provider?: GamingSearchProvider;
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
const MAX_QUERY_TOPIC_TERMS = 7;
const MAX_PROVIDER_RANK = 100;
const TRACKING_PARAM_PATTERN = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|ref_src|ref_url|source|campaign|campaignid)$/i;
const SENSITIVE_PARAM_PATTERN = /(?:^|[_-])(?:access|api|auth|bearer|credential|key|password|secret|sig|signature|token)(?:$|[_-])|^x-amz-/i;
const SENSITIVE_VALUE_PATTERN = /^(?:sk-|gh[opusr]_|eyj[a-z0-9_-]*\.|bearer\s+)/i;
const FILE_DOWNLOAD_PATTERN = /\.(?:7z|avi|bin|dmg|docx?|exe|gz|iso|mov|mp3|mp4|msi|pdf|pkg|rar|tar|wav|webm|xlsx?|zip)$/i;
const ACCOUNT_PATH_PATTERN = /\/(?:account|accounts|auth|login|log-in|register|registration|sign-in|signin|signup)(?:\/|$)/i;
const SEARCH_PATH_PATTERN = /\/(?:search|search-results|results)(?:\/|$)/i;
const CONTENT_FARM_DOMAIN_PATTERN = /(?:^|[.-])(?:clickbait|content-?farm|scraper|seo-?spam|spam)(?:[.-]|$)/i;
const SOURCE_INSTRUCTION_PATTERN = /(?:\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)|forget\s+(?:everything|all)(?:\s+(?:written|said))?\s+(?:above|before)|you\s+are\s+now|(?:reveal|print|show|expose)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)|(?:call|invoke)\s+(?:the\s+)?(?:tool|function)|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b|(?:^|\s|\[|<\|)(?:system|developer|assistant|user)(?:\s*:|\]|\|>))/i;
const LOW_SIGNAL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be"
];
const URL_SHORTENER_DOMAINS = [
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "rebrand.ly",
  "shorturl.at",
  "tinyurl.com",
  "t.co"
];
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
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, " ")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, " ")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/g, " ")
    .replace(/\b(?:access[_-]?token|api[_-]?key|auth[_-]?token|cookie|credential|password|secret|session[_-]?id|token)\s*[:=]\s*[^\s,;]+/gi, " ")
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

function buildQueryTopicTerms(prompt: string, game?: string): string[] {
  const gameTerms = new Set(tokenize(game ?? ""));
  return tokenize(stripUntrustedInstructions(prompt).slice(0, 1_000))
    .filter((term) => !QUERY_STOP_WORDS.has(term) && !gameTerms.has(term))
    .slice(0, MAX_QUERY_TOPIC_TERMS);
}

export function buildGamingDiscoveryQuery(input: Pick<GamingDiscoveryInput, "prompt" | "game" | "mode" | "patchSensitive">): string {
  const game = safeSearchText(input.game, 100);
  const topicTerms = buildQueryTopicTerms(input.prompt, game);
  const gameSegment = game
    ? (game.includes(" ") ? `"${game.replace(/[\"\\]/g, " ").replace(/\s+/g, " ").trim()}"` : game)
    : "";
  const topicText = topicTerms.join(" ");
  let modeSegment = input.mode === "guide" ? "guide" : input.mode === "build" ? "build" : "meta";
  if (input.patchSensitive || input.mode === "meta") {
    modeSegment = "latest patch";
  } else if (/\bwalkthrough\b/i.test(topicText)) {
    modeSegment = "";
  }

  return [gameSegment, topicText, modeSegment]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_QUERY_CHARS)
    .trim();
}

function normalizeDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function domainMatches(domain: string, candidate: string): boolean {
  const normalizedCandidate = normalizeDomain(candidate);
  return domain === normalizedCandidate || domain.endsWith(`.${normalizedCandidate}`);
}

function isInternalIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first, second, third] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isInternalHost(hostname: string): boolean {
  const normalized = normalizeDomain(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  const ipFamily = isIP(normalized);
  if (ipFamily === 4) {
    return isInternalIpv4(normalized);
  }
  if (ipFamily === 6) {
    const compact = normalized.toLowerCase();
    return compact === "::" || compact === "::1" || compact.startsWith("fc") || compact.startsWith("fd")
      || /^fe[89ab]/.test(compact) || /^fe[c-f]/.test(compact) || compact.startsWith("ff")
      || compact === "2001:db8" || compact.startsWith("2001:db8:") || compact.startsWith("::ffff:");
  }
  return false;
}

function sanitizeCandidateUrl(rawUrl: string): { url?: string; rejected: boolean } {
  if (rawUrl.length === 0 || rawUrl.length > MAX_SEARCH_RESULT_URL_CHARS) {
    return { rejected: true };
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.port) {
      return { rejected: true };
    }
    const domain = normalizeDomain(parsed.hostname);
    if (!domain || isInternalHost(domain)) {
      return { rejected: true };
    }
    if (LOW_SIGNAL_DOMAINS.some((candidate) => domainMatches(domain, candidate))
      || URL_SHORTENER_DOMAINS.some((candidate) => domainMatches(domain, candidate))
      || CONTENT_FARM_DOMAIN_PATTERN.test(domain)) {
      return { rejected: true };
    }
    const allowlist = getGamingDiscoveryDomainAllowlist();
    const blocklist = getGamingDiscoveryDomainBlocklist();
    if ((allowlist.length > 0 && !allowlist.some((candidate) => domainMatches(domain, candidate)))
      || blocklist.some((candidate) => domainMatches(domain, candidate))) {
      return { rejected: true };
    }
    if (ACCOUNT_PATH_PATTERN.test(parsed.pathname) || SEARCH_PATH_PATTERN.test(parsed.pathname)
      || FILE_DOWNLOAD_PATTERN.test(parsed.pathname)) {
      return { rejected: true };
    }

    let trackingParamCount = 0;
    for (const [key, value] of Array.from(parsed.searchParams.entries())) {
      if (SENSITIVE_PARAM_PATTERN.test(key) || SENSITIVE_VALUE_PATTERN.test(value)) {
        return { rejected: true };
      }
      if (TRACKING_PARAM_PATTERN.test(key)) {
        parsed.searchParams.delete(key);
        trackingParamCount += 1;
      }
    }
    if (trackingParamCount >= 5 || Array.from(parsed.searchParams.keys()).length > 10) {
      return { rejected: true };
    }
    parsed.hostname = domain;
    parsed.hash = "";
    parsed.searchParams.sort();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    return { url: parsed.toString(), rejected: false };
  } catch {
    return { rejected: true };
  }
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
  const domain = normalizeDomain(new URL(result.url).hostname);
  const haystack = `${result.title} ${result.snippet ?? ""} ${result.url}`;
  const patchLikely = /\b(?:balance|hotfix|patch|release notes?|update|version)\b/i.test(haystack);
  const wikiLikely = /(?:^|\.)wiki(?:\.|$)|\bwiki\b/i.test(`${domain} ${result.title}`);
  const guideLikely = /\b(?:build|guide|progression|route|tips?|walkthrough)\b/i.test(haystack);
  const officialLikely = getGamingDiscoveryOfficialDomains().some((candidate) =>
    domainMatches(domain, candidate)
  );
  const articleLikely = !/^\/?$/.test(new URL(result.url).pathname)
    && !/\b(?:category|forum|forums|index|tag)\b/i.test(new URL(result.url).pathname);
  return {
    officialLikely,
    patchLikely,
    wikiLikely,
    guideLikely,
    articleLikely
  };
}

function scoreDiscoveredCandidate(
  result: GamingSearchResult,
  input: GamingDiscoveryInput,
  topicTerms: readonly string[]
): GamingDiscoveredCandidate | undefined {
  const gameTerms = tokenize(input.game ?? "").filter((term) => !QUERY_STOP_WORDS.has(term));
  const titleAndUrl = `${result.title} ${result.url}`;
  const fullSearchText = `${titleAndUrl} ${result.snippet ?? ""}`;
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
    + (characteristics.articleLikely ? 0.04 : -0.08)
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
    return emptyDiscoveryResult(startedAt, "DISCOVERY_DISABLED", {
      ...(providerId ? { searchProvider: providerId } : {})
    });
  }

  const patchSensitive = input.patchSensitive === true || input.mode === "meta";
  const freshnessPreference: GamingSearchFreshnessPreference = patchSensitive ? "current" : "stable";
  const query = buildGamingDiscoveryQuery({ ...input, patchSensitive });
  if (!query) {
    return emptyDiscoveryResult(startedAt, "DISCOVERY_NO_RESULTS", { searchProvider: providerId });
  }
  const queryHash = createHash("sha256").update(query).digest("hex");
  const querySummary = {
    charCount: query.length,
    termCount: tokenize(query).length,
    freshnessPreference
  };
  const cacheKey = createHash("sha256").update(JSON.stringify({
    provider: providerId,
    version: provider.version,
    game: input.game?.trim().toLowerCase() ?? "",
    mode: input.mode,
    topic: buildQueryTopicTerms(input.prompt, input.game).join(" "),
    freshnessPreference
  })).digest("hex");
  const now = Date.now();
  const cached = discoveryCache.get(cacheKey);
  let searchResults: GamingSearchResult[];
  let cacheHit = false;
  if (cached && cached.expiresAt > now) {
    searchResults = cloneSearchResults(cached.results);
    cacheHit = true;
  } else {
    const timeoutMs = Math.min(getGamingDiscoveryTimeoutMs(), getGamingDiscoveryBudgetMs());
    const discoveryAbort = createDiscoveryAbort(input.signal, timeoutMs);
    try {
      const providerResults = await runProviderSearchWithAbort(provider, {
        query,
        ...(input.game ? { game: input.game } : {}),
        mode: input.mode,
        freshnessPreference,
        resultLimit: getGamingDiscoverySearchResultLimit(),
        signal: discoveryAbort.signal
      });
      const normalizedResults = normalizeProviderResults(providerResults, getGamingDiscoverySearchResultLimit());
      if (!normalizedResults) {
        return emptyDiscoveryResult(startedAt, "DISCOVERY_PROVIDER_ERROR", {
          searchProvider: providerId,
          searchQueryHash: queryHash,
          searchQuerySummary: querySummary
        });
      }
      searchResults = normalizedResults;
      pruneDiscoveryCache(now);
      discoveryCache.set(cacheKey, {
        expiresAt: now + getGamingDiscoveryQueryCacheTtlMs(input.mode, patchSensitive),
        results: cloneSearchResults(searchResults)
      });
    } catch (error) {
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
  const topicTerms = buildQueryTopicTerms(input.prompt, input.game);
  const deduped = new Map<string, GamingSearchResult>();
  let rejectedCandidateCount = 0;
  for (const result of searchResults) {
    const normalizedUrl = sanitizeCandidateUrl(result.url);
    if (normalizedUrl.rejected || !normalizedUrl.url) {
      rejectedCandidateCount += 1;
      continue;
    }
    const canonicalKey = createHash("sha256").update(normalizedUrl.url.toLowerCase()).digest("hex");
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
  const candidates = scoredCandidates.slice(0, getGamingDiscoveryFetchCandidateLimit());
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
