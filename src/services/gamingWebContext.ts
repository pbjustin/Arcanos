import { createHash } from "node:crypto";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  fetchAndClean,
  type FetchAndCleanExtractionMetrics,
  type FetchAndCleanOptions
} from "@shared/webFetcher.js";
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
import {
  canonicalizeGamingGameName,
  detectGamingGame,
  type GamingGameDetection,
  type GamingGameDetectionSource
} from "@services/gamingGameDetection.js";
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
  retrievedSourceCount: number;
  publicSourceCount: number;
  omittedSourceCount: number;
  sourceDomains: string[];
  cacheHit: boolean;
  retrievalElapsedMs: number;
  rankingElapsedMs: number;
  detectedGame?: string;
  gameDetectionConfidence: number;
  gameDetectionSource: GamingGameDetectionSource;
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
  fetchUrl: string;
  title: string;
  sourceType: GamingSourceType;
  trustScore: number;
  topics: string[];
  modes: GamingMode[];
  games?: string[];
  stable: boolean;
  supplied: boolean;
};

type GamingFetchedDocument = {
  candidate: GamingSourceCandidate;
  text: string;
  fetchedAt: string;
  cacheHit: boolean;
  extraction: FetchAndCleanExtractionMetrics;
};

type GamingRankedChunk = {
  candidate: GamingSourceCandidate;
  text: string;
  score: number;
  hash: string;
  snippetQualityScore: number;
  navigationPenalty: number;
};

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

const MAX_DOCUMENT_CACHE_ENTRIES = 100;
const MAX_PUBLIC_SNIPPET_CHARS = 600;
const LIMITED_ARTICLE_TEXT_SNIPPET = "Relevant source retrieved, but readable article text was limited.";
const LIMITED_ARTICLE_CONTEXT_NOTE = "[No readable article evidence was extracted from this source.]";

export function isCitableGamingWebSource(source: GamingWebSource): boolean {
  return Boolean(source.snippet && source.snippet !== LIMITED_ARTICLE_TEXT_SNIPPET);
}

const GENERIC_CONTENT_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  ".mw-parser-output",
  ".entry-content",
  ".article-content",
  ".article-body",
  "[class*='article-content']",
  "[class*='article-body']",
  ".main-content",
  "#main-content",
  ".page-content",
  ".post-content",
  "#content",
  ".content"
] as const;

const COMMON_JUNK_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "template",
  "[hidden]",
  "[aria-hidden='true']",
  "[aria-modal='true']",
  "[role='dialog']",
  "[role='navigation']",
  "[role='banner']",
  "[role='complementary']",
  ".sidebar",
  "#sidebar",
  "[class$='-sidebar']",
  "[class$='__sidebar']",
  "[id$='-sidebar']",
  "[id$='__sidebar']",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='newsletter']",
  "[class*='sign-in']",
  "[class*='signin']",
  "[class*='login']",
  "[id*='sign-in']",
  "[id*='signin']",
  "[id*='login']",
  "[class*='modal']",
  "[class*='popup']",
  "[class*='popin']",
  ".comments",
  "#comments",
  "[class*='comment-list']",
  "[class*='breadcrumb']",
  "[class*='social-share']",
  "[class*='share-social']",
  "[class*='related-links']",
  "[class*='related-content']",
  "[class*='recommended-links']",
  "[class*='advertisement']",
  "[class*='ad-container']"
] as const;

const SOURCE_EXTRACTION_PROFILES: Array<{
  domains: string[];
  contentSelectors: readonly string[];
  removeSelectors: readonly string[];
}> = [
  {
    domains: ["wiki.fextralife.com", "fextralife.com"],
    contentSelectors: ["#wiki-content-block", ".wiki-content-block", "#main-content", ".page-content"],
    removeSelectors: [
      ".wiki-header-container",
      ".wiki-menu-2-left",
      ".wikiMenuMobile",
      ".left-side-menu-container",
      ".side-bar-right",
      "#featured-wikis",
      "#related-games-content",
      "#disqus_thread"
    ]
  },
  {
    domains: ["bandainamcoent.com", "bandainamcoent.eu"],
    contentSelectors: [".article__edito-content", ".article__content", ".article", "article"],
    removeSelectors: [
      ".article__sidebar",
      ".article__share-social",
      "[class*='read-next']",
      ".age-gate"
    ]
  },
  {
    domains: ["worldofwarcraft.blizzard.com", "news.blizzard.com", "blizzard.com"],
    contentSelectors: [".NewsBlog-content", ".Article-content", ".article-content", "#main", "article"],
    removeSelectors: [".SiteNav", ".SocialLinks", ".CommentTotal"]
  },
  {
    domains: ["icy-veins.com"],
    contentSelectors: [".left-column-content", ".left-column-main", ".guide-page-content", "article"],
    removeSelectors: [
      ".guide-header__breadcrumbs",
      ".content-toc",
      ".table-of-contents",
      ".left-column-sidebar"
    ]
  }
];

const BUILTIN_SOURCE_CATALOG: Array<{
  game: string;
  sources: Array<Omit<GamingSourceCandidate, "trustScore" | "supplied" | "fetchUrl">>;
}> = [
  {
    game: "Elden Ring",
    sources: [
      {
        title: "Elden Ring official news and patch notes",
        url: "https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-1161",
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
      },
      {
        title: "Elden Ring wiki hemorrhage guide",
        url: "https://eldenring.wiki.fextralife.com/Hemorrhage",
        sourceType: "wiki",
        topics: ["bleed", "blood loss", "hemorrhage", "arcane", "build"],
        modes: ["build"],
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

const documentCache = new Map<string, {
  text: string;
  fetchedAt: string;
  expiresAt: number;
  extraction: FetchAndCleanExtractionMetrics;
}>();

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

function buildSafeSourceLogTarget(url: string): { sourceUrl: string; sourceHost: string; sourcePathLength: number } {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.username = "";
    parsedUrl.password = "";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return {
      sourceUrl: parsedUrl.origin,
      sourceHost: parsedUrl.host,
      sourcePathLength: parsedUrl.pathname.length
    };
  } catch {
    return {
      sourceUrl: "invalid-url",
      sourceHost: "invalid-url",
      sourcePathLength: 0
    };
  }
}

function sanitizePublicSourceUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.username = "";
    parsedUrl.password = "";
    const identityKeys = new Set(["article", "game", "id", "oldid", "p", "page", "slug", "title", "topic"]);
    const sensitiveKeyPattern = /(?:^|[_-])(?:access|api|auth|bearer|credential|key|password|secret|sig|signature|token)(?:$|[_-])|^x-amz-/i;
    const sensitiveValuePattern = /^(?:sk-|gh[opusr]_|eyj[a-z0-9_-]*\.|bearer\s+)/i;
    const hasSensitiveQuery = Array.from(parsedUrl.searchParams.entries()).some(([key, value]) =>
      sensitiveKeyPattern.test(key) || sensitiveValuePattern.test(value)
    );
    if (hasSensitiveQuery) {
      parsedUrl.search = "";
    } else {
      const publicParams = new URLSearchParams();
      for (const [key, value] of parsedUrl.searchParams.entries()) {
        if (identityKeys.has(key.toLowerCase())) {
          publicParams.append(key, value.slice(0, 160));
        }
      }
      parsedUrl.search = publicParams.toString();
    }
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return "invalid-source";
  }
}

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const directStatus = (error as Record<string, unknown>).status;
  const response = (error as Record<string, unknown>).response;
  const responseStatus = response && typeof response === "object"
    ? (response as Record<string, unknown>).status
    : undefined;
  const status = typeof directStatus === "number" ? directStatus : responseStatus;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function safeGamingSourceError(error: unknown): string {
  const message = resolveErrorMessage(error, "Source retrieval failed.").toLowerCase();
  const status = readHttpStatus(error);
  if (status === 401 || status === 403 || /\b(?:401|403)\b|unauthorized|forbidden/.test(message)) {
    return "Source access was blocked.";
  }
  if (/timed?\s*out|timeout|aborted/.test(message)) {
    return "Source retrieval timed out.";
  }
  if (/unsupported (?:content type|binary-like content)/.test(message)) {
    return "Source content type is unsupported.";
  }
  if (/maxcontentlength|maxbodylength|response size|larger than|max.*bytes/.test(message)) {
    return "Source response exceeded the size limit.";
  }
  if (/private\/internal|credentials|only http\/https|invalid url|failed to resolve|enotfound/.test(message)) {
    return "Source URL was blocked or could not be resolved.";
  }
  return "Source could not be retrieved.";
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
      const fetchUrl = redactUrlCredentials(url);
      const sourceUrl = sanitizePublicSourceUrl(fetchUrl);
      const sourceStartedAt = Date.now();
      const sourceLogTarget = buildSafeSourceLogTarget(fetchUrl);
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
        let extraction: FetchAndCleanExtractionMetrics = {
          strategy: "body",
          rawTextLength: 0,
          cleanedTextLength: 0
        };
        const fetchedText = await runWithLocalTimeout(
          (signal) => fetchAndClean(
            fetchUrl,
            maxContextChars,
            buildGamingFetchOptions(fetchUrl, signal, fetchTimeoutMs, [], (metrics) => {
              extraction = metrics;
            })
          ),
          fetchTimeoutMs
        );
        if (extraction.rawTextLength === 0 && fetchedText.length > 0) {
          extraction = {
            strategy: "body",
            rawTextLength: fetchedText.length,
            cleanedTextLength: fetchedText.length
          };
        }
        const snippet = shapePublicSnippet(fetchedText);
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
            extractionStrategy: extraction.strategy,
            selectedContainer: extraction.selectedContainer ?? extraction.strategy,
            extractionQualityScore: extraction.qualityScore ?? null,
            navigationPenalty: extraction.navigationPenalty ?? null,
            linkDensity: extraction.linkDensity ?? null,
            extractionCandidateCount: extraction.candidateCount ?? null,
            rawTextLength: extraction.rawTextLength,
            cleanedTextLength: extraction.cleanedTextLength,
            fallbackSnippetUsed: snippet === LIMITED_ARTICLE_TEXT_SNIPPET,
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
        return { url: sourceUrl, error: safeGamingSourceError(error) };
      }
    })
  );

  const contextStartedAt = Date.now();
  const orderedSources = [
    ...sources.filter((source) => Boolean(source.snippet)),
    ...sources.filter((source) => !source.snippet)
  ];
  const context = orderedSources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join("\n\n");

  if (logContext) {
    logger.info("gaming.retrieval.end", {
      ...logContext,
      sourceCount: sources.length,
      usableSourceCount: sources.filter(isCitableGamingWebSource).length,
      failedSourceCount: sources.filter((source) => Boolean(source.error)).length,
      contextChars: context.length,
      parseMs: Date.now() - contextStartedAt,
      retrievalLatencyMs: Date.now() - retrievalStartedAt,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  return { context, sources: orderedSources };
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

function buildGamingFetchOptions(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  preferredContentTerms: readonly string[],
  onExtraction: (metrics: FetchAndCleanExtractionMetrics) => void
): FetchAndCleanOptions {
  const domain = normalizeDomain(url);
  const profile = SOURCE_EXTRACTION_PROFILES.find((entry) =>
    entry.domains.some((candidate) => domainMatches(domain, candidate))
  );

  return {
    signal,
    timeoutMs,
    includeLinks: false,
    preferredContentSelectors: [
      ...(profile?.contentSelectors ?? []),
      ...GENERIC_CONTENT_SELECTORS
    ],
    preferredContentTerms,
    removeSelectors: [
      ...COMMON_JUNK_SELECTORS,
      ...(profile?.removeSelectors ?? [])
    ],
    onExtraction
  };
}

function trustScoreForSource(
  source: Pick<GamingSourceCandidate, "url" | "sourceType" | "stable">,
  fallback: number
): number {
  const url = source.url;
  const domain = normalizeDomain(url);
  const matched = TRUSTED_DOMAIN_SCORES.find((entry) => domainMatches(domain, entry.domain));
  if (matched) {
    return matched.score;
  }

  let score = fallback;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === "https:") {
      score += 0.03;
    }
    if (/\b(?:news|patch|patch-notes|updates?|hotfix)\b/i.test(parsedUrl.pathname)) {
      score += 0.04;
    }
  } catch {
    score -= 0.2;
  }
  if (source.sourceType === "official" || source.sourceType === "patch_notes") {
    score += 0.1;
  } else if (source.sourceType === "wiki") {
    score += 0.06;
  }
  if (source.stable) {
    score += 0.03;
  }
  return Math.max(0.35, Math.min(0.94, score));
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

function detectGameFromRagInput(input: GamingRagInput): GamingGameDetection {
  const detection = detectGamingGame({
    explicitGame: input.game,
    prompt: input.prompt,
    urls: collectGamingGuideUrls(input).filter((url): url is string => typeof url === "string")
  });
  return detection.game && detection.confidence >= 0.7
    ? { ...detection, game: canonicalizeGamingGameName(detection.game) }
    : { confidence: detection.confidence, source: detection.source };
}

function normalizeGameName(input: GamingRagInput): string | undefined {
  return detectGameFromRagInput(input).game;
}

function metadataAndBodyStronglySupportGame(
  metadata: string | undefined,
  detection: GamingGameDetection,
  bodyText: string
): boolean {
  if (!metadata || !detection.game || detection.confidence < 0.8) {
    return false;
  }
  if (!/\b(?:guide|build|loadout|meta|walkthrough|wiki|tips?|tier\s+list|patch\s+notes)\b/i.test(metadata)) {
    return false;
  }
  const bodyTokens = new Set(bodyText.toLowerCase().match(/[a-z0-9+]+/g) ?? []);
  const gameTokens = (detection.game.toLowerCase().match(/[a-z0-9+]+/g) ?? [])
    .filter((token) => token.length >= 2 && !["of", "the"].includes(token));
  return gameTokens.length > 0 && gameTokens.every((token) => bodyTokens.has(token));
}

function detectReliableDocumentGame(document: GamingFetchedDocument): string | undefined {
  const titleDetection = detectGamingGame({ pageTitle: document.extraction.documentTitle });
  const headingDetection = detectGamingGame({ pageHeadings: document.extraction.headingText });
  const urlDetection = detectGamingGame({ urls: [document.candidate.url] });
  const normalizedTitle = titleDetection.game ? canonicalizeGamingGameName(titleDetection.game) : undefined;
  const normalizedHeading = headingDetection.game ? canonicalizeGamingGameName(headingDetection.game) : undefined;
  const normalizedUrl = urlDetection.game ? canonicalizeGamingGameName(urlDetection.game) : undefined;

  if (normalizedTitle && normalizedHeading && normalizedTitle.toLowerCase() === normalizedHeading.toLowerCase()) {
    return normalizedTitle;
  }
  if (normalizedTitle && normalizedUrl && normalizedTitle.toLowerCase() === normalizedUrl.toLowerCase()) {
    return normalizedTitle;
  }
  if (normalizedHeading && normalizedUrl && normalizedHeading.toLowerCase() === normalizedUrl.toLowerCase()) {
    return normalizedHeading;
  }
  if (normalizedTitle && metadataAndBodyStronglySupportGame(
    document.extraction.documentTitle,
    titleDetection,
    document.text
  )) {
    return normalizedTitle;
  }
  if (normalizedHeading && metadataAndBodyStronglySupportGame(
    document.extraction.headingText,
    headingDetection,
    document.text
  )) {
    return normalizedHeading;
  }
  return undefined;
}

function detectGameFromFetchedDocuments(
  initialDetection: GamingGameDetection,
  documents: GamingFetchedDocument[]
): GamingGameDetection {
  if (initialDetection.game && initialDetection.confidence >= 0.7) {
    return initialDetection;
  }

  const detections: Array<GamingGameDetection & { support: number }> = [];
  for (const document of documents.slice(0, getGamingRagMaxSources())) {
    const detectedGame = detectReliableDocumentGame(document);
    if (detectedGame) {
      detections.push({ game: detectedGame, confidence: 0.88, source: "page_metadata", support: 2 });
    }
  }

  if (detections.length === 0) {
    return initialDetection;
  }

  const grouped = new Map<string, GamingGameDetection & { support: number }>();
  for (const detection of detections) {
    const key = detection.game?.toLowerCase() ?? "";
    const existing = grouped.get(key);
    grouped.set(key, existing
      ? { ...existing, confidence: Math.max(existing.confidence, detection.confidence), support: existing.support + detection.support }
      : detection);
  }
  const ordered = Array.from(grouped.values()).sort((left, right) =>
    right.support - left.support
    || right.confidence - left.confidence
    || (left.game ?? "").localeCompare(right.game ?? "")
  );
  if (ordered.length > 1 && ordered[0].support === ordered[1].support) {
    return initialDetection;
  }
  return ordered[0];
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
  source: Omit<GamingSourceCandidate, "trustScore" | "supplied" | "fetchUrl">,
  supplied: boolean,
  fallbackTrustScore: number
): GamingSourceCandidate {
  const fetchUrl = redactUrlCredentials(source.url.trim());
  return {
    ...source,
    url: sanitizePublicSourceUrl(fetchUrl),
    fetchUrl,
    trustScore: trustScoreForSource(source, fallbackTrustScore),
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
      logger.warn("gaming.config.curated_sources.invalid_format", {
        reason: "curated_sources_json_not_array"
      });
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
      const games = [
        ...(typeof record.game === "string" ? [record.game] : []),
        ...(Array.isArray(record.games) ? record.games : [])
      ]
        .filter((game): game is string => typeof game === "string" && game.trim().length > 0)
        .map((game) => canonicalizeGamingGameName(game));
      const sourceType = record.sourceType === "official" || record.sourceType === "patch_notes" || record.sourceType === "wiki" || record.sourceType === "supplied"
        ? record.sourceType
        : "curated";

      return [makeSourceCandidate({
        url,
        title: typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : safeSourceTitleFromUrl(url),
        sourceType,
        topics,
        ...(games.length > 0 ? { games: Array.from(new Set(games)) } : {}),
        modes: modes.length > 0 ? modes : ["guide", "build", "meta"],
        stable: record.stable === true
      }, false, 0.72)];
    });
  } catch (error) {
    logger.warn("gaming.config.curated_sources.parse_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

function pruneDocumentCache(now: number): void {
  for (const [key, entry] of documentCache.entries()) {
    if (entry.expiresAt <= now) {
      documentCache.delete(key);
    }
  }

  while (documentCache.size >= MAX_DOCUMENT_CACHE_ENTRIES) {
    const oldestKey = documentCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    documentCache.delete(oldestKey);
  }
}

function sourceGameOverlap(candidate: GamingSourceCandidate, game: string | undefined): number {
  if (!game) {
    return 0;
  }
  const canonicalGame = canonicalizeGamingGameName(game).toLowerCase();
  if (candidate.games?.some((candidateGame) => canonicalizeGamingGameName(candidateGame).toLowerCase() === canonicalGame)) {
    return 1;
  }
  const gameTerms = tokenize(canonicalGame);
  if (gameTerms.length === 0) {
    return 0;
  }
  const candidateTokens = new Set(tokenize(`${candidate.title} ${candidate.url} ${candidate.topics.join(" ")}`));
  return gameTerms.filter((term) => candidateTokens.has(term)).length / gameTerms.length;
}

function buildSourceCandidates(input: GamingRagInput, game: string | undefined): GamingSourceCandidate[] {
  const suppliedUrls = Array.from(new Set(
    collectGamingGuideUrls(input)
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .filter(isFetchableGuideUrl)
  )).slice(0, getGamingWebContextMaxUrls());
  const suppliedCandidates = suppliedUrls.map((url) => makeSourceCandidate({
    url,
    title: safeSourceTitleFromUrl(url),
    sourceType: "supplied",
    topics: ["supplied", input.mode],
    ...(game ? { games: [game] } : {}),
    modes: ["guide", "build", "meta"],
    stable: true
  }, true, 0.68));

  const catalogGameDetection = detectGamingGame({ explicitGame: input.game, prompt: input.prompt });
  const catalogGame = catalogGameDetection.confidence >= 0.7 && catalogGameDetection.game
    ? canonicalizeGamingGameName(catalogGameDetection.game)
    : undefined;
  const builtinCandidates = BUILTIN_SOURCE_CATALOG
    .filter((entry) => catalogGame && entry.game.toLowerCase() === catalogGame.toLowerCase())
    .flatMap((entry) => entry.sources.map((source) => makeSourceCandidate({
      ...source,
      games: [entry.game]
    }, false, 0.68)));

  const allCandidates = [...suppliedCandidates, ...builtinCandidates, ...collectConfiguredSources()]
    .filter((candidate) => candidate.supplied || !isLowQualityDomain(candidate.url))
    .filter((candidate) => candidate.supplied || candidate.trustScore >= 0.55)
    .filter((candidate) => candidate.supplied || !candidate.games?.length || sourceGameOverlap(candidate, game) >= 0.8)
    .filter((candidate) => candidate.modes.includes(input.mode) || candidate.supplied);

  const deduped = new Map<string, GamingSourceCandidate>();
  for (const candidate of allCandidates) {
    const key = createHash("sha256").update(normalizeCacheUrl(candidate.fetchUrl).toLowerCase()).digest("hex");
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
  const matchedTermCount = terms.filter((term) => haystack.includes(term.toLowerCase())).length;
  const termScore = Math.min(0.4, matchedTermCount * 0.08);
  const gameScore = sourceGameOverlap(candidate, normalizeGameName(input)) * 0.28;
  const suppliedBoost = candidate.supplied ? 0.5 : 0;
  const modeBoost = candidate.modes.includes(input.mode) ? 0.16 : 0;
  const patchBoost = patchSensitive && candidate.sourceType === "patch_notes" ? 0.36 : 0;
  const guideBoost = input.mode === "guide" && candidate.stable ? 0.18 : 0;
  const buildBoost = input.mode === "build" && /\b(?:build|gear|talent|weapon|stats?|rotation|bleed|frost)\b/i.test(haystack) ? 0.2 : 0;
  const wikiGuidePenalty = patchSensitive && candidate.sourceType === "wiki" ? -0.08 : 0;
  return candidate.trustScore + suppliedBoost + modeBoost + patchBoost + guideBoost + buildBoost + termScore + gameScore + wikiGuidePenalty;
}

function selectCandidates(input: GamingRagInput, candidates: GamingSourceCandidate[], terms: string[], patchSensitive: boolean): GamingSourceCandidate[] {
  const maxSources = getGamingRagMaxSources();
  if (maxSources <= 0) {
    return [];
  }

  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(input, candidate, terms, patchSensitive) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxSources)
    .map((entry) => entry.candidate);
}

async function fetchGamingRagDocument(
  candidate: GamingSourceCandidate,
  input: GamingRagInput,
  patchSensitive: boolean,
  contentTerms: readonly string[],
  maxDocumentChars: number,
  fetchTimeoutMs: number,
  logContext: GamingWebContextLogContext | undefined,
  sourceIndex: number,
  sourceCount: number
): Promise<GamingFetchedDocument | GamingWebSource> {
  const fetchUrl = candidate.fetchUrl;
  const sourceUrl = candidate.url;
  const contentTermKey = createHash("sha256").update(contentTerms.join("\n")).digest("hex").slice(0, 16);
  const cacheUrlKey = createHash("sha256").update(normalizeCacheUrl(fetchUrl)).digest("hex");
  const cacheKey = `${cacheUrlKey}#gaming-rag:${contentTermKey}`;
  const cached = documentCache.get(cacheKey);
  const now = Date.now();
  const sourceStartedAt = now;
  const sourceLogTarget = buildSafeSourceLogTarget(fetchUrl);
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
        extractionStrategy: cached.extraction.strategy,
        selectedContainer: cached.extraction.selectedContainer ?? cached.extraction.strategy,
        extractionQualityScore: cached.extraction.qualityScore ?? null,
        navigationPenalty: cached.extraction.navigationPenalty ?? null,
        linkDensity: cached.extraction.linkDensity ?? null,
        extractionCandidateCount: cached.extraction.candidateCount ?? null,
        rawTextLength: cached.extraction.rawTextLength,
        cleanedTextLength: cached.extraction.cleanedTextLength,
        fetchTimeoutMs
      });
    }
    return {
      candidate,
      text: cached.text,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      extraction: cached.extraction
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
    let extraction: FetchAndCleanExtractionMetrics = {
      strategy: "body",
      rawTextLength: 0,
      cleanedTextLength: 0
    };
    const text = await runWithLocalTimeout(
      (signal) => fetchAndClean(
        fetchUrl,
        maxDocumentChars,
        buildGamingFetchOptions(fetchUrl, signal, fetchTimeoutMs, contentTerms, (metrics) => {
          extraction = metrics;
        })
      ),
      fetchTimeoutMs
    );
    if (extraction.rawTextLength === 0 && text.length > 0) {
      extraction = {
        strategy: "body",
        rawTextLength: text.length,
        cleanedTextLength: text.length
      };
    }
    const fetchedAt = new Date().toISOString();
    pruneDocumentCache(now);
    documentCache.set(cacheKey, {
      text,
      fetchedAt,
      expiresAt: now + getGamingRagTtlMs(input.mode, patchSensitive),
      extraction
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
        extractionStrategy: extraction.strategy,
        selectedContainer: extraction.selectedContainer ?? extraction.strategy,
        extractionQualityScore: extraction.qualityScore ?? null,
        navigationPenalty: extraction.navigationPenalty ?? null,
        linkDensity: extraction.linkDensity ?? null,
        extractionCandidateCount: extraction.candidateCount ?? null,
        rawTextLength: extraction.rawTextLength,
        cleanedTextLength: extraction.cleanedTextLength,
        fetchTimeoutMs
      });
    }
    return {
      candidate,
      text,
      fetchedAt,
      cacheHit: false,
      extraction
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
    return { url: sourceUrl, error: safeGamingSourceError(error) };
  }
}

function splitIntoChunks(text: string, maxChunkChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const chunkSize = Math.max(1, maxChunkChars);
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const nextLength = current ? current.length + sentence.length + 1 : sentence.length;
    if (nextLength <= chunkSize) {
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (sentence.length > chunkSize) {
      for (let index = 0; index < sentence.length; index += chunkSize) {
        chunks.push(sentence.slice(index, index + chunkSize));
      }
      continue;
    }

    current = sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

const NAVIGATION_JUNK_PATTERN = /\b(?:advertisement|cookie settings?|privacy policy|terms of use|sign in|log in|subscribe|newsletter|menu|navigation|footer|share this|edit source|page information|table of contents|all rights reserved|fandom apps|explore properties|category directory|wiki category)\b/i;
const NAVIGATION_LABEL_PATTERN = /\b(?:home|menu|games?|news|guides?|builds?|weapons?|armor|talismans?|skills?|bosses?|locations?|quests?|walkthrough|classes?|community|forums?|wiki|categories|view all|go back|read next|follow us|related games?|popular games)\b/gi;
const NAVIGATION_JUNK_MATCH_PATTERN = /\b(?:advertisement|cookie settings?|privacy policy|terms of use|sign in|log in|subscribe|newsletter|menu|navigation|footer|share this|edit source|page information|table of contents|all rights reserved|category directory|wiki category)\b/gi;
const SOURCE_INSTRUCTION_PATTERN = /\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)|(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|(?:reveal|print|show|expose)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)|(?:call|invoke)\s+(?:the\s+)?(?:tool|function)|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b/i;
const GAMEPLAY_CONTENT_PATTERN = /\b(?:boss|route|walkthrough|build|patch|weapon|stat|skill|class|quest|location|level|damage|talent|gear|rotation|viable|craft|resource|upgrade|exploration|progress|economy|unit|mission|encounter|ability|loadout|mechanic)\b/i;
const MODE_CONTENT_TERMS: Record<GamingMode, readonly string[]> = {
  guide: ["route", "walkthrough", "boss", "location", "beginner", "quest", "tutorial", "progress", "objective", "exploration", "mission", "mechanic"],
  build: ["build", "stats", "weapon", "armor", "skill", "rotation", "talent", "gear", "loadout", "ability", "attribute", "module"],
  meta: ["patch", "update", "nerf", "buff", "viability", "viable", "tier", "changes", "balance", "hotfix", "season", "current"]
};
const SNIPPET_LABEL_TERMS = new Set([
  ...Object.values(MODE_CONTENT_TERMS).flat(),
  "armor", "builds", "classes", "guides", "skills", "stats", "talents", "weapons"
]);
const MIN_SNIPPET_QUALITY_SCORE = 0.3;
const NON_TOPICAL_QUERY_TERMS = new Set([
  "about", "and", "best", "create", "current", "for", "from", "give", "help", "into", "latest", "look", "need", "please", "recommend", "show", "the", "use", "using", "want", "with"
]);

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function countPatternMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function navigationDensity(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized.match(/[a-z0-9+]+/gi) ?? [];
  if (words.length === 0) {
    return 1;
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const shortLabelCount = sentences.filter((sentence) => {
    const sentenceWords = sentence.match(/[a-z0-9+]+/gi) ?? [];
    return sentenceWords.length <= 3 && countPatternMatches(sentence, NAVIGATION_LABEL_PATTERN) > 0;
  }).length;
  const navigationLabels = countPatternMatches(normalized, NAVIGATION_LABEL_PATTERN);
  const explicitJunk = countPatternMatches(normalized, NAVIGATION_JUNK_MATCH_PATTERN);
  const separators = countPatternMatches(normalized, /(?:\||›|»|→)/g);
  return clampScore(
    (navigationLabels * 0.55 + explicitJunk * 2 + separators * 0.5) / Math.max(8, words.length)
    + (sentences.length > 1 ? (shortLabelCount / sentences.length) * 0.5 : 0)
  );
}

function repeatedTextPenalty(text: string): number {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .filter((sentence) => sentence.length >= 20);
  if (sentences.length < 2) {
    return 0;
  }

  return Math.min(0.35, (sentences.length - new Set(sentences).size) / sentences.length);
}

function readabilityScore(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized.match(/[a-z0-9]+/gi) ?? [];
  if (words.length === 0) {
    return 0;
  }

  const alphabeticChars = countPatternMatches(normalized, /[a-z]/gi);
  const alphabeticRatio = alphabeticChars / Math.max(1, normalized.length);
  const sentenceSignal = /[.!?]/.test(normalized) ? 0.18 : 0.08;
  const lengthSignal = Math.min(0.35, normalized.length / 900);
  const wordSignal = words.length >= 8 ? 0.18 : words.length / 50;
  return clampScore(lengthSignal + wordSignal + sentenceSignal + Math.min(0.2, alphabeticRatio * 0.3));
}

function matchedTermRatio(text: string, terms: readonly string[]): number {
  const normalizedTerms = Array.from(new Set(terms.map((term) => term.toLowerCase()).filter(Boolean))).slice(0, 12);
  if (normalizedTerms.length === 0) {
    return 0;
  }
  const textTokens = new Set(tokenize(text));
  const matches = normalizedTerms.filter((term) =>
    tokenize(term).every((token) => textTokens.has(token))
  ).length;
  return matches / normalizedTerms.length;
}

function malformedTextPenalty(text: string): number {
  if (!text) {
    return 1;
  }
  const controlChars = countPatternMatches(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g);
  const encodedBytes = countPatternMatches(text, /(?:%[0-9a-f]{2}|\\x[0-9a-f]{2})/gi);
  const symbolRuns = countPatternMatches(text, /[^\p{L}\p{N}\s.,!?;:'"()\-+]{5,}/gu);
  return clampScore((controlChars * 4 + encodedBytes + symbolRuns * 2) / Math.max(8, text.length));
}

function labelDumpDensity(text: string): number {
  const parts = text.split(/(?:\r?\n|[.!?]\s+)/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return 0;
  }
  const shortLabels = parts.filter((part) => (part.match(/[a-z0-9+]+/gi) ?? []).length <= 4).length;
  return shortLabels / parts.length;
}

function visibleLinkDensity(text: string): number {
  const urls = countPatternMatches(text, /https?:\/\/\S+/gi);
  const linkLabels = countPatternMatches(text, /(?:\[LINKS\]|\s->\s)/gi);
  return clampScore((urls * 3 + linkLabels * 2) / Math.max(8, (text.match(/[a-z0-9+]+/gi) ?? []).length));
}

export type GamingSnippetQuality = {
  score: number;
  passed: boolean;
  readability: number;
  queryOverlap: number;
  gameOverlap: number;
  navigationDensity: number;
  repetitionPenalty: number;
  linkDensity: number;
  malformedPenalty: number;
};

export function scoreGamingSnippetQuality(
  text: string,
  params: { queryTerms?: readonly string[]; gameTerms?: readonly string[]; mode?: GamingMode } = {}
): GamingSnippetQuality {
  const normalized = text.replace(/\s+/g, " ").trim();
  const readability = readabilityScore(normalized);
  const queryOverlap = matchedTermRatio(normalized, params.queryTerms ?? []);
  const gameOverlap = matchedTermRatio(normalized, params.gameTerms ?? []);
  const density = navigationDensity(normalized);
  const repetitionPenalty = repeatedTextPenalty(normalized);
  const linkDensity = visibleLinkDensity(normalized);
  const malformedPenalty = malformedTextPenalty(normalized);
  const labelsPenalty = labelDumpDensity(text);
  const modeSignal = params.mode && MODE_CONTENT_TERMS[params.mode].some((term) => normalized.toLowerCase().includes(term)) ? 0.08 : 0;
  const evidenceSignal = GAMEPLAY_CONTENT_PATTERN.test(normalized) ? 0.08 : 0;
  const words = normalized.toLowerCase().match(/[a-z0-9+]+/gi) ?? [];
  const wordCount = words.length;
  const hasSentencePunctuation = /[.!?]/.test(normalized);
  const hasProseConnector = /\b(?:a|an|and|as|at|before|by|for|from|if|in|into|of|on|or|the|then|to|when|while|with)\b/i.test(normalized);
  const proseSignal = hasSentencePunctuation || (wordCount >= 8 && hasProseConnector);
  const labelTermRatio = words.filter((word) => SNIPPET_LABEL_TERMS.has(word)).length / Math.max(1, wordCount);
  const originalWords = normalized.match(/[A-Za-z][A-Za-z0-9+_-]*/g) ?? [];
  const titleCaseRatio = originalWords.filter((word) => /^[A-Z]/.test(word)).length / Math.max(1, originalWords.length);
  const capitalizationDumpPenalty = !hasSentencePunctuation && wordCount >= 6 && titleCaseRatio >= 0.7 ? 0.5 : 0;
  const keywordDumpPenalty = hasSentencePunctuation
    ? 0
    : Math.max(clampScore((labelTermRatio - 0.25) * 1.2), capitalizationDumpPenalty);
  const score = clampScore(
    readability
    + queryOverlap * 0.26
    + gameOverlap * 0.2
    + modeSignal
    + evidenceSignal
    - density * 0.68
    - repetitionPenalty
    - linkDensity * 0.5
    - malformedPenalty
    - labelsPenalty * 0.22
    - keywordDumpPenalty * 0.65
  );
  return {
    score,
    passed: wordCount >= 4 && proseSignal && keywordDumpPenalty < 0.35 && score >= MIN_SNIPPET_QUALITY_SCORE && malformedPenalty < 0.35 && density < 0.62,
    readability,
    queryOverlap,
    gameOverlap,
    navigationDensity: density,
    repetitionPenalty,
    linkDensity,
    malformedPenalty
  };
}

function isReadableGameplayChunk(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return false;
  }

  const quality = scoreGamingSnippetQuality(normalized);
  if (!quality.passed) {
    return false;
  }

  return !(NAVIGATION_JUNK_PATTERN.test(normalized) && quality.navigationDensity >= 0.2);
}

function isRelevantGameplayChunk(
  text: string,
  candidate: GamingSourceCandidate,
  terms: readonly string[],
  input: GamingRagInput
): boolean {
  if (candidate.supplied) {
    return true;
  }

  const haystack = text.toLowerCase();
  const textTokens = new Set(tokenize(text));
  const detectedGame = normalizeGameName(input);
  const gameTerms = new Set(tokenize(detectedGame ?? ""));
  const hasGameOverlap = gameTerms.size > 0 && Array.from(gameTerms).every((term) => textTokens.has(term));
  const hasCandidateGameSignal = Boolean(detectedGame) && sourceGameOverlap(candidate, detectedGame) >= 0.8;
  const topicalTerms = terms.filter((term) =>
    tokenize(term).some((token) => !gameTerms.has(token) && !NON_TOPICAL_QUERY_TERMS.has(token))
  );
  const hasTopicalOverlap = topicalTerms.some((term) =>
    tokenize(term).every((token) => textTokens.has(token))
  );
  const hasModeSignal = MODE_CONTENT_TERMS[input.mode].some((term) => haystack.includes(term));
  const hasGenericGameplaySignal = topicalTerms.length === 0 && GAMEPLAY_CONTENT_PATTERN.test(text);
  const hasCompactCuratedFallback = candidate.sourceType === "curated"
    && text.trim().length <= 40
    && !NAVIGATION_JUNK_PATTERN.test(text);
  if (gameTerms.size > 0 && !candidate.games?.length && !hasGameOverlap && !hasCandidateGameSignal) {
    return false;
  }
  if (input.mode === "build" && topicalTerms.length > 0) {
    return hasTopicalOverlap || hasCompactCuratedFallback;
  }
  return hasTopicalOverlap || hasModeSignal || hasGenericGameplaySignal || hasCompactCuratedFallback;
}

function hashChunk(text: string): string {
  return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

function areNearDuplicateChunks(left: string, right: string): boolean {
  const normalize = (value: string): string[] => value
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  const leftWords = normalize(left);
  const rightWords = normalize(right);
  if (leftWords.join(" ") === rightWords.join(" ")) {
    return true;
  }
  if (leftWords.length < 8 || rightWords.length < 8) {
    return false;
  }
  const lengthRatio = Math.min(leftWords.length, rightWords.length) / Math.max(leftWords.length, rightWords.length);
  if (lengthRatio < 0.8) {
    return false;
  }

  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  const intersectionSize = Array.from(leftSet).filter((word) => rightSet.has(word)).length;
  const unionSize = new Set([...leftSet, ...rightSet]).size;
  return unionSize > 0 && intersectionSize / unionSize >= 0.86;
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
      if (!isReadableGameplayChunk(chunk) || !isRelevantGameplayChunk(chunk, document.candidate, terms, input)) {
        continue;
      }

      const haystack = chunk.toLowerCase();
      const chunkTokens = new Set(tokenize(chunk));
      const gameTerms = tokenize(normalizeGameName(input) ?? "");
      const quality = scoreGamingSnippetQuality(chunk, {
        queryTerms: terms,
        gameTerms,
        mode: input.mode
      });
      if (!quality.passed) {
        continue;
      }
      const termScore = Math.min(0.7, terms.filter((term) =>
        tokenize(term).every((token) => chunkTokens.has(token))
      ).length * 0.14);
      const gameScore = Math.min(0.24, gameTerms.filter((term) => chunkTokens.has(term)).length * 0.08);
      const modeTermCount = MODE_CONTENT_TERMS[input.mode].filter((term) => haystack.includes(term)).length;
      const modeScore = Math.min(0.35, modeTermCount * 0.07);
      const patchScore = patchSensitive && /\b(?:patch|hotfix|version|buff|nerf|balance|adjusted|changed)\b/i.test(chunk) ? 0.28 : 0;
      const freshnessScore = patchSensitive
        ? (document.candidate.sourceType === "patch_notes" ? 0.2 : document.candidate.stable ? 0 : 0.07)
          + (/\b(?:updated?|published|latest|current|hotfix|version|\d{4}-\d{2}-\d{2})\b/i.test(chunk) ? 0.1 : 0)
        : 0;
      const buildScore = input.mode === "build" && /\b(?:build|stats?|weapon|talent|gear|rotation|loadout|ability|attribute|module)\b/i.test(chunk) ? 0.22 : 0;
      const guideScore = input.mode === "guide" && /\b(?:route|walkthrough|first|after|location|boss|quest|progress|objective|exploration|mission|mechanic)\b/i.test(chunk) ? 0.18 : 0;
      const navigationPenalty = -(quality.navigationDensity * 1.1 + quality.linkDensity * 0.45 + (NAVIGATION_JUNK_PATTERN.test(chunk) ? 0.35 : 0));
      const evidenceDensityScore = Math.min(0.2, quality.queryOverlap * 0.12 + quality.readability * 0.08);
      const snippetQualityScore = quality.score;
      const duplicatePenalty = scoredChunks.some((scored) =>
        scored.candidate.url !== document.candidate.url
        && (scored.hash === hashChunk(chunk) || areNearDuplicateChunks(scored.text, chunk))
      ) ? 0.45 : 0;
      scoredChunks.push({
        candidate: document.candidate,
        text: chunk,
        score: scoreCandidate(input, document.candidate, terms, patchSensitive)
          + termScore
          + gameScore
          + modeScore
          + patchScore
          + freshnessScore
          + buildScore
          + guideScore
          + evidenceDensityScore
          + snippetQualityScore * 0.35
          + navigationPenalty
          - quality.repetitionPenalty
          - duplicatePenalty,
        hash: hashChunk(chunk),
        snippetQualityScore,
        navigationPenalty
      });
    }
  }

  const sortedChunks = scoredChunks.sort((left, right) =>
    right.score - left.score
    || left.candidate.url.localeCompare(right.candidate.url)
    || left.hash.localeCompare(right.hash)
  );
  const selectedChunks: GamingRankedChunk[] = [];
  for (const chunk of sortedChunks) {
    if (selectedChunks.some((selected) =>
      selected.candidate.url === chunk.candidate.url
      && (selected.hash === chunk.hash || areNearDuplicateChunks(selected.text, chunk.text))
    )) {
      continue;
    }
    selectedChunks.push(chunk);
    if (selectedChunks.length >= maxChunks) {
      break;
    }
  }

  return selectedChunks;
}

function buildSourceNumberByUrl(sources: GamingWebSource[]): Map<string, number> {
  return new Map(sources.map((source, index) => [source.url, index + 1]));
}

function buildPublicSourcesFromChunks(
  chunks: GamingRankedChunk[],
  documents: GamingFetchedDocument[],
  terms: readonly string[],
  input: GamingRagInput,
  excludedDocumentUrls: ReadonlySet<string> = new Set()
): GamingWebSource[] {
  const sourcesByUrl = new Map<string, GamingWebSource>();
  const chunkChars = getGamingRagChunkChars();
  for (const document of documents) {
    const selectedChunk = chunks.find((chunk) => chunk.candidate.url === document.candidate.url);
    if (selectedChunk) {
      const source = sourceFromChunk(selectedChunk);
      if (isCitableGamingWebSource(source)) {
        sourcesByUrl.set(document.candidate.url, source);
      }
    }
  }
  for (const document of documents) {
    if (sourcesByUrl.has(document.candidate.url)) {
      continue;
    }
    if (excludedDocumentUrls.has(document.candidate.url)) {
      sourcesByUrl.set(document.candidate.url, {
        url: document.candidate.url,
        snippet: LIMITED_ARTICLE_TEXT_SNIPPET
      });
      continue;
    }
    const hasReadableArticleText = splitIntoChunks(document.text, chunkChars).some((chunk) =>
      isReadableGameplayChunk(chunk) && isRelevantGameplayChunk(chunk, document.candidate, terms, input)
    );
    if (!hasReadableArticleText) {
      sourcesByUrl.set(document.candidate.url, {
        url: document.candidate.url,
        snippet: LIMITED_ARTICLE_TEXT_SNIPPET
      });
    }
  }

  return Array.from(sourcesByUrl.values());
}

function buildRagContext(
  chunks: GamingRankedChunk[],
  sources: GamingWebSource[],
  retrievalQuery: string,
  maxContextChars: number
): string {
  if (sources.length === 0) {
    return "";
  }

  const sourceNumberByUrl = buildSourceNumberByUrl(sources);
  const parts: string[] = [
    "[RETRIEVAL QUERY]",
    retrievalQuery || "prompt-only"
  ];

  const orderedChunks = chunks
    .map((chunk, index) => ({ chunk, index, sourceNumber: sourceNumberByUrl.get(chunk.candidate.url) ?? Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.sourceNumber - right.sourceNumber || left.index - right.index)
    .map((entry) => entry.chunk);

  orderedChunks.forEach((chunk) => {
    const sourceNumber = sourceNumberByUrl.get(chunk.candidate.url);
    const source = sourceNumber ? sources[sourceNumber - 1] : undefined;
    if (!sourceNumber || source?.snippet === LIMITED_ARTICLE_TEXT_SNIPPET) {
      return;
    }
    const domain = normalizeDomain(chunk.candidate.url);
    const evidenceText = extractReadableEvidenceText(chunk.text);
    if (!evidenceText) {
      return;
    }
    parts.push(
      "",
      `[Source ${sourceNumber}] ${chunk.candidate.url}`,
      `Title: ${chunk.candidate.title}; Domain: ${domain}; Type: ${chunk.candidate.sourceType}; Trust: ${chunk.candidate.trustScore.toFixed(2)}`,
      evidenceText
    );
  });

  sources.forEach((source, index) => {
    if (source.snippet !== LIMITED_ARTICLE_TEXT_SNIPPET) {
      return;
    }
    parts.push("", `[Source ${index + 1}] ${source.url}`, LIMITED_ARTICLE_CONTEXT_NOTE);
  });

  return parts.join("\n").slice(0, Math.max(0, maxContextChars));
}

function extractReadableEvidenceText(text: string): string {
  const withoutLinks = text.replace(/\s*\[LINKS\][\s\S]*$/i, "").replace(/\s+/g, " ").trim();
  if (!withoutLinks) {
    return "";
  }
  const sentences = withoutLinks
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0 && !SOURCE_INSTRUCTION_PATTERN.test(sentence));
  const safeText = sentences.join(" ").trim();
  if (!safeText) {
    return "";
  }
  if (isReadableGameplayChunk(safeText)) {
    return safeText;
  }
  return sentences.filter(isReadableGameplayChunk).join(" ").trim();
}

function truncateSnippet(text: string): string {
  if (text.length <= MAX_PUBLIC_SNIPPET_CHARS) {
    return text;
  }
  const candidate = text.slice(0, MAX_PUBLIC_SNIPPET_CHARS - 1);
  const boundary = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("; "), candidate.lastIndexOf(" "));
  const truncated = boundary >= Math.floor(MAX_PUBLIC_SNIPPET_CHARS * 0.6)
    ? candidate.slice(0, boundary + (candidate.slice(boundary, boundary + 2) === ". " ? 1 : 0))
    : candidate;
  return `${truncated.trimEnd()}…`;
}

function shapePublicSnippet(text: string): string {
  const evidenceText = extractReadableEvidenceText(text);
  return evidenceText ? truncateSnippet(evidenceText) : LIMITED_ARTICLE_TEXT_SNIPPET;
}

function sourceFromChunk(chunk: GamingRankedChunk): GamingWebSource {
  return {
    url: chunk.candidate.url,
    snippet: shapePublicSnippet(chunk.text)
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

function sourceDomainsFromSources(sources: GamingWebSource[]): string[] {
  return Array.from(new Set(sources.map((source) => normalizeDomain(source.url)).filter(Boolean)));
}

function retrievalReasonFor(input: GamingRagInput, game: string | undefined, suppliedSourceCount: number, patchSensitive: boolean): string {
  if (suppliedSourceCount > 0) {
    return "supplied_sources";
  }
  if (patchSensitive) {
    return "patch_or_meta_sensitive";
  }
  if (game) {
    return "game_detected_source_catalog";
  }
  return "no_supported_source_candidates";
}

function emptyRagContext(params: {
  enabled: boolean;
  reason: string;
  query: string;
  startedAt: number;
  gameDetection: GamingGameDetection;
  sources?: GamingWebSource[];
  rankingStartedAt?: number;
  fallbackReason?: string;
}): GamingRagContext {
  const sources = params.sources ?? [];
  const clear = buildClearChecks({
    retrievalEnabled: params.enabled,
    sourceCount: 0,
    context: "",
    fallbackReason: params.fallbackReason
  });
  return {
    context: "",
    sources,
    retrievedSourceCount: 0,
    publicSourceCount: sources.length,
    omittedSourceCount: 0,
    retrievalEnabled: params.enabled,
    retrievalReason: params.reason,
    retrievalQuery: params.query,
    sourceDomains: [],
    cacheHit: false,
    retrievalElapsedMs: Date.now() - params.startedAt,
    rankingElapsedMs: params.rankingStartedAt ? Date.now() - params.rankingStartedAt : 0,
    ...(params.gameDetection.game ? { detectedGame: params.gameDetection.game } : {}),
    gameDetectionConfidence: params.gameDetection.confidence,
    gameDetectionSource: params.gameDetection.source,
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
  const requestedGuideUrls = collectGamingGuideUrls(input)
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0);
  const suppliedSourceCount = requestedGuideUrls.length;
  const validSuppliedSourceCount = requestedGuideUrls.filter(isFetchableGuideUrl).length;
  const initialGameDetection = detectGameFromRagInput(input);
  const game = initialGameDetection.game;
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
      startedAt: retrievalStartedAt,
      gameDetection: initialGameDetection
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
      ...(game ? { game, detectedGame: game } : {}),
      gameDetectionConfidence: initialGameDetection.confidence,
      gameDetectionSource: initialGameDetection.source,
      retrievalEnabled,
      retrievalReason,
      retrievalQueryTermCount: terms.length,
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
      startedAt: retrievalStartedAt,
      gameDetection: initialGameDetection,
      ...(suppliedSourceCount > 0 && validSuppliedSourceCount === 0
        ? { sources: [{ url: "invalid-source", error: "Malformed or unsupported source URL." }] }
        : {})
    });
  }

  const fetchedResults = await Promise.all(
    candidates.map((candidate, index) =>
      fetchGamingRagDocument(
        candidate,
        input,
        patchSensitive,
        Array.from(new Set([...terms, ...MODE_CONTENT_TERMS[input.mode]])),
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
  const effectiveGameDetection = detectGameFromFetchedDocuments(initialGameDetection, documents);
  const requestedGame = initialGameDetection.game?.toLowerCase();
  const conflictingDocumentUrls = new Set(
    requestedGame
      ? documents
        .filter((document) => {
          const documentGame = detectReliableDocumentGame(document);
          return Boolean(documentGame && documentGame.toLowerCase() !== requestedGame);
        })
        .map((document) => document.candidate.url)
      : []
  );
  const rankableDocuments = documents.filter((document) => !conflictingDocumentUrls.has(document.candidate.url));
  const effectiveInput: GamingRagInput = effectiveGameDetection.game
    ? { ...input, game: effectiveGameDetection.game }
    : input;
  const effectiveTerms = extractTopicTerms(effectiveInput, effectiveGameDetection.game);
  const effectiveRetrievalQuery = buildRetrievalQuery(effectiveInput, effectiveGameDetection.game, effectiveTerms);
  const rankingStartedAt = Date.now();
  const chunks = rankChunks(rankableDocuments, effectiveTerms, effectiveInput, patchSensitive);
  const sources = buildPublicSourcesFromChunks(
    chunks,
    documents,
    effectiveTerms,
    effectiveInput,
    conflictingDocumentUrls
  );
  const context = buildRagContext(chunks, sources, effectiveRetrievalQuery, maxContextChars);
  const rankingElapsedMs = Date.now() - rankingStartedAt;
  const sourceDomains = sourceDomainsFromSources(sources);
  const cacheHit = documents.some((document) => document.cacheHit);
  const fallbackReason = documents.length === 0 && timedOut ? "INTAKE_RETRIEVAL_TIMEOUT" : undefined;
  const retrievedSourceCount = documents.length;
  const publicSourceCount = sources.length;
  const omittedSourceCount = Math.max(0, chunks.length - publicSourceCount);
  const clear = buildClearChecks({
    retrievalEnabled,
    sourceCount: sources.length,
    context,
    fallbackReason
  });

  if (logContext) {
    for (const document of documents) {
      const selectedChunk = chunks.find((chunk) => chunk.candidate.url === document.candidate.url);
      const publicSource = sources.find((source) => source.url === document.candidate.url);
      logger.info("gaming.retrieval.source.selection", {
        ...logContext,
        ...(effectiveGameDetection.game ? { game: effectiveGameDetection.game, detectedGame: effectiveGameDetection.game } : {}),
        gameDetectionConfidence: effectiveGameDetection.confidence,
        gameDetectionSource: effectiveGameDetection.source,
        ...buildSafeSourceLogTarget(document.candidate.url),
        cacheHit: document.cacheHit,
        extractionStrategy: document.extraction.strategy,
        selectedContainer: document.extraction.selectedContainer ?? document.extraction.strategy,
        extractionQualityScore: document.extraction.qualityScore ?? null,
        extractionNavigationPenalty: document.extraction.navigationPenalty ?? null,
        extractionLinkDensity: document.extraction.linkDensity ?? null,
        extractionCandidateCount: document.extraction.candidateCount ?? null,
        rawTextLength: document.extraction.rawTextLength,
        cleanedTextLength: document.extraction.cleanedTextLength,
        chunkCount: splitIntoChunks(document.text, getGamingRagChunkChars()).length,
        selectedChunkScore: selectedChunk ? Number(selectedChunk.score.toFixed(4)) : null,
        snippetQualityScore: selectedChunk ? Number(selectedChunk.snippetQualityScore.toFixed(4)) : null,
        navigationPenalty: selectedChunk ? Number(selectedChunk.navigationPenalty.toFixed(4)) : null,
        fallbackSnippetUsed: publicSource?.snippet === LIMITED_ARTICLE_TEXT_SNIPPET,
        ...(publicSource?.snippet === LIMITED_ARTICLE_TEXT_SNIPPET
          ? {
            fallbackReason: conflictingDocumentUrls.has(document.candidate.url)
              ? "GAME_METADATA_CONFLICT"
              : "READABLE_ARTICLE_TEXT_LIMITED"
          }
          : {}),
        retrievalElapsedMs: Date.now() - retrievalStartedAt
      });
    }

    logger.info("gaming.retrieval.end", {
      ...logContext,
      ...(effectiveGameDetection.game ? { game: effectiveGameDetection.game, detectedGame: effectiveGameDetection.game } : {}),
      gameDetectionConfidence: effectiveGameDetection.confidence,
      gameDetectionSource: effectiveGameDetection.source,
      retrievalEnabled,
      retrievalReason,
      retrievalQueryTermCount: effectiveTerms.length,
      sourceCount: sources.length,
      retrievedSourceCount,
      publicSourceCount,
      omittedSourceCount,
      sourceDomains,
      cacheHit,
      retrievalElapsedMs: Date.now() - retrievalStartedAt,
      rankingElapsedMs,
      usableSourceCount: sources.filter(isCitableGamingWebSource).length,
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
    retrievedSourceCount,
    publicSourceCount: sources.length > 0 ? publicSourceCount : errorSources.length,
    omittedSourceCount: sources.length > 0 ? omittedSourceCount : 0,
    retrievalEnabled,
    retrievalReason,
    retrievalQuery: effectiveRetrievalQuery,
    sourceDomains,
    cacheHit,
    retrievalElapsedMs: Date.now() - retrievalStartedAt,
    rankingElapsedMs,
    ...(effectiveGameDetection.game ? { detectedGame: effectiveGameDetection.game } : {}),
    gameDetectionConfidence: effectiveGameDetection.confidence,
    gameDetectionSource: effectiveGameDetection.source,
    ...(fallbackReason ? { fallbackReason } : {}),
    clear
  };
}
