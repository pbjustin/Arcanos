import { createHash } from "node:crypto";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnv } from "@platform/runtime/env.js";
import { fetchAndClean } from "@shared/webFetcher.js";
import {
  getGamingRagChunkChars,
  getGamingRagEnabled,
  getGamingRagMaxChunks,
  getGamingRagMaxSources,
  getGamingRagTtlMs,
  getGamingWebContextFetchTimeoutMs,
  getGamingWebContextMaxChars,
  getGamingWebContextMaxUrls
} from "@services/gamingConfig.js";
import type { GamingMode, GamingSuccessEnvelope, ValidatedGamingRequest } from "@services/gamingModes.js";

export type GamingWebSource = GamingSuccessEnvelope["data"]["sources"][number];

export type GamingWebContext = {
  context: string;
  sources: GamingWebSource[];
};

export type GamingRagContext = GamingWebContext & {
  retrievalEnabled: boolean;
  retrievalReason: string;
  retrievalQuery: string;
  sourceDomains: string[];
  cacheHit: boolean;
  retrievalElapsedMs: number;
  rankingElapsedMs: number;
  fallbackReason?: string;
  clear: {
    contextGrounded: boolean;
    limitedEvidence: boolean;
    explicitUncertainty: boolean;
    attributableSources: boolean;
    robustFallback: boolean;
    passed: boolean;
  };
};

export type GamingGuideUrlInput = Pick<ValidatedGamingRequest, "guideUrl" | "guideUrls">;
export type GamingRagInput = Pick<ValidatedGamingRequest, "mode" | "prompt" | "game" | "guideUrl" | "guideUrls">;

export type GamingWebContextLogContext = {
  module: "ARCANOS:GAMING";
  route: "gaming";
  mode: GamingMode;
  sourceEndpoint: string;
  requestId?: string;
  traceId?: string;
};

type GamingSourceType = "official" | "patch_notes" | "wiki" | "curated" | "supplied";

type GamingSourceCandidate = {
  url: string;
  title: string;
  sourceType: GamingSourceType;
  trustScore: number;
  topics: string[];
  modes: GamingMode[];
  stable: boolean;
  supplied: boolean;
};

type GamingFetchedDocument = {
  candidate: GamingSourceCandidate;
  text: string;
  fetchedAt: string;
  cacheHit: boolean;
};

type GamingRankedChunk = {
  candidate: GamingSourceCandidate;
  text: string;
  score: number;
  hash: string;
};

const KNOWN_GAME_ALIASES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\belden\s+ring\b/i, name: "Elden Ring" },
  { pattern: /\bworld\s+of\s+warcraft\b|\bwow\b/i, name: "World of Warcraft" },
  { pattern: /\b(?:star\s+wars:\s*)?the\s+old\s+republic\b|\bswtor\b/i, name: "Star Wars: The Old Republic" },
  { pattern: /\bdestiny\s+2\b/i, name: "Destiny 2" },
  { pattern: /\bdiablo\s+(?:4|iv)\b/i, name: "Diablo 4" },
  { pattern: /\bpath\s+of\s+exile(?:\s+2)?\b/i, name: "Path of Exile" },
  { pattern: /\bbaldur'?s\s+gate\s+3\b/i, name: "Baldur's Gate 3" }
];

const TRUSTED_DOMAIN_SCORES: Array<{ domain: string; score: number }> = [
  { domain: "bandainamcoent.com", score: 0.96 },
  { domain: "en.bandainamcoent.eu", score: 0.96 },
  { domain: "worldofwarcraft.blizzard.com", score: 0.96 },
  { domain: "blizzard.com", score: 0.94 },
  { domain: "swtor.com", score: 0.94 },
  { domain: "bungie.net", score: 0.94 },
  { domain: "diablo4.blizzard.com", score: 0.94 },
  { domain: "pathofexile.com", score: 0.94 },
  { domain: "wiki.fextralife.com", score: 0.76 },
  { domain: "fextralife.com", score: 0.74 },
  { domain: "wowhead.com", score: 0.82 },
  { domain: "icy-veins.com", score: 0.78 },
  { domain: "maxroll.gg", score: 0.78 },
  { domain: "swtorista.com", score: 0.78 },
  { domain: "vulkk.com", score: 0.74 },
  { domain: "bg3.wiki", score: 0.78 },
  { domain: "poewiki.net", score: 0.8 }
];

const LOW_QUALITY_DOMAINS = [
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "x.com",
  "twitter.com"
];

const BUILTIN_SOURCE_CATALOG: Array<{ game: string; sources: Array<Omit<GamingSourceCandidate, "trustScore" | "supplied">> }> = [
  {
    game: "Elden Ring",
    sources: [
      {
        title: "Elden Ring official news and patch notes",
        url: "https://en.bandainamcoent.eu/elden-ring/news",
        sourceType: "patch_notes",
        topics: ["patch", "latest", "news", "meta", "balance"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "Elden Ring wiki walkthrough",
        url: "https://eldenring.wiki.fextralife.com/Game+Progress+Route",
        sourceType: "wiki",
        topics: ["guide", "walkthrough", "route", "progress", "limgrave", "tutorial"],
        modes: ["guide"],
        stable: true
      },
      {
        title: "Elden Ring wiki builds",
        url: "https://eldenring.wiki.fextralife.com/Builds",
        sourceType: "wiki",
        topics: ["build", "bleed", "stats", "weapons", "talismans"],
        modes: ["build"],
        stable: true
      },
      {
        title: "Elden Ring wiki status effects",
        url: "https://eldenring.wiki.fextralife.com/Status+Effects",
        sourceType: "wiki",
        topics: ["bleed", "frost", "poison", "status", "build"],
        modes: ["build", "guide"],
        stable: true
      }
    ]
  },
  {
    game: "World of Warcraft",
    sources: [
      {
        title: "World of Warcraft official news",
        url: "https://worldofwarcraft.blizzard.com/en-us/news",
        sourceType: "patch_notes",
        topics: ["patch", "hotfix", "latest", "meta", "balance"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "Wowhead Frost Mage guide",
        url: "https://www.wowhead.com/guide/classes/mage/frost/overview",
        sourceType: "curated",
        topics: ["frost", "mage", "build", "talents", "rotation", "viable"],
        modes: ["build", "meta", "guide"],
        stable: false
      },
      {
        title: "Icy Veins Frost Mage guide",
        url: "https://www.icy-veins.com/wow/frost-mage-pve-dps-guide",
        sourceType: "curated",
        topics: ["frost", "mage", "build", "talents", "rotation", "viable"],
        modes: ["build", "meta", "guide"],
        stable: false
      }
    ]
  },
  {
    game: "Star Wars: The Old Republic",
    sources: [
      {
        title: "SWTOR official patch notes",
        url: "https://www.swtor.com/patchnotes",
        sourceType: "patch_notes",
        topics: ["patch", "latest", "balance", "meta"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "SWTOR community guide index",
        url: "https://swtorista.com/articles/",
        sourceType: "curated",
        topics: ["guide", "build", "class", "gearing", "walkthrough"],
        modes: ["guide", "build"],
        stable: true
      }
    ]
  },
  {
    game: "Destiny 2",
    sources: [
      {
        title: "Destiny 2 official news",
        url: "https://www.bungie.net/7/en/News",
        sourceType: "patch_notes",
        topics: ["patch", "twid", "latest", "balance", "meta"],
        modes: ["build", "meta"],
        stable: false
      }
    ]
  },
  {
    game: "Diablo 4",
    sources: [
      {
        title: "Diablo 4 official news",
        url: "https://news.blizzard.com/en-us/diablo4",
        sourceType: "patch_notes",
        topics: ["patch", "season", "build", "meta", "balance"],
        modes: ["build", "meta", "guide"],
        stable: false
      }
    ]
  },
  {
    game: "Baldur's Gate 3",
    sources: [
      {
        title: "Baldur's Gate 3 community wiki",
        url: "https://bg3.wiki/",
        sourceType: "wiki",
        topics: ["guide", "build", "class", "walkthrough"],
        modes: ["guide", "build"],
        stable: true
      }
    ]
  },
  {
    game: "Path of Exile",
    sources: [
      {
        title: "Path of Exile official news",
        url: "https://www.pathofexile.com/news",
        sourceType: "patch_notes",
        topics: ["patch", "league", "build", "meta", "balance"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "Path of Exile wiki",
        url: "https://www.poewiki.net/wiki/Path_of_Exile_Wiki",
        sourceType: "wiki",
        topics: ["guide", "build", "item", "skill"],
        modes: ["guide", "build"],
        stable: true
      }
    ]
  }
];

const documentCache = new Map<string, { text: string; fetchedAt: string; expiresAt: number }>();

export function collectGamingGuideUrls(params: GamingGuideUrlInput): string[] {
  return [
    ...(params.guideUrl ? [params.guideUrl] : []),
    ...params.guideUrls
  ];
}

function isFetchableGuideUrl(url: string): boolean {
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    return false;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function redactUrlCredentials(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.username && !parsedUrl.password) {
      return url;
    }
    parsedUrl.username = "";
    parsedUrl.password = "";
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function readErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function createGamingRetrievalTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Gaming guide source fetch timed out after ${timeoutMs}ms.`);
  Object.assign(error, {
    code: "INTAKE_RETRIEVAL_TIMEOUT",
    timeoutMs,
    timeoutPhase: "retrieval"
  });
  return error;
}

function runWithLocalTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation(controller.signal),
    new Promise<T>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(createGamingRetrievalTimeoutError(timeoutMs));
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function buildSafeSourceLogTarget(url: string): { sourceHost: string; sourcePathLength: number } {
  try {
    const parsedUrl = new URL(url);
    return {
      sourceHost: parsedUrl.host,
      sourcePathLength: parsedUrl.pathname.length
    };
  } catch {
    return {
      sourceHost: "invalid-url",
      sourcePathLength: 0
    };
  }
}

export async function buildGamingWebContext(
  urls: string[],
  logContext?: GamingWebContextLogContext
): Promise<GamingWebContext> {
  if (urls.length === 0) {
    return { context: "", sources: [] };
  }

  const maxContextChars = getGamingWebContextMaxChars();
  const maxUrls = getGamingWebContextMaxUrls();
  const fetchTimeoutMs = getGamingWebContextFetchTimeoutMs();
  const uniqueUrls = Array.from(new Set(urls.map((url) => url.trim()).filter(isFetchableGuideUrl))).slice(0, maxUrls);
  const retrievalStartedAt = Date.now();
  if (logContext) {
    logger.info("gaming.retrieval.start", {
      ...logContext,
      sourceCount: uniqueUrls.length,
      requestedSourceCount: urls.length,
      maxUrls,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  const sources: GamingWebSource[] = await Promise.all(
    uniqueUrls.map(async (url, index): Promise<GamingWebSource> => {
      const sourceUrl = redactUrlCredentials(url);
      const sourceStartedAt = Date.now();
      const sourceLogTarget = buildSafeSourceLogTarget(sourceUrl);
      if (logContext) {
        logger.info("gaming.retrieval.source.start", {
          ...logContext,
          ...sourceLogTarget,
          sourceIndex: index + 1,
          sourceCount: uniqueUrls.length,
          fetchTimeoutMs,
          maxContextChars
        });
      }

      try {
        const snippet = await runWithLocalTimeout(
          (signal) => fetchAndClean(sourceUrl, maxContextChars, { signal, timeoutMs: fetchTimeoutMs }),
          fetchTimeoutMs
        );
        if (logContext) {
          logger.info("gaming.retrieval.source.end", {
            ...logContext,
            ...sourceLogTarget,
            sourceIndex: index + 1,
            sourceCount: uniqueUrls.length,
            ok: true,
            elapsedMs: Date.now() - sourceStartedAt,
            fetchParseMs: Date.now() - sourceStartedAt,
            snippetChars: snippet.length,
            maxContextChars,
            fetchTimeoutMs
          });
        }
        return { url: sourceUrl, snippet };
      } catch (error) {
        const errorCode = readErrorString(error, "code") ?? "INTAKE_RETRIEVAL_FAILED";
        const timeoutPhase = readErrorString(error, "timeoutPhase");
        if (logContext) {
          logger.warn("gaming.retrieval.source.end", {
            ...logContext,
            ...sourceLogTarget,
            sourceIndex: index + 1,
            sourceCount: uniqueUrls.length,
            ok: false,
            elapsedMs: Date.now() - sourceStartedAt,
            fetchParseMs: Date.now() - sourceStartedAt,
            errorCode,
            ...(timeoutPhase ? { timeoutPhase } : {}),
            fallbackReason: errorCode,
            fetchTimeoutMs
          });
        }
        return { url: sourceUrl, error: resolveErrorMessage(error, "Unknown fetch error") };
      }
    })
  );

  const contextStartedAt = Date.now();
  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join("\n\n");

  if (logContext) {
    logger.info("gaming.retrieval.end", {
      ...logContext,
      sourceCount: sources.length,
      usableSourceCount: sources.filter((source) => Boolean(source.snippet)).length,
      failedSourceCount: sources.filter((source) => Boolean(source.error)).length,
      contextChars: context.length,
      parseMs: Date.now() - contextStartedAt,
      retrievalLatencyMs: Date.now() - retrievalStartedAt,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  return { context, sources };
}

function normalizeDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(domain: string, candidate: string): boolean {
  return domain === candidate || domain.endsWith(`.${candidate}`);
}

function trustScoreForUrl(url: string, fallback: number): number {
  const domain = normalizeDomain(url);
  const matched = TRUSTED_DOMAIN_SCORES.find((entry) => domainMatches(domain, entry.domain));
  return matched?.score ?? fallback;
}

function isLowQualityDomain(url: string): boolean {
  const domain = normalizeDomain(url);
  return LOW_QUALITY_DOMAINS.some((candidate) => domainMatches(domain, candidate));
}

function normalizeCacheUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function normalizeGameName(input: GamingRagInput): string | undefined {
  const explicit = input.game?.trim();
  if (explicit) {
    const known = KNOWN_GAME_ALIASES.find((entry) => entry.pattern.test(explicit));
    return known?.name ?? explicit;
  }

  const prompt = input.prompt.trim();
  const known = KNOWN_GAME_ALIASES.find((entry) => entry.pattern.test(prompt));
  return known?.name;
}

function isPatchSensitive(input: GamingRagInput): boolean {
  return input.mode === "meta" || /\b(?:patch|hotfix|version|season|latest|current|right\s+now|meta|buff|nerf|balance|viable)\b/i.test(input.prompt);
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9+]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3)
  ));
}

function extractTopicTerms(input: GamingRagInput, game?: string): string[] {
  const text = `${input.prompt} ${game ?? ""}`;
  const terms = tokenize(text)
    .filter((term) => !["game", "guide", "build", "meta", "this", "that", "still", "make", "what", "where", "first", "after"].includes(term))
    .slice(0, 10);
  const phrases = [
    /\bfrost\s+mage\b/i.test(text) ? "frost mage" : "",
    /\bbleed\b/i.test(text) ? "bleed" : "",
    /\bpatch\s+[a-z0-9._-]+\b/i.exec(text)?.[0] ?? "",
    /\bnew\s+game\s*\+|\bng\+\b/i.test(text) ? "new game plus" : ""
  ].filter(Boolean);

  return Array.from(new Set([...phrases, ...terms]));
}

function buildRetrievalQuery(input: GamingRagInput, game: string | undefined, terms: string[]): string {
  return [
    game,
    input.mode,
    isPatchSensitive(input) ? "latest patch notes current meta" : "",
    ...terms
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function makeSourceCandidate(
  source: Omit<GamingSourceCandidate, "trustScore" | "supplied">,
  supplied: boolean,
  fallbackTrustScore: number
): GamingSourceCandidate {
  return {
    ...source,
    url: redactUrlCredentials(source.url.trim()),
    trustScore: trustScoreForUrl(source.url, fallbackTrustScore),
    supplied
  };
}

function safeSourceTitleFromUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.replace(/^www\./, "");
  } catch {
    return "supplied guide source";
  }
}

function collectConfiguredSources(): GamingSourceCandidate[] {
  const rawValue = getEnv("ARCANOS_GAMING_CURATED_SOURCES_JSON");
  if (!rawValue) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return parsedValue.flatMap((entry): GamingSourceCandidate[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const record = entry as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!isFetchableGuideUrl(url)) {
        return [];
      }

      const rawModes = Array.isArray(record.modes) ? record.modes : [];
      const modes = rawModes.filter((mode): mode is GamingMode => mode === "guide" || mode === "build" || mode === "meta");
      const topics = Array.isArray(record.topics)
        ? record.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
        : [];
      const sourceType = record.sourceType === "official" || record.sourceType === "patch_notes" || record.sourceType === "wiki" || record.sourceType === "supplied"
        ? record.sourceType
        : "curated";

      return [makeSourceCandidate({
        url,
        title: typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : safeSourceTitleFromUrl(url),
        sourceType,
        topics,
        modes: modes.length > 0 ? modes : ["guide", "build", "meta"],
        stable: record.stable === true
      }, false, 0.72)];
    });
  } catch {
    return [];
  }
}

function buildSourceCandidates(input: GamingRagInput, game: string | undefined): GamingSourceCandidate[] {
  const suppliedUrls = collectGamingGuideUrls(input)
    .filter((url): url is string => typeof url === "string")
    .map((url) => url.trim())
    .filter(isFetchableGuideUrl)
    .slice(0, getGamingWebContextMaxUrls());
  const suppliedCandidates = suppliedUrls.map((url) => makeSourceCandidate({
    url,
    title: safeSourceTitleFromUrl(url),
    sourceType: "supplied",
    topics: ["supplied", input.mode],
    modes: ["guide", "build", "meta"],
    stable: true
  }, true, 0.68));

  const builtinCandidates = BUILTIN_SOURCE_CATALOG
    .filter((entry) => game && entry.game.toLowerCase() === game.toLowerCase())
    .flatMap((entry) => entry.sources.map((source) => makeSourceCandidate(source, false, 0.68)));

  const allCandidates = [...suppliedCandidates, ...builtinCandidates, ...collectConfiguredSources()]
    .filter((candidate) => candidate.supplied || !isLowQualityDomain(candidate.url))
    .filter((candidate) => candidate.supplied || candidate.trustScore >= 0.55)
    .filter((candidate) => candidate.modes.includes(input.mode) || candidate.supplied);

  const deduped = new Map<string, GamingSourceCandidate>();
  for (const candidate of allCandidates) {
    const key = normalizeCacheUrl(candidate.url).toLowerCase();
    const existing = deduped.get(key);
    if (!existing || scoreCandidate(input, candidate, [], false) > scoreCandidate(input, existing, [], false)) {
      deduped.set(key, candidate);
    }
  }

  return Array.from(deduped.values());
}

function scoreCandidate(
  input: GamingRagInput,
  candidate: GamingSourceCandidate,
  terms: string[],
  patchSensitive: boolean
): number {
  const haystack = `${candidate.title} ${candidate.url} ${candidate.topics.join(" ")}`.toLowerCase();
  const termScore = terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 0.08 : 0), 0);
  const suppliedBoost = candidate.supplied ? 0.5 : 0;
  const modeBoost = candidate.modes.includes(input.mode) ? 0.16 : 0;
  const patchBoost = patchSensitive && candidate.sourceType === "patch_notes" ? 0.36 : 0;
  const guideBoost = input.mode === "guide" && candidate.stable ? 0.18 : 0;
  const buildBoost = input.mode === "build" && /\b(?:build|gear|talent|weapon|stats?|rotation|bleed|frost)\b/i.test(haystack) ? 0.2 : 0;
  const wikiGuidePenalty = patchSensitive && candidate.sourceType === "wiki" ? -0.08 : 0;
  return candidate.trustScore + suppliedBoost + modeBoost + patchBoost + guideBoost + buildBoost + termScore + wikiGuidePenalty;
}

function selectCandidates(input: GamingRagInput, candidates: GamingSourceCandidate[], terms: string[], patchSensitive: boolean): GamingSourceCandidate[] {
  const maxSources = getGamingRagMaxSources();
  if (maxSources <= 0) {
    return [];
  }

  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(input, candidate, terms, patchSensitive) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSources)
    .map((entry) => entry.candidate);
}

async function fetchGamingRagDocument(
  candidate: GamingSourceCandidate,
  input: GamingRagInput,
  patchSensitive: boolean,
  maxDocumentChars: number,
  fetchTimeoutMs: number,
  logContext: GamingWebContextLogContext | undefined,
  sourceIndex: number,
  sourceCount: number
): Promise<GamingFetchedDocument | GamingWebSource> {
  const sourceUrl = redactUrlCredentials(candidate.url);
  const cacheKey = normalizeCacheUrl(sourceUrl);
  const cached = documentCache.get(cacheKey);
  const now = Date.now();
  const sourceStartedAt = now;
  const sourceLogTarget = buildSafeSourceLogTarget(sourceUrl);
  if (cached && cached.expiresAt > now) {
    if (logContext) {
      logger.info("gaming.retrieval.source.end", {
        ...logContext,
        ...sourceLogTarget,
        sourceIndex,
        sourceCount,
        ok: true,
        cacheHit: true,
        elapsedMs: 0,
        fetchParseMs: 0,
        snippetChars: Math.min(cached.text.length, maxDocumentChars),
        fetchTimeoutMs
      });
    }
    return {
      candidate,
      text: cached.text,
      fetchedAt: cached.fetchedAt,
      cacheHit: true
    };
  }

  if (logContext) {
    logger.info("gaming.retrieval.source.start", {
      ...logContext,
      ...sourceLogTarget,
      sourceIndex,
      sourceCount,
      cacheHit: false,
      fetchTimeoutMs,
      maxDocumentChars
    });
  }

  try {
    const text = await runWithLocalTimeout(
      (signal) => fetchAndClean(sourceUrl, maxDocumentChars, { signal, timeoutMs: fetchTimeoutMs }),
      fetchTimeoutMs
    );
    const fetchedAt = new Date().toISOString();
    documentCache.set(cacheKey, {
      text,
      fetchedAt,
      expiresAt: now + getGamingRagTtlMs(input.mode, patchSensitive)
    });
    if (logContext) {
      logger.info("gaming.retrieval.source.end", {
        ...logContext,
        ...sourceLogTarget,
        sourceIndex,
        sourceCount,
        ok: true,
        cacheHit: false,
        elapsedMs: Date.now() - sourceStartedAt,
        fetchParseMs: Date.now() - sourceStartedAt,
        snippetChars: text.length,
        fetchTimeoutMs
      });
    }
    return {
      candidate,
      text,
      fetchedAt,
      cacheHit: false
    };
  } catch (error) {
    const errorCode = readErrorString(error, "code") ?? "INTAKE_RETRIEVAL_FAILED";
    const timeoutPhase = readErrorString(error, "timeoutPhase");
    if (logContext) {
      logger.warn("gaming.retrieval.source.end", {
        ...logContext,
        ...sourceLogTarget,
        sourceIndex,
        sourceCount,
        ok: false,
        cacheHit: false,
        elapsedMs: Date.now() - sourceStartedAt,
        fetchParseMs: Date.now() - sourceStartedAt,
        errorCode,
        ...(timeoutPhase ? { timeoutPhase } : {}),
        fallbackReason: errorCode,
        fetchTimeoutMs
      });
    }
    return { url: sourceUrl, error: resolveErrorMessage(error, "Unknown fetch error") };
  }
}

function splitIntoChunks(text: string, maxChunkChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= maxChunkChars) {
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = sentence.length > maxChunkChars ? sentence.slice(0, maxChunkChars) : sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function hashChunk(text: string): string {
  return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").slice(0, 600)).digest("hex");
}

function rankChunks(documents: GamingFetchedDocument[], terms: string[], input: GamingRagInput, patchSensitive: boolean): GamingRankedChunk[] {
  const maxChunks = getGamingRagMaxChunks();
  if (maxChunks <= 0) {
    return [];
  }

  const maxChunkChars = getGamingRagChunkChars();
  const scoredChunks: GamingRankedChunk[] = [];
  for (const document of documents) {
    for (const chunk of splitIntoChunks(document.text, maxChunkChars)) {
      const haystack = chunk.toLowerCase();
      const termScore = terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 0.14 : 0), 0);
      const patchScore = patchSensitive && /\b(?:patch|hotfix|version|buff|nerf|balance|adjusted|changed)\b/i.test(chunk) ? 0.28 : 0;
      const buildScore = input.mode === "build" && /\b(?:build|stat|weapon|talent|gear|rotation|bleed|frost|mage)\b/i.test(chunk) ? 0.22 : 0;
      const guideScore = input.mode === "guide" && /\b(?:route|walkthrough|first|after|location|boss|quest|progress)\b/i.test(chunk) ? 0.18 : 0;
      scoredChunks.push({
        candidate: document.candidate,
        text: chunk,
        score: scoreCandidate(input, document.candidate, terms, patchSensitive) + termScore + patchScore + buildScore + guideScore,
        hash: hashChunk(chunk)
      });
    }
  }

  const deduped = new Map<string, GamingRankedChunk>();
  for (const chunk of scoredChunks) {
    const dedupeKey = chunk.candidate.supplied ? `${chunk.hash}:${chunk.candidate.url}` : chunk.hash;
    const existing = deduped.get(dedupeKey);
    if (!existing || chunk.score > existing.score) {
      deduped.set(dedupeKey, chunk);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, maxChunks);
}

function buildRagContext(chunks: GamingRankedChunk[], retrievalQuery: string, maxContextChars: number): string {
  if (chunks.length === 0) {
    return "";
  }

  const parts: string[] = [
    "[RETRIEVAL QUERY]",
    retrievalQuery || "prompt-only"
  ];

  chunks.forEach((chunk, index) => {
    const sourceNumber = index + 1;
    const domain = normalizeDomain(chunk.candidate.url);
    parts.push(
      "",
      `[Source ${sourceNumber}] ${chunk.candidate.url}`,
      `Title: ${chunk.candidate.title}; Domain: ${domain}; Type: ${chunk.candidate.sourceType}; Trust: ${chunk.candidate.trustScore.toFixed(2)}`,
      chunk.text
    );
  });

  return parts.join("\n").slice(0, Math.max(0, maxContextChars));
}

function sourceFromChunk(chunk: GamingRankedChunk): GamingWebSource {
  return {
    url: chunk.candidate.url,
    snippet: chunk.text
  };
}

function buildClearChecks(params: {
  retrievalEnabled: boolean;
  sourceCount: number;
  context: string;
  fallbackReason?: string;
}): GamingRagContext["clear"] {
  const contextGrounded = !params.retrievalEnabled || params.sourceCount > 0 || params.context.length === 0 || Boolean(params.fallbackReason);
  const limitedEvidence = params.context.length <= getGamingWebContextMaxChars();
  const explicitUncertainty = params.sourceCount > 0 || params.context.length === 0 || params.context.includes("inference") || params.context.includes("patch-sensitive");
  const attributableSources = params.sourceCount === 0 || /\[Source \d+\]/.test(params.context);
  const robustFallback = params.sourceCount > 0 || Boolean(params.fallbackReason) || params.context.length === 0;
  const passed = contextGrounded && limitedEvidence && explicitUncertainty && attributableSources && robustFallback;
  return {
    contextGrounded,
    limitedEvidence,
    explicitUncertainty,
    attributableSources,
    robustFallback,
    passed
  };
}

function sourceDomainsFromChunks(chunks: GamingRankedChunk[]): string[] {
  return Array.from(new Set(chunks.map((chunk) => normalizeDomain(chunk.candidate.url)).filter(Boolean)));
}

function retrievalReasonFor(input: GamingRagInput, game: string | undefined, suppliedSourceCount: number, patchSensitive: boolean): string {
  if (suppliedSourceCount > 0) {
    return "supplied_sources";
  }
  if (patchSensitive) {
    return "patch_or_meta_sensitive";
  }
  if (game) {
    return "curated_game_sources";
  }
  return "no_supported_source_candidates";
}

function emptyRagContext(params: {
  enabled: boolean;
  reason: string;
  query: string;
  startedAt: number;
  rankingStartedAt?: number;
  fallbackReason?: string;
}): GamingRagContext {
  const clear = buildClearChecks({
    retrievalEnabled: params.enabled,
    sourceCount: 0,
    context: "",
    fallbackReason: params.fallbackReason
  });
  return {
    context: "",
    sources: [],
    retrievalEnabled: params.enabled,
    retrievalReason: params.reason,
    retrievalQuery: params.query,
    sourceDomains: [],
    cacheHit: false,
    retrievalElapsedMs: Date.now() - params.startedAt,
    rankingElapsedMs: params.rankingStartedAt ? Date.now() - params.rankingStartedAt : 0,
    ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {}),
    clear
  };
}

export function clearGamingRagCache(): void {
  documentCache.clear();
}

export async function buildGamingRagContext(
  input: GamingRagInput,
  logContext?: GamingWebContextLogContext
): Promise<GamingRagContext> {
  const retrievalStartedAt = Date.now();
  const suppliedSourceCount = collectGamingGuideUrls(input)
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    .length;
  const game = normalizeGameName(input);
  const terms = extractTopicTerms(input, game);
  const patchSensitive = isPatchSensitive(input);
  const retrievalQuery = buildRetrievalQuery(input, game, terms);
  const retrievalEnabled = getGamingRagEnabled();
  const retrievalReason = retrievalEnabled
    ? retrievalReasonFor(input, game, suppliedSourceCount, patchSensitive)
    : "disabled";

  if (!retrievalEnabled) {
    return emptyRagContext({
      enabled: false,
      reason: retrievalReason,
      query: retrievalQuery,
      startedAt: retrievalStartedAt
    });
  }

  const maxContextChars = getGamingWebContextMaxChars();
  const maxSources = getGamingRagMaxSources();
  const maxChunks = getGamingRagMaxChunks();
  const fetchTimeoutMs = getGamingWebContextFetchTimeoutMs();
  const candidates = selectCandidates(
    input,
    buildSourceCandidates(input, game),
    terms,
    patchSensitive
  );

  if (logContext) {
    logger.info("gaming.retrieval.start", {
      ...logContext,
      ...(game ? { game } : {}),
      retrievalEnabled,
      retrievalReason,
      retrievalQuery,
      requestedSourceCount: suppliedSourceCount,
      sourceCount: candidates.length,
      sourceDomains: Array.from(new Set(candidates.map((candidate) => normalizeDomain(candidate.url)).filter(Boolean))),
      cacheHit: false,
      maxSources,
      maxChunks,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  if (candidates.length === 0) {
    return emptyRagContext({
      enabled: true,
      reason: retrievalReason,
      query: retrievalQuery,
      startedAt: retrievalStartedAt
    });
  }

  const fetchedResults = await Promise.all(
    candidates.map((candidate, index) =>
      fetchGamingRagDocument(
        candidate,
        input,
        patchSensitive,
        maxContextChars,
        fetchTimeoutMs,
        logContext,
        index + 1,
        candidates.length
      )
    )
  );

  const documents = fetchedResults.filter((result): result is GamingFetchedDocument => "text" in result);
  const errorSources = fetchedResults.filter((result): result is GamingWebSource => !("text" in result));
  const timedOut = errorSources.some((source) => source.error?.toLowerCase().includes("timed out"));
  const rankingStartedAt = Date.now();
  const chunks = rankChunks(documents, terms, input, patchSensitive);
  const context = buildRagContext(chunks, retrievalQuery, maxContextChars);
  const rankingElapsedMs = Date.now() - rankingStartedAt;
  const sources = Array.from(new Map(chunks.map((chunk) => [chunk.candidate.url, sourceFromChunk(chunk)])).values());
  const sourceDomains = sourceDomainsFromChunks(chunks);
  const cacheHit = documents.some((document) => document.cacheHit);
  const fallbackReason = documents.length === 0 && timedOut ? "INTAKE_RETRIEVAL_TIMEOUT" : undefined;
  const clear = buildClearChecks({
    retrievalEnabled,
    sourceCount: sources.length,
    context,
    fallbackReason
  });

  if (logContext) {
    logger.info("gaming.retrieval.end", {
      ...logContext,
      ...(game ? { game } : {}),
      retrievalEnabled,
      retrievalReason,
      retrievalQuery,
      sourceCount: sources.length,
      sourceDomains,
      cacheHit,
      retrievalElapsedMs: Date.now() - retrievalStartedAt,
      rankingElapsedMs,
      usableSourceCount: sources.length,
      failedSourceCount: errorSources.length,
      contextChars: context.length,
      chunkCount: chunks.length,
      maxSources,
      maxChunks,
      maxContextChars,
      fetchTimeoutMs,
      clearPassed: clear.passed,
      ...(fallbackReason ? { fallbackReason, timeoutPhase: "retrieval" } : {})
    });
  }

  return {
    context,
    sources: sources.length > 0 ? sources : errorSources,
    retrievalEnabled,
    retrievalReason,
    retrievalQuery,
    sourceDomains,
    cacheHit,
    retrievalElapsedMs: Date.now() - retrievalStartedAt,
    rankingElapsedMs,
    ...(fallbackReason ? { fallbackReason } : {}),
    clear
  };
}
