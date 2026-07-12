import { createHash } from "node:crypto";
import { load } from "cheerio";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { redactString } from "@shared/redaction.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnv } from "@platform/runtime/env.js";
import {
  fetchAndClean,
  type FetchAndCleanExtractionMetrics,
  type FetchAndCleanOptions,
  type FetchAndCleanRawDocument
} from "@shared/webFetcher.js";
import {
  getGamingDiscoveryBudgetMs,
  getGamingDiscoveryEnabled,
  getGamingDiscoveryMinEvidenceQuality,
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
  clearGamingDiscoveryCache,
  discoverGamingSources,
  sanitizeGamingDiscoveryCandidateUrl,
  type GamingDiscoveredCandidate
} from "@services/gamingSourceDiscovery.js";
import {
  canonicalizeGamingGameName,
  detectGamingGame,
  type GamingGameDetection,
  type GamingGameDetectionSource
} from "@services/gamingGameDetection.js";
import {
  extractExplicitGamingVersions,
  textContainsExactGamingVersion
} from "@services/gamingVersion.js";
import {
  GAMING_BUILD_RESOURCE_HARD_LIMITS,
  classifyGamingResource,
  clearGamingBuildResourceCache,
  ingestGamingBuildResource,
  prepareGamingResourceUrl,
  type GamingBuildResourceResult,
  type GamingResourceType
} from "@services/gamingBuildResources.js";
import type {
  GamingDiscoveryFailureReason,
  GamingDiscoveryReason,
  GamingFallbackReason,
  GamingMode,
  GamingSuccessEnvelope,
  ValidatedGamingRequest
} from "@services/gamingModes.js";

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
  currentEvidenceAvailable: boolean;
  fallbackReason?: GamingFallbackReason;
  discoveryEnabled: boolean;
  discoveryTriggered: boolean;
  discoveryReason: GamingDiscoveryReason;
  searchProvider?: string;
  searchQueryHash?: string;
  searchResultCount: number;
  candidateCount: number;
  rejectedCandidateCount: number;
  fetchedCandidateCount: number;
  acceptedSourceCount: number;
  discoveryCacheHit: boolean;
  discoveryElapsedMs: number;
  candidateRankingElapsedMs: number;
  discoveryFailureReason?: GamingDiscoveryFailureReason;
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
export type GamingRagInput = Pick<
  ValidatedGamingRequest,
  "mode" | "prompt" | "game" | "guideUrl" | "guideUrls" | "evidenceOrigin" | "requestedVersion" | "evidenceAttempt"
>;

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
  discovered?: boolean;
  frontendDiscovered?: boolean;
  requestedVersions?: string[];
  searchScore?: number;
  searchProvider?: string;
  providerRank?: number;
  publishedAt?: string;
  updatedAt?: string;
  gameCorroborated?: boolean;
  versionCorroborated?: boolean;
  freshnessCorroborated?: boolean;
};

type GamingFetchedDocument = {
  candidate: GamingSourceCandidate;
  text: string;
  fetchedAt: string;
  cacheHit: boolean;
  extraction: FetchAndCleanExtractionMetrics;
  structured?: {
    result: GamingBuildResourceResult;
    evidenceUsed: boolean;
  };
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
const MAX_PUBLIC_GAMING_SOURCES = 8;
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
  corroborationText?: string;
  fetchedAt: string;
  fetchedPageDate?: string;
  expiresAt: number;
  extraction: FetchAndCleanExtractionMetrics;
  structured?: GamingFetchedDocument["structured"];
}>();

const FRONTEND_EVIDENCE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

function normalizeFrontendEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(FRONTEND_EVIDENCE_CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFetchedPageDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const bounded = value.trim().slice(0, 64);
  if (!bounded || !/\d{4}/.test(bounded)) {
    return undefined;
  }
  const timestamp = Date.parse(bounded);
  const earliestTimestamp = Date.UTC(2000, 0, 1);
  if (!Number.isFinite(timestamp) || timestamp < earliestTimestamp || timestamp > Date.now() + 24 * 60 * 60_000) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function isRecentGamingEvidenceDate(value: string): boolean {
  const timestamp = Date.parse(value);
  const sourceAgeMs = Date.now() - timestamp;
  return Number.isFinite(timestamp)
    && sourceAgeMs >= 0
    && sourceAgeMs <= 540 * 24 * 60 * 60_000;
}

function extractFetchedPageDate(document: FetchAndCleanRawDocument | undefined, fetchUrl: string): string | undefined {
  if (!document?.contentType.toLowerCase().includes("html") || !document.body) {
    return undefined;
  }
  try {
    const $ = load(document.body);
    const modifiedCandidates: string[] = [];
    const publishedCandidates: string[] = [];
    const fallbackCandidates: string[] = [];
    const jsonLdArticles: Array<{ matchesFetchedUrl: boolean; modified?: string; published?: string }> = [];
    const normalizeDocumentIdentity = (value: string): string | undefined => {
      try {
        const parsed = new URL(value, fetchUrl);
        return `${parsed.origin}${parsed.pathname.replace(/\/$/u, "") || "/"}`.toLowerCase();
      } catch {
        return undefined;
      }
    };
    const fetchedDocumentIdentity = normalizeDocumentIdentity(fetchUrl);
    const modifiedMetadataKeys = new Set([
      "article:modified_time", "datemodified", "last-modified", "lastmodified", "modified"
    ]);
    const publishedMetadataKeys = new Set([
      "article:published_time", "date", "datepublished", "published"
    ]);
    $("head meta").slice(0, 64).each((_index, element) => {
      const key = ($(element).attr("property") ?? $(element).attr("name") ?? $(element).attr("itemprop") ?? "")
        .trim()
        .toLowerCase();
      const content = $(element).attr("content");
      if (content && modifiedMetadataKeys.has(key)) {
        modifiedCandidates.push(content);
      } else if (content && publishedMetadataKeys.has(key)) {
        publishedCandidates.push(content);
      }
    });
    $("script[type='application/ld+json']").slice(0, 8).each((_index, element) => {
      const script = $(element).text().slice(0, 32_000);
      try {
        const parsed = JSON.parse(script) as unknown;
        const roots = Array.isArray(parsed) ? parsed : [parsed];
        const nodes = roots.flatMap((root) => {
          if (!root || typeof root !== "object" || Array.isArray(root)) {
            return [];
          }
          const graph = (root as Record<string, unknown>)["@graph"];
          return [root, ...(Array.isArray(graph) ? graph : [])];
        }).slice(0, 32);
        for (const node of nodes) {
          if (!node || typeof node !== "object" || Array.isArray(node)) {
            continue;
          }
          const record = node as Record<string, unknown>;
          const rawTypes = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
          const articleTyped = rawTypes.some((type) =>
            typeof type === "string" && /^(?:article|blogposting|newsarticle|techarticle)$/iu.test(type.trim())
          );
          if (!articleTyped) {
            continue;
          }
          const mainEntity = record.mainEntityOfPage;
          const identityValues = [
            record.url,
            record["@id"],
            typeof mainEntity === "string"
              ? mainEntity
              : mainEntity && typeof mainEntity === "object" && !Array.isArray(mainEntity)
                ? (mainEntity as Record<string, unknown>)["@id"]
                : undefined
          ].filter((value): value is string => typeof value === "string");
          const matchesFetchedUrl = Boolean(
            fetchedDocumentIdentity
            && identityValues.some((value) => normalizeDocumentIdentity(value) === fetchedDocumentIdentity)
          );
          jsonLdArticles.push({
            matchesFetchedUrl,
            ...(typeof record.dateModified === "string" ? { modified: record.dateModified } : {}),
            ...(typeof record.datePublished === "string" ? { published: record.datePublished } : {})
          });
        }
      } catch {
        // Invalid or oversized JSON-LD is not a trustworthy freshness signal.
      }
    });
    const matchingJsonLdArticles = jsonLdArticles.filter((article) => article.matchesFetchedUrl);
    const eligibleJsonLdArticles = matchingJsonLdArticles.length > 0
      ? matchingJsonLdArticles
      : jsonLdArticles.length === 1
        ? jsonLdArticles
        : [];
    for (const article of eligibleJsonLdArticles) {
      if (article.modified) {
        modifiedCandidates.push(article.modified);
      }
      if (article.published) {
        publishedCandidates.push(article.published);
      }
    }
    $("article > header time[datetime], main > header time[datetime]")
      .slice(0, 16)
      .each((_index, element) => {
      const datetime = $(element).attr("datetime");
      if (datetime) {
        fallbackCandidates.push(datetime);
      }
    });
    for (const candidates of [modifiedCandidates, publishedCandidates, fallbackCandidates]) {
      const date = candidates
        .map(normalizeFetchedPageDate)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
      if (date) {
        return date;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

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

function runWithLocalTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
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
    parentSignal?.removeEventListener("abort", abortFromParent);
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
  return prepareGamingResourceUrl(url)?.publicUrl ?? "invalid-source";
}

const FRONTEND_PUBLIC_PAYLOAD_KEY_PATTERN = /^(?:b|build|builddata|code|data|deck|export|import|json|loadout|payload|share|skills?|talents?|tree)$/iu;
const FRONTEND_PUBLIC_IDENTITY_PARAMS = new Set([
  "article", "game", "id", "oldid", "p", "page", "profile", "slug", "title", "topic"
]);

function sanitizeFrontendPublicSourceUrl(url: string): string {
  try {
    const preparedUrl = prepareGamingResourceUrl(url);
    if (!preparedUrl) {
      return "invalid-source";
    }
    const parsedUrl = new URL(preparedUrl.publicUrl);
    const originalUrl = new URL(url);
    parsedUrl.username = "";
    parsedUrl.password = "";
    parsedUrl.hash = "";
    const safeSegments: string[] = [];
    const rawSegments = parsedUrl.pathname.split("/").filter(Boolean);
    const originalRawSegments = originalUrl.pathname.split("/").filter(Boolean);
    for (const [index, rawSegment] of rawSegments.entries()) {
      if (!rawSegment) {
        continue;
      }
      let decodedSegment: string;
      try {
        decodedSegment = decodeURIComponent(rawSegment);
      } catch {
        break;
      }
      const nextRawSegment = originalRawSegments[index + 1] ?? rawSegments[index + 1];
      let nextDecodedSegment = "";
      try {
        nextDecodedSegment = nextRawSegment ? decodeURIComponent(nextRawSegment) : "";
      } catch {
        nextDecodedSegment = "";
      }
      const nextIsPayloadLike = nextDecodedSegment.length >= 48
        && /^[A-Za-z0-9+/_=-]+$/u.test(nextDecodedSegment);
      if (decodedSegment.length > 160 || (FRONTEND_PUBLIC_PAYLOAD_KEY_PATTERN.test(decodedSegment) && nextIsPayloadLike)) {
        break;
      }
      if (redactString(decodedSegment) === "[REDACTED]") {
        break;
      }
      safeSegments.push(rawSegment);
    }
    parsedUrl.pathname = `/${safeSegments.join("/")}`;
    const safeParams = new URLSearchParams();
    for (const [key, value] of parsedUrl.searchParams.entries()) {
      const normalizedKey = key.toLowerCase();
      if (
        FRONTEND_PUBLIC_PAYLOAD_KEY_PATTERN.test(normalizedKey)
        || !FRONTEND_PUBLIC_IDENTITY_PARAMS.has(normalizedKey)
        || value.length === 0
        || value.length > 120
        || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
        || redactString(value) === "[REDACTED]"
      ) {
        continue;
      }
      safeParams.append(normalizedKey, value);
    }
    safeParams.sort();
    parsedUrl.search = safeParams.toString();
    return parsedUrl.toString();
  } catch {
    return "invalid-source";
  }
}

function neutralizeFrontendStructuredIngestionUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.username = "";
    parsedUrl.password = "";
    parsedUrl.pathname = "/";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return "https://invalid-source.invalid/";
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

function sourceUrlForGamingError(sourceUrl: string, error: unknown): string {
  const message = resolveErrorMessage(error, "").toLowerCase();
  return /private\/internal|containing credentials/.test(message) ? "invalid-source" : sourceUrl;
}

function isStructuredGamingResourceType(type: GamingResourceType): boolean {
  return type === "build_planner"
    || type === "loadout"
    || type === "skill_tree"
    || type === "character_profile"
    || type === "calculator";
}

function structuredResultLogFields(result: GamingBuildResourceResult | undefined): Record<string, unknown> {
  if (!result) {
    return {};
  }
  return {
    detectedGame: result.classification.detectedGame ?? null,
    gameConfidence: result.classification.gameConfidence,
    resourceType: result.classification.type,
    resourceConfidence: result.classification.confidence,
    adapterId: result.adapterId,
    adapterVersion: result.adapterVersion,
    structuredExtractionStrategy: result.extractionStrategy,
    payloadLength: result.metrics.payloadLength,
    payloadHash: result.metrics.payloadHash,
    decodedSize: result.metrics.decodedSize,
    normalizedFieldCount: result.metrics.normalizedFieldCount,
    equipmentCount: result.metrics.equipmentCount,
    skillCount: result.metrics.skillCount,
    statCount: result.metrics.statCount,
    extractionQuality: result.quality,
    validationResult: result.validation.accepted ? "accepted" : "rejected",
    validationIssueCount: result.validation.issues.length,
    structuredCacheHit: result.cacheHit,
    structuredExtractionElapsedMs: result.metrics.extractionElapsedMs,
    ...(result.failureReason ? { structuredFallbackReason: result.failureReason } : {})
  };
}

function structuredExtractionMetrics(
  result: GamingBuildResourceResult,
  fallback?: FetchAndCleanExtractionMetrics
): FetchAndCleanExtractionMetrics {
  const text = result.evidenceText || result.publicSnippet;
  return {
    strategy: `structured:${result.extractionStrategy}`,
    rawTextLength: fallback?.rawTextLength ?? text.length,
    cleanedTextLength: text.length,
    fetchElapsedMs: fallback?.fetchElapsedMs,
    extractionElapsedMs: result.metrics.extractionElapsedMs,
    selectedContainer: result.extractionStrategy,
    qualityScore: result.classification.confidence,
    navigationPenalty: 0,
    navigationDensity: 0,
    linkDensity: 0,
    candidateCount: 1,
    documentTitle: result.build?.title ?? fallback?.documentTitle,
    headingText: fallback?.headingText
  };
}

function hasUsefulArticleFallback(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return normalized.length >= 80 && words >= 14 && /[.!?]/u.test(normalized);
}

function shouldUseStructuredEvidence(result: GamingBuildResourceResult, articleText: string): boolean {
  if (result.build && result.validation.accepted && result.quality !== "metadata-only") {
    return true;
  }
  return isStructuredGamingResourceType(result.classification.type) && !hasUsefulArticleFallback(articleText);
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
            fetchElapsedMs: extraction.fetchElapsedMs ?? null,
            extractionElapsedMs: extraction.extractionElapsedMs ?? null,
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
        return { url: sourceUrlForGamingError(sourceUrl, error), error: safeGamingSourceError(error) };
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
  onExtraction: (metrics: FetchAndCleanExtractionMetrics) => void,
  onRawDocument?: (document: FetchAndCleanRawDocument) => void,
  rawDocumentMaxChars?: number
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
    onExtraction,
    ...(onRawDocument
      ? {
        onRawDocument,
        ...(rawDocumentMaxChars !== undefined ? { rawDocumentMaxChars } : {})
      }
      : {})
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
  const structuredClassification = document.structured?.result.classification;
  const structuredGame = structuredClassification?.detectedGame;
  if (
    structuredGame
    && structuredClassification.gameConfidence >= 0.7
    && isStructuredGamingResourceType(structuredClassification.type)
  ) {
    return canonicalizeGamingGameName(structuredGame);
  }
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

function detectGameFromDocumentIntro(
  document: GamingFetchedDocument,
  requestedGame?: string
): string | undefined {
  const normalizedBody = document.text.replace(/\s+/g, " ").trim();
  const sentenceEnd = normalizedBody.search(/[.!?](?:\s|$)/);
  const intro = normalizedBody.slice(0, Math.min(sentenceEnd >= 0 ? sentenceEnd + 1 : normalizedBody.length, 320));
  if (!/\b(?:guide|build|loadout|meta|walkthrough|wiki|tips?|tier\s+list|patch\s+notes|progression|route|boss)\b/i.test(intro)) {
    return undefined;
  }
  const normalizedIntro = intro.replace(/^[\s'"“‘([{]+/u, "").toLowerCase();
  const canonicalRequested = requestedGame
    ? canonicalizeGamingGameName(requestedGame)
    : undefined;
  const normalizedRequested = canonicalRequested
    ? canonicalRequested.toLowerCase()
    : undefined;
  if (canonicalRequested && normalizedRequested && normalizedIntro.startsWith(normalizedRequested)) {
    const boundary = normalizedIntro.charAt(normalizedRequested.length);
    if (!boundary || /[^a-z0-9]/i.test(boundary)) {
      const suffix = normalizedIntro
        .slice(normalizedRequested.length)
        .trimStart()
        .replace(/^[:\-–—]\s*/u, "");
      const dottedVersion = /^(?:v(?:ersion)?\.?\s*)?\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/i.test(suffix);
      const descriptiveSuffix = /^(?:beginner|boss|build|class|combat|community|current|early|endgame|exploration|first|guide|late|legacy|leveling|loadout|main|mechanics?|meta|mining|patch|progression|pve|pvp|quest|raids?|route|season|strategy|survival|tier|tips?|update|walkthrough|wiki)\b/i.test(suffix);
      if (dottedVersion || descriptiveSuffix) {
        return canonicalRequested;
      }
    }
  }
  const detection = detectGamingGame({ pageTitle: intro });
  if (!detection.game || detection.confidence < 0.8) {
    return undefined;
  }
  const detectedGame = canonicalizeGamingGameName(detection.game);
  const detectedGameWords = detectedGame.match(/[a-z0-9+]+/gi) ?? [];
  const gameAnchorsIntro = normalizedIntro.startsWith(detectedGame.toLowerCase());
  return detection.confidence >= 0.88 || (detectedGameWords.length >= 2 && gameAnchorsIntro)
    ? detectedGame
    : undefined;
}

function gamingGameNamesMatch(candidateGame: string, requestedGame: string): boolean {
  const normalizedCandidate = canonicalizeGamingGameName(candidateGame).toLowerCase();
  const normalizedRequested = canonicalizeGamingGameName(requestedGame).toLowerCase();
  if (normalizedCandidate === normalizedRequested) {
    return true;
  }
  if (!normalizedCandidate.startsWith(`${normalizedRequested} `)) {
    return false;
  }
  const suffix = normalizedCandidate.slice(normalizedRequested.length).trim();
  return /^(?:v(?:ersion)?\.?\s*)?\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/i.test(suffix);
}

function collectConflictingDocumentUrls(
  documents: readonly GamingFetchedDocument[],
  requestedGame: string | undefined
): Set<string> {
  return new Set(documents
    .filter((document) => {
      if (document.candidate.frontendDiscovered) {
        if (!requestedGame || document.candidate.gameCorroborated !== true) {
          return true;
        }
        if ((document.candidate.requestedVersions?.length ?? 0) > 0 && document.candidate.versionCorroborated !== true) {
          return true;
        }
        if ((document.candidate.requestedVersions?.length ?? 0) > 0) {
          if (document.candidate.freshnessCorroborated === false) {
            return true;
          }
        } else if (document.candidate.freshnessCorroborated !== true) {
          return true;
        }
      }
      if (!requestedGame) {
        return false;
      }
      const reliableGame = detectReliableDocumentGame(document);
      if (reliableGame) {
        return !gamingGameNamesMatch(reliableGame, requestedGame);
      }
      const introGame = detectGameFromDocumentIntro(document, requestedGame);
      return Boolean(introGame && !gamingGameNamesMatch(introGame, requestedGame));
    })
    .map((document) => document.candidate.url));
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

function fetchedDocumentCorroboratesGame(
  text: string,
  extraction: FetchAndCleanExtractionMetrics,
  game: string | undefined
): boolean {
  if (!game) {
    return false;
  }
  const canonicalGame = canonicalizeGamingGameName(game).toLowerCase();
  const gameTerms = tokenize(canonicalGame).filter((term) => !["the", "and", "for", "of"].includes(term));
  if (gameTerms.length === 0) {
    return false;
  }
  const bodyTokens = new Set(tokenize(text));
  if (gameTerms.every((term) => bodyTokens.has(term))) {
    return true;
  }
  const metadataDetection = detectGamingGame({
    pageTitle: extraction.documentTitle,
    pageHeadings: extraction.headingText
  });
  return Boolean(
    metadataDetection.game
    && metadataDetection.confidence >= 0.7
    && canonicalizeGamingGameName(metadataDetection.game).toLowerCase() === canonicalGame
  );
}

function frontendDocumentCorroboratesGame(
  text: string,
  extraction: FetchAndCleanExtractionMetrics,
  game: string | undefined
): boolean {
  if (!game) {
    return false;
  }
  const canonicalGame = canonicalizeGamingGameName(game).toLowerCase();
  const metadataDetection = detectGamingGame({
    pageTitle: extraction.documentTitle,
    pageHeadings: extraction.headingText
  });
  if (
    metadataDetection.game
    && metadataDetection.confidence >= 0.7
    && canonicalizeGamingGameName(metadataDetection.game).toLowerCase() === canonicalGame
  ) {
    return true;
  }

  const metadata = `${extraction.documentTitle ?? ""} ${extraction.headingText ?? ""}`
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const escapedGame = canonicalGame.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactGamePattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapedGame}(?=$|[^\\p{L}\\p{N}])`, "iu");
  if (exactGamePattern.test(metadata)) {
    return true;
  }

  const intro = text.slice(0, 320).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const introMatch = exactGamePattern.exec(intro);
  return Boolean(introMatch && introMatch.index <= 160 && GAMEPLAY_CONTENT_PATTERN.test(intro));
}

function candidateWithFetchedGameCorroboration(
  candidate: GamingSourceCandidate,
  input: GamingRagInput,
  text: string,
  extraction: FetchAndCleanExtractionMetrics,
  fetchedPageDate?: string
): GamingSourceCandidate {
  if (!candidate.discovered && !candidate.frontendDiscovered) {
    return candidate;
  }
  const evidenceText = [extraction.documentTitle, extraction.headingText, text]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return {
    ...candidate,
    gameCorroborated: candidate.frontendDiscovered
      ? frontendDocumentCorroboratesGame(text, extraction, normalizeGameName(input))
      : fetchedDocumentCorroboratesGame(evidenceText, extraction, normalizeGameName(input)),
    ...(candidate.requestedVersions?.length
      ? { versionCorroborated: candidate.requestedVersions.every((version) => textContainsExactGamingVersion(evidenceText, version)) }
      : {}),
    ...(candidate.frontendDiscovered
      ? { freshnessCorroborated: fetchedPageDate ? isRecentGamingEvidenceDate(fetchedPageDate) : undefined }
      : {}),
    ...(candidate.frontendDiscovered && fetchedPageDate ? { updatedAt: fetchedPageDate } : {})
  };
}

export function isGamingFreshnessSensitive(input: GamingRagInput): boolean {
  return Boolean(input.requestedVersion)
    || input.mode === "meta"
    || /\b(?:patch|hotfix|version|season|latest|current|right\s+now|meta|buff|nerf|balance|viable)\b|\b(?:(?:newly|just|recently)\s+released|new\s+release)\b/i.test(input.prompt)
    || extractExplicitGamingVersions({ prompt: input.prompt, game: normalizeGameName(input) }).length > 0;
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
    isGamingFreshnessSensitive(input) ? "latest patch notes current meta" : "",
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
  } catch {
    logger.warn("gaming.config.curated_sources.parse_failed", {
      errorCode: "CURATED_SOURCES_PARSE_FAILED"
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

function makeDiscoveredSourceCandidate(
  result: GamingDiscoveredCandidate,
  input: GamingRagInput
): GamingSourceCandidate {
  const candidate = makeSourceCandidate({
    url: result.url,
    // Search-result titles and snippets are untrusted scoring data and never enter generated context.
    title: safeSourceTitleFromUrl(result.url),
    sourceType: result.suggestedSourceType,
    topics: [input.mode],
    modes: [input.mode],
    stable: result.stable
  }, false, result.suggestedSourceType === "official" || result.suggestedSourceType === "patch_notes" ? 0.76 : 0.62);
  return {
    ...candidate,
    discovered: true,
    searchScore: result.score,
    searchProvider: result.provider,
    providerRank: result.providerRank,
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    ...(result.updatedAt ? { updatedAt: result.updatedAt } : {})
  };
}

function buildSourceCandidates(input: GamingRagInput, game: string | undefined): GamingSourceCandidate[] {
  const frontendRequestedVersions = Array.from(new Set([
    ...(input.requestedVersion ? [input.requestedVersion] : []),
    ...extractExplicitGamingVersions({ prompt: input.prompt, game })
  ]));
  const suppliedUrls = Array.from(new Map(
    collectGamingGuideUrls(input)
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .flatMap((url) => {
        if (input.evidenceOrigin !== "frontend_web_search") {
          return isFetchableGuideUrl(url) ? [url] : [];
        }
        const sanitized = sanitizeGamingDiscoveryCandidateUrl(url);
        return sanitized.url && !sanitized.rejected ? [sanitized.url] : [];
      })
      .map((url) => [normalizeCacheUrl(url).toLowerCase(), url] as const)
  ).values()).slice(0, getGamingWebContextMaxUrls());
  const suppliedCandidates = suppliedUrls.map((url) => makeSourceCandidate({
    url,
    title: safeSourceTitleFromUrl(url),
    sourceType: "supplied",
    topics: ["supplied", input.mode],
    ...(game ? { games: [game] } : {}),
    modes: ["guide", "build", "meta"],
    stable: true
  }, true, 0.68)).map((candidate) => input.evidenceOrigin === "frontend_web_search"
    ? {
        ...candidate,
        url: sanitizeFrontendPublicSourceUrl(candidate.fetchUrl),
        frontendDiscovered: true,
        ...(frontendRequestedVersions.length > 0 ? { requestedVersions: frontendRequestedVersions } : {})
      }
    : candidate);

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
    const dedupeUrl = candidate.frontendDiscovered ? candidate.url : candidate.fetchUrl;
    const key = createHash("sha256").update(normalizeCacheUrl(dedupeUrl).toLowerCase()).digest("hex");
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
  const discoveryBoost = candidate.discovered
    ? Math.min(0.2, (candidate.searchScore ?? 0) * 0.2)
      + Math.min(0.06, 0.06 / Math.max(1, candidate.providerRank ?? 1))
    : 0;
  const modeBoost = candidate.modes.includes(input.mode) ? 0.16 : 0;
  const patchBoost = patchSensitive && candidate.sourceType === "patch_notes" ? 0.36 : 0;
  const guideBoost = input.mode === "guide" && candidate.stable ? 0.18 : 0;
  const buildBoost = input.mode === "build" && /\b(?:build|gear|talent|weapon|stats?|rotation|bleed|frost)\b/i.test(haystack) ? 0.2 : 0;
  const wikiGuidePenalty = patchSensitive && candidate.sourceType === "wiki" ? -0.08 : 0;
  return candidate.trustScore + suppliedBoost + discoveryBoost + modeBoost + patchBoost + guideBoost + buildBoost + termScore + gameScore + wikiGuidePenalty;
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
  sourceCount: number,
  requestSignal?: AbortSignal
): Promise<GamingFetchedDocument | GamingWebSource> {
  const fetchUrl = candidate.fetchUrl;
  const sourceUrl = candidate.url;
  const frontendEvidenceCandidate = candidate.frontendDiscovered === true;
  const preparedResource = prepareGamingResourceUrl(fetchUrl);
  const preliminaryClassification = classifyGamingResource({
    url: fetchUrl,
    requestedGame: input.game,
    prompt: input.prompt
  });
  const shouldInspectUrlPayload = !frontendEvidenceCandidate && (
    fetchUrl.length > GAMING_BUILD_RESOURCE_HARD_LIMITS.maxUrlChars
    || preliminaryClassification.extractionStrategy === "url_payload"
    || isStructuredGamingResourceType(preliminaryClassification.type)
  );
  const contentTermKey = createHash("sha256").update(contentTerms.join("\n")).digest("hex").slice(0, 16);
  const cacheUrlKey = createHash("sha256").update(normalizeCacheUrl(fetchUrl)).digest("hex");
  const payloadCacheKey = preparedResource?.payloadHash.slice(0, 24) ?? "invalid-resource";
  const cacheKey = `${cacheUrlKey}#gaming-rag:${contentTermKey}:payload:${payloadCacheKey}:origin:${frontendEvidenceCandidate ? "frontend" : "standard"}`;
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
        fetchElapsedMs: 0,
        extractionElapsedMs: 0,
        snippetChars: Math.min(cached.text.length, maxDocumentChars),
        extractionStrategy: cached.extraction.strategy,
        selectedContainer: cached.extraction.selectedContainer ?? cached.extraction.strategy,
        extractionQualityScore: cached.extraction.qualityScore ?? null,
        navigationPenalty: cached.extraction.navigationPenalty ?? null,
        linkDensity: cached.extraction.linkDensity ?? null,
        extractionCandidateCount: cached.extraction.candidateCount ?? null,
        rawTextLength: cached.extraction.rawTextLength,
        cleanedTextLength: cached.extraction.cleanedTextLength,
        requestedGame: input.game ?? null,
        ...structuredResultLogFields(cached.structured?.result),
        fetchTimeoutMs
      });
    }
    return {
      candidate: candidateWithFetchedGameCorroboration(
        candidate,
        input,
        cached.corroborationText ?? cached.text,
        cached.extraction,
        cached.fetchedPageDate
      ),
      text: cached.text,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      extraction: cached.extraction,
      ...(cached.structured ? { structured: cached.structured } : {})
    };
  }

  if (logContext) {
    logger.info("gaming.retrieval.source.start", {
      ...logContext,
      ...sourceLogTarget,
      sourceIndex,
      sourceCount,
      cacheHit: false,
      requestedGame: input.game ?? null,
      resourceType: preliminaryClassification.type,
      resourceConfidence: preliminaryClassification.confidence,
      fetchTimeoutMs,
      maxDocumentChars
    });
  }

  let urlStructuredResult: GamingBuildResourceResult | undefined;
  if (shouldInspectUrlPayload) {
    try {
      urlStructuredResult = await ingestGamingBuildResource({
        url: fetchUrl,
        requestedGame: input.game,
        prompt: input.prompt
      });
    } catch {
      urlStructuredResult = undefined;
    }
  }

  if (urlStructuredResult && fetchUrl.length > GAMING_BUILD_RESOURCE_HARD_LIMITS.maxUrlChars) {
    if (logContext) {
      logger.warn("gaming.retrieval.source.end", {
        ...logContext,
        ...sourceLogTarget,
        sourceIndex,
        sourceCount,
        ok: false,
        cacheHit: false,
        elapsedMs: Date.now() - sourceStartedAt,
        requestedGame: input.game ?? null,
        ...structuredResultLogFields(urlStructuredResult),
        fallbackReason: urlStructuredResult.failureReason,
        fetchTimeoutMs
      });
    }
    return {
      url: sourceUrl,
      error: "Structured build resource detected, but the loadout data could not be decoded safely."
    };
  }

  try {
    let extraction: FetchAndCleanExtractionMetrics = {
      strategy: "body",
      rawTextLength: 0,
      cleanedTextLength: 0
    };
    let rawDocument: FetchAndCleanRawDocument | undefined;
    const fetchedArticleText = await runWithLocalTimeout(
      (signal) => fetchAndClean(
        fetchUrl,
        maxDocumentChars,
        buildGamingFetchOptions(fetchUrl, signal, fetchTimeoutMs, contentTerms, (metrics) => {
          extraction = metrics;
        }, (document) => {
          rawDocument = document;
        }, GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars)
      ),
      fetchTimeoutMs,
      requestSignal
    );
    const articleText = frontendEvidenceCandidate
      ? normalizeFrontendEvidenceText(fetchedArticleText)
      : fetchedArticleText;
    if (frontendEvidenceCandidate) {
      extraction = {
        ...extraction,
        ...(extraction.documentTitle
          ? { documentTitle: normalizeFrontendEvidenceText(extraction.documentTitle) }
          : {}),
        ...(extraction.headingText
          ? { headingText: normalizeFrontendEvidenceText(extraction.headingText) }
          : {})
      };
    }
    if (extraction.rawTextLength === 0 && articleText.length > 0) {
      extraction = {
        strategy: "body",
        rawTextLength: articleText.length,
        cleanedTextLength: articleText.length
      };
    }
    let structuredResult: GamingBuildResourceResult | undefined;
    try {
      structuredResult = await ingestGamingBuildResource({
        url: frontendEvidenceCandidate ? neutralizeFrontendStructuredIngestionUrl(fetchUrl) : fetchUrl,
        requestedGame: input.game,
        prompt: input.prompt,
        contentType: rawDocument?.contentType,
        html: rawDocument?.body,
        text: articleText,
        metadata: {
          title: extraction.documentTitle,
          headings: extraction.headingText
        }
      });
    } catch {
      structuredResult = urlStructuredResult;
    }
    const structuredRelevant = Boolean(
      structuredResult
      && (
        structuredResult.build
        || isStructuredGamingResourceType(structuredResult.classification.type)
        || structuredResult.failureReason === "STRUCTURED_PAYLOAD_TOO_LARGE"
        || structuredResult.failureReason === "STRUCTURED_PAYLOAD_DECODE_FAILED"
      )
    );
    const evidenceUsed = Boolean(structuredResult && structuredRelevant && shouldUseStructuredEvidence(structuredResult, articleText));
    const text = evidenceUsed && structuredResult
      ? structuredResult.evidenceText || structuredResult.publicSnippet
      : articleText;
    const effectiveExtraction = evidenceUsed && structuredResult
      ? structuredExtractionMetrics(structuredResult, extraction)
      : extraction;
    const structured = structuredResult && structuredRelevant
      ? { result: structuredResult, evidenceUsed }
      : undefined;
    const fetchedAt = new Date().toISOString();
    const fetchedPageDate = frontendEvidenceCandidate ? extractFetchedPageDate(rawDocument, fetchUrl) : undefined;
    pruneDocumentCache(now);
    documentCache.set(cacheKey, {
      text,
      ...(frontendEvidenceCandidate ? { corroborationText: articleText } : {}),
      fetchedAt,
      ...(fetchedPageDate ? { fetchedPageDate } : {}),
      expiresAt: now + getGamingRagTtlMs(input.mode, patchSensitive),
      extraction: effectiveExtraction,
      ...(structured ? { structured } : {})
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
        fetchElapsedMs: effectiveExtraction.fetchElapsedMs ?? null,
        extractionElapsedMs: effectiveExtraction.extractionElapsedMs ?? null,
        snippetChars: text.length,
        extractionStrategy: effectiveExtraction.strategy,
        selectedContainer: effectiveExtraction.selectedContainer ?? effectiveExtraction.strategy,
        extractionQualityScore: effectiveExtraction.qualityScore ?? null,
        navigationPenalty: effectiveExtraction.navigationPenalty ?? null,
        linkDensity: effectiveExtraction.linkDensity ?? null,
        extractionCandidateCount: effectiveExtraction.candidateCount ?? null,
        rawTextLength: effectiveExtraction.rawTextLength,
        cleanedTextLength: effectiveExtraction.cleanedTextLength,
        requestedGame: input.game ?? null,
        ...structuredResultLogFields(structured?.result),
        fetchTimeoutMs
      });
    }
    return {
      candidate: candidateWithFetchedGameCorroboration(
        candidate,
        input,
        frontendEvidenceCandidate ? articleText : text,
        effectiveExtraction,
        fetchedPageDate
      ),
      text,
      fetchedAt,
      cacheHit: false,
      extraction: effectiveExtraction,
      ...(structured ? { structured } : {})
    };
  } catch (error) {
    if (requestSignal?.aborted) {
      throw requestSignal.reason instanceof Error ? requestSignal.reason : error;
    }
    if (
      urlStructuredResult
      && (
        urlStructuredResult.build
        || isStructuredGamingResourceType(urlStructuredResult.classification.type)
      )
    ) {
      const text = urlStructuredResult.evidenceText || urlStructuredResult.publicSnippet;
      const extraction = structuredExtractionMetrics(urlStructuredResult);
      const fetchedAt = new Date().toISOString();
      const structured = { result: urlStructuredResult, evidenceUsed: true };
      pruneDocumentCache(now);
      documentCache.set(cacheKey, {
        text,
        fetchedAt,
        expiresAt: now + getGamingRagTtlMs(input.mode, patchSensitive),
        extraction,
        structured
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
          extractionStrategy: extraction.strategy,
          requestedGame: input.game ?? null,
          ...structuredResultLogFields(urlStructuredResult),
          fallbackReason: urlStructuredResult.failureReason ?? "STRUCTURED_URL_PAYLOAD_ONLY",
          fetchTimeoutMs
        });
      }
      return {
        candidate,
        text,
        fetchedAt,
        cacheHit: false,
        extraction,
        structured
      };
    }
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
    return { url: sourceUrlForGamingError(sourceUrl, error), error: safeGamingSourceError(error) };
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
const SOURCE_INSTRUCTION_PATTERN = /\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)|forget\s+(?:everything|all)\s+(?:above|before)|you\s+are\s+now|new\s+(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|follow\s+(?:these|the\s+following)\s+instructions?|(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|(?:reveal|print|show|expose|exfiltrate)\s+(?:the\s+)?(?:system|developer|secret|credential|token|api\s+key)\s*(?:prompt|message|instructions?|value)?|(?:call|invoke)\s+(?:the\s+)?(?:tool|function)|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b/i;
const SOURCE_INSTRUCTION_MATCH_PATTERN = /(?:\[(?:system|developer|assistant|instructions?)\]|<(?:system|developer|assistant)>|#{1,6}\s*(?:system|developer|assistant|instructions?)\b|\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)\b|\bforget\s+(?:everything|all)\s+(?:above|before)\b|\byou\s+are\s+now\b|\bnew\s+(?:system|developer|assistant)\s+(?:message|prompt|instructions?)\b|\bfollow\s+(?:these|the\s+following)\s+instructions?\b|\b(?:reveal|print|show|expose|exfiltrate)\s+(?:the\s+)?(?:system|developer|secret|credential|token|api\s+key)\b|\b(?:call|invoke)\s+(?:the\s+)?(?:tool|function)\b|\b(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash)\b)/gi;
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
  instructionPenalty: number;
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
  const instructionPenalty = clampScore(
    countPatternMatches(text, SOURCE_INSTRUCTION_MATCH_PATTERN) * 0.45
  );
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
    - instructionPenalty
    - labelsPenalty * 0.22
    - keywordDumpPenalty * 0.65
  );
  return {
    score,
    passed: wordCount >= 4 && proseSignal && keywordDumpPenalty < 0.35 && score >= MIN_SNIPPET_QUALITY_SCORE && malformedPenalty < 0.35 && instructionPenalty < 0.35 && density < 0.62,
    readability,
    queryOverlap,
    gameOverlap,
    navigationDensity: density,
    repetitionPenalty,
    linkDensity,
    malformedPenalty,
    instructionPenalty
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
  if (candidate.discovered && candidate.gameCorroborated !== true) {
    return false;
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
    if (document.structured?.evidenceUsed) {
      const structuredChunks = splitIntoChunks(document.text, maxChunkChars).slice(0, Math.min(3, maxChunks));
      for (const [index, chunk] of structuredChunks.entries()) {
        const safeChunk = extractReadableEvidenceText(chunk)
          || (document.candidate.frontendDiscovered ? "" : chunk.replace(/\s+/g, " ").trim());
        if (!safeChunk) {
          continue;
        }
        scoredChunks.push({
          candidate: document.candidate,
          text: safeChunk,
          score: scoreCandidate(input, document.candidate, terms, patchSensitive)
            + 2
            + document.structured.result.classification.confidence
            - index * 0.01,
          hash: hashChunk(safeChunk),
          snippetQualityScore: 1,
          navigationPenalty: 0
        });
      }
      continue;
    }
    for (const chunk of splitIntoChunks(document.text, maxChunkChars)) {
      const safeChunk = extractReadableEvidenceText(chunk);
      if (!safeChunk || !isReadableGameplayChunk(safeChunk) || !isRelevantGameplayChunk(safeChunk, document.candidate, terms, input)) {
        continue;
      }

      const haystack = safeChunk.toLowerCase();
      const chunkTokens = new Set(tokenize(safeChunk));
      const gameTerms = tokenize(normalizeGameName(input) ?? "");
      const quality = scoreGamingSnippetQuality(safeChunk, {
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
      const patchScore = patchSensitive && /\b(?:patch|hotfix|version|buff|nerf|balance|adjusted|changed)\b/i.test(safeChunk) ? 0.28 : 0;
      const freshnessScore = patchSensitive
        ? (document.candidate.sourceType === "patch_notes" ? 0.2 : document.candidate.stable ? 0 : 0.07)
          + (/\b(?:updated?|published|latest|current|hotfix|version|\d{4}-\d{2}-\d{2})\b/i.test(safeChunk) ? 0.1 : 0)
        : 0;
      const buildScore = input.mode === "build" && /\b(?:build|stats?|weapon|talent|gear|rotation|loadout|ability|attribute|module)\b/i.test(safeChunk) ? 0.22 : 0;
      const guideScore = input.mode === "guide" && /\b(?:route|walkthrough|first|after|location|boss|quest|progress|objective|exploration|mission|mechanic)\b/i.test(safeChunk) ? 0.18 : 0;
      const navigationPenalty = -(quality.navigationDensity * 1.1 + quality.linkDensity * 0.45 + (NAVIGATION_JUNK_PATTERN.test(safeChunk) ? 0.35 : 0));
      const evidenceDensityScore = Math.min(0.2, quality.queryOverlap * 0.12 + quality.readability * 0.08);
      const snippetQualityScore = quality.score;
      const duplicatePenalty = scoredChunks.some((scored) =>
        scored.candidate.url !== document.candidate.url
        && (scored.hash === hashChunk(safeChunk) || areNearDuplicateChunks(scored.text, safeChunk))
      ) ? 0.45 : 0;
      scoredChunks.push({
        candidate: document.candidate,
        text: safeChunk,
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
        hash: hashChunk(safeChunk),
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
  excludedDocumentUrls: ReadonlySet<string> = new Set(),
  rankCitableSources = false
): GamingWebSource[] {
  const sourcesByUrl = new Map<string, GamingWebSource>();
  const chunkChars = getGamingRagChunkChars();
  for (const document of documents) {
    if (!document.structured?.evidenceUsed) {
      continue;
    }
    const excluded = excludedDocumentUrls.has(document.candidate.url);
    sourcesByUrl.set(document.candidate.url, excluded
      ? document.candidate.frontendDiscovered
        ? {
            url: document.candidate.url,
            error: "Source did not match the requested game or version."
          }
        : {
            url: document.candidate.url,
            snippet: LIMITED_ARTICLE_TEXT_SNIPPET
          }
      : {
        url: document.candidate.url,
        snippet: document.structured.result.publicSnippet.slice(0, MAX_PUBLIC_SNIPPET_CHARS)
      });
  }
  const orderedCitableChunks = rankCitableSources
    ? chunks
    : documents.flatMap((document) => {
      const chunk = chunks.find((candidateChunk) => candidateChunk.candidate.url === document.candidate.url);
      return chunk ? [chunk] : [];
    });
  for (const chunk of orderedCitableChunks) {
    if (sourcesByUrl.has(chunk.candidate.url)) {
      continue;
    }
    const source = sourceFromChunk(chunk);
    if (isCitableGamingWebSource(source)) {
      sourcesByUrl.set(chunk.candidate.url, source);
    }
  }
  for (const document of documents) {
    if (sourcesByUrl.has(document.candidate.url)) {
      continue;
    }
    if (excludedDocumentUrls.has(document.candidate.url)) {
      sourcesByUrl.set(document.candidate.url, document.candidate.frontendDiscovered
        ? {
            url: document.candidate.url,
            error: "Source did not match the requested game or version."
          }
        : {
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

  const allSources = Array.from(sourcesByUrl.values());
  return [
    ...allSources.filter(isCitableGamingWebSource),
    ...allSources.filter((source) => !isCitableGamingWebSource(source))
  ].slice(0, getGamingRagMaxSources());
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
    const freshnessNote = chunk.candidate.discovered && !chunk.candidate.stable
      ? `; Freshness: ${chunk.candidate.updatedAt ?? chunk.candidate.publishedAt ?? "date unavailable; latest status unverified"}`
      : "";
    parts.push(
      "",
      `[Source ${sourceNumber}] ${chunk.candidate.url}`,
      `Title: ${chunk.candidate.title}; Domain: ${domain}; Type: ${chunk.candidate.sourceType}; Trust: ${chunk.candidate.trustScore.toFixed(2)}${freshnessNote}`,
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
  const withoutLinks = text
    .replace(/\s*\[LINKS\][\s\S]*$/i, "")
    .replace(/^\s*(?:\[(?:system|developer|assistant|instructions?|mode|request|output)\]|<(?:system|developer|assistant)>|#{1,6}\s*(?:system|developer|assistant|instructions?)\b).*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
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

function hasExplicitDiscoveryLanguage(prompt: string): boolean {
  return /\b(?:find|look\s+up|search|latest|current|this\s+patch|right\s+now|today)\b/i.test(prompt);
}

function discoveryTriggerReason(params: {
  input: GamingRagInput;
  initialCandidateCount: number;
  suppliedSourceCount: number;
  initialDocumentCount: number;
  patchSensitive: boolean;
}): GamingDiscoveryReason {
  if (params.suppliedSourceCount > 0 && params.initialDocumentCount === 0) {
    return "DISCOVERY_SUPPLIED_SOURCE_FAILED";
  }
  if (params.initialCandidateCount === 0) {
    return "DISCOVERY_NO_SOURCE_CANDIDATES";
  }
  if (params.initialDocumentCount === 0) {
    return "DISCOVERY_CURATED_SOURCE_UNAVAILABLE";
  }
  if (hasExplicitDiscoveryLanguage(params.input.prompt)) {
    return "DISCOVERY_EXPLICIT_CURRENT_LOOKUP";
  }
  if (params.patchSensitive) {
    return "DISCOVERY_PATCH_SENSITIVE";
  }
  return "DISCOVERY_EVIDENCE_BELOW_THRESHOLD";
}

function hasSufficientGamingEvidence(
  chunks: readonly GamingRankedChunk[],
  sources: readonly GamingWebSource[],
  patchSensitive: boolean,
  requestedVersions: readonly string[] = []
): boolean {
  const citableUrls = new Set(sources.filter(isCitableGamingWebSource).map((source) => source.url));
  const minimumQuality = getGamingDiscoveryMinEvidenceQuality();
  const eligibleChunks = chunks.filter((chunk) =>
    citableUrls.has(chunk.candidate.url) && chunk.snippetQualityScore >= minimumQuality
  );
  if (!patchSensitive) {
    return eligibleChunks.length > 0;
  }
  if (requestedVersions.length > 0) {
    return requestedVersions.every((version) =>
      eligibleChunks.some((chunk) => textContainsExactGamingVersion(chunk.text, version))
    );
  }
  return eligibleChunks.some((chunk) => {
    const sourceDate = chunk.candidate.updatedAt ?? chunk.candidate.publishedAt;
    return sourceDate ? isRecentGamingEvidenceDate(sourceDate) : false;
  });
}

function emptyRagContext(params: {
  enabled: boolean;
  reason: string;
  query: string;
  startedAt: number;
  gameDetection: GamingGameDetection;
  sources?: GamingWebSource[];
  rankingStartedAt?: number;
  fallbackReason?: GamingFallbackReason;
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
    currentEvidenceAvailable: false,
    discoveryEnabled: false,
    discoveryTriggered: false,
    discoveryReason: "DISCOVERY_DISABLED",
    searchResultCount: 0,
    candidateCount: 0,
    rejectedCandidateCount: 0,
    fetchedCandidateCount: 0,
    acceptedSourceCount: 0,
    discoveryCacheHit: false,
    discoveryElapsedMs: 0,
    candidateRankingElapsedMs: 0,
    ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {}),
    clear
  };
}

export function clearGamingRagCache(): void {
  documentCache.clear();
  clearGamingBuildResourceCache();
  clearGamingDiscoveryCache();
}

export async function buildGamingRagContext(
  input: GamingRagInput,
  logContext?: GamingWebContextLogContext,
  requestSignal?: AbortSignal
): Promise<GamingRagContext> {
  const retrievalStartedAt = Date.now();
  const requestedGuideUrls = collectGamingGuideUrls(input)
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0);
  const suppliedSourceCount = requestedGuideUrls.length;
  const rejectedFrontendSources = input.evidenceOrigin === "frontend_web_search"
    ? Array.from(new Map(requestedGuideUrls.flatMap((url) => {
        const sanitized = sanitizeGamingDiscoveryCandidateUrl(url);
        if (!sanitized.rejected && sanitized.url) {
          return [];
        }
        let publicUrl = "invalid-source";
        try {
          const originalUrl = new URL(url);
          const sanitizedPublicUrl = sanitizeFrontendPublicSourceUrl(url);
          const validatedPublicUrl = sanitizeGamingDiscoveryCandidateUrl(sanitizedPublicUrl);
          if (
            !originalUrl.username
            && !originalUrl.password
            && !originalUrl.port
            && !validatedPublicUrl.rejected
            && validatedPublicUrl.url
          ) {
            publicUrl = validatedPublicUrl.url;
          }
        } catch {
          // Keep the fixed public sentinel for malformed or non-public candidates.
        }
        return [[publicUrl, {
          url: publicUrl,
          error: "Source URL was rejected by evidence policy."
        }] as const];
      })).values())
    : [];
  const validSuppliedSourceCount = input.evidenceOrigin === "frontend_web_search"
    ? requestedGuideUrls.filter((url) => {
        const sanitized = sanitizeGamingDiscoveryCandidateUrl(url);
        return !sanitized.rejected && Boolean(sanitized.url);
      }).length
    : requestedGuideUrls.filter(isFetchableGuideUrl).length;
  const initialGameDetection = detectGameFromRagInput(input);
  const game = initialGameDetection.game;
  const terms = extractTopicTerms(input, game);
  const patchSensitive = isGamingFreshnessSensitive(input);
  const requestedVersions = Array.from(new Set([
    ...(input.requestedVersion ? [input.requestedVersion] : []),
    ...extractExplicitGamingVersions({ prompt: input.prompt, game })
  ]));
  const retrievalQuery = buildRetrievalQuery(input, game, terms);
  const retrievalEnabled = getGamingRagEnabled();
  const discoveryEnabled = retrievalEnabled && getGamingDiscoveryEnabled();
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
  const availableCandidates = buildSourceCandidates(input, game);
  const suppliedCandidates = selectCandidates(
    input,
    availableCandidates.filter((candidate) => candidate.supplied),
    terms,
    patchSensitive
  );
  const curatedCandidates = selectCandidates(
    input,
    availableCandidates.filter((candidate) => !candidate.supplied),
    terms,
    patchSensitive
  );
  const potentialCandidates = [...suppliedCandidates, ...curatedCandidates];
  let candidates = [...suppliedCandidates];

  if (logContext) {
    logger.info("gaming.retrieval.start", {
      ...logContext,
      ...(game ? { game, detectedGame: game } : {}),
      gameDetectionConfidence: initialGameDetection.confidence,
      gameDetectionSource: initialGameDetection.source,
      retrievalEnabled,
      discoveryEnabled,
      discoveryTriggered: false,
      discoveryReason: discoveryEnabled ? "DISCOVERY_PENDING_EVIDENCE" : "DISCOVERY_DISABLED",
      retrievalReason,
      retrievalQueryTermCount: terms.length,
      requestedSourceCount: suppliedSourceCount,
      sourceCount: potentialCandidates.length,
      suppliedCandidateCount: suppliedCandidates.length,
      curatedCandidateCount: curatedCandidates.length,
      sourceDomains: Array.from(new Set(potentialCandidates.map((candidate) => normalizeDomain(candidate.url)).filter(Boolean))),
      cacheHit: false,
      maxSources,
      maxChunks,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  const fetchCandidateBatch = (batch: GamingSourceCandidate[]): Promise<Array<GamingFetchedDocument | GamingWebSource>> => Promise.all(
    batch.map((candidate, index) =>
      fetchGamingRagDocument(
        candidate,
        input,
        patchSensitive,
        Array.from(new Set([...terms, ...MODE_CONTENT_TERMS[input.mode]])),
        maxContextChars,
        fetchTimeoutMs,
        logContext,
        index + 1,
        batch.length,
        requestSignal
      )
    )
  );

  const suppliedFetchResults = await fetchCandidateBatch(suppliedCandidates);
  let documents = suppliedFetchResults.filter((result): result is GamingFetchedDocument => "text" in result);
  let errorSources = [
    ...rejectedFrontendSources,
    ...suppliedFetchResults.filter((result): result is GamingWebSource => !("text" in result))
  ];
  if (suppliedSourceCount > 0 && validSuppliedSourceCount === 0 && rejectedFrontendSources.length === 0) {
    errorSources = [...errorSources, { url: "invalid-source", error: "Malformed or unsupported source URL." }];
  }

  const suppliedConflictingDocumentUrls = collectConflictingDocumentUrls(documents, initialGameDetection.game);
  const suppliedRankableDocuments = documents.filter((document) =>
    !suppliedConflictingDocumentUrls.has(document.candidate.url)
  );
  const suppliedChunks = rankChunks(suppliedRankableDocuments, terms, input, patchSensitive);
  const suppliedSources = buildPublicSourcesFromChunks(
    suppliedChunks,
    documents,
    terms,
    input,
    suppliedConflictingDocumentUrls
  );
  const suppliedEvidenceSufficient = hasSufficientGamingEvidence(
    suppliedChunks,
    suppliedSources,
    patchSensitive,
    requestedVersions
  );
  if (!suppliedEvidenceSufficient && curatedCandidates.length > 0) {
    const curatedFetchResults = await fetchCandidateBatch(curatedCandidates);
    candidates = [...candidates, ...curatedCandidates];
    documents = [
      ...documents,
      ...curatedFetchResults.filter((result): result is GamingFetchedDocument => "text" in result)
    ];
    errorSources = [
      ...errorSources,
      ...curatedFetchResults.filter((result): result is GamingWebSource => !("text" in result))
    ];
  }

  const initialConflictingDocumentUrls = collectConflictingDocumentUrls(documents, initialGameDetection.game);
  const initialRankableDocuments = documents.filter((document) => !initialConflictingDocumentUrls.has(document.candidate.url));
  const initialChunks = rankChunks(initialRankableDocuments, terms, input, patchSensitive);
  const initialSources = buildPublicSourcesFromChunks(
    initialChunks,
    documents,
    terms,
    input,
    initialConflictingDocumentUrls
  );
  const initialEvidenceSufficient = hasSufficientGamingEvidence(
    initialChunks,
    initialSources,
    patchSensitive,
    requestedVersions
  );

  let discoveryTriggered = false;
  let discoveryReason: GamingDiscoveryReason = discoveryEnabled ? "DISCOVERY_NOT_NEEDED" : "DISCOVERY_DISABLED";
  let searchProvider: string | undefined;
  let searchQueryHash: string | undefined;
  let searchResultCount = 0;
  let candidateCount = 0;
  let rejectedCandidateCount = 0;
  let fetchedCandidateCount = 0;
  let discoveryCacheHit = false;
  let discoveryElapsedMs = 0;
  let candidateRankingElapsedMs = 0;
  let discoveryFailureReason: GamingDiscoveryFailureReason | undefined;
  const discoveredCandidateUrls = new Set<string>();

  if (discoveryEnabled && !game) {
    discoveryReason = "DISCOVERY_MISSING_GAME";
  } else if (discoveryEnabled && !initialEvidenceSufficient && game) {
    discoveryTriggered = true;
    discoveryReason = discoveryTriggerReason({
      input,
      initialCandidateCount: candidates.length,
      suppliedSourceCount,
      initialDocumentCount: documents.length,
      patchSensitive
    });
    const discoveryStartedAt = Date.now();
    if (logContext) {
      logger.info("gaming.discovery.start", {
        ...logContext,
        game,
        detectedGame: game,
        gameDetectionConfidence: initialGameDetection.confidence,
        discoveryEnabled,
        discoveryTriggered,
        discoveryReason
      });
    }
    const discoveryResult = await discoverGamingSources({
      prompt: input.prompt,
      game,
      mode: input.mode,
      patchSensitive,
      ...(requestSignal ? { signal: requestSignal } : {})
    });
    searchProvider = discoveryResult.searchProvider;
    searchQueryHash = discoveryResult.searchQueryHash;
    searchResultCount = discoveryResult.searchResultCount;
    candidateCount = discoveryResult.candidateCount;
    rejectedCandidateCount = discoveryResult.rejectedCandidateCount;
    discoveryCacheHit = discoveryResult.discoveryCacheHit;
    candidateRankingElapsedMs = discoveryResult.candidateRankingElapsedMs;
    discoveryFailureReason = discoveryResult.discoveryFailureReason;

    const existingCandidateUrls = new Set(candidates.map((candidate) => candidate.url.toLowerCase()));
    const discoveredCandidatesBeforeDedupe = discoveryResult.candidates.map((result) =>
      makeDiscoveredSourceCandidate(result, input)
    );
    const discoveryCandidates = discoveredCandidatesBeforeDedupe.filter((candidate) =>
      !existingCandidateUrls.has(candidate.url.toLowerCase())
    );
    rejectedCandidateCount += discoveredCandidatesBeforeDedupe.length - discoveryCandidates.length;
    for (const candidate of discoveryCandidates) {
      discoveredCandidateUrls.add(candidate.url);
    }
    const remainingDiscoveryBudgetMs = getGamingDiscoveryBudgetMs() - (Date.now() - discoveryStartedAt);
    if (discoveryCandidates.length > 0 && remainingDiscoveryBudgetMs > 0) {
      fetchedCandidateCount = discoveryCandidates.length;
      const discoveryFetchTimeoutMs = Math.max(1, Math.min(fetchTimeoutMs, remainingDiscoveryBudgetMs));
      const discoveredFetchResults = await Promise.all(
        discoveryCandidates.map((candidate, index) =>
          fetchGamingRagDocument(
            candidate,
            input,
            patchSensitive,
            Array.from(new Set([...terms, ...MODE_CONTENT_TERMS[input.mode]])),
            maxContextChars,
            discoveryFetchTimeoutMs,
            logContext,
            index + 1,
            discoveryCandidates.length,
            requestSignal
          )
        )
      );
      documents = [
        ...documents,
        ...discoveredFetchResults.filter((result): result is GamingFetchedDocument => "text" in result)
      ];
      errorSources = [
        ...errorSources,
        ...discoveredFetchResults.filter((result): result is GamingWebSource => !("text" in result))
      ];
      if (!discoveredFetchResults.some((result) => "text" in result)) {
        discoveryFailureReason = "DISCOVERY_FETCH_FAILED";
      }
    } else if (discoveryCandidates.length > 0) {
      discoveryFailureReason = "DISCOVERY_BUDGET_EXHAUSTED";
    }
    discoveryElapsedMs = Date.now() - discoveryStartedAt;
    if (logContext) {
      logger.info("gaming.discovery.end", {
        ...logContext,
        game,
        detectedGame: game,
        gameDetectionConfidence: initialGameDetection.confidence,
        discoveryEnabled,
        discoveryTriggered,
        discoveryReason,
        ...(searchProvider ? { searchProvider } : {}),
        ...(searchQueryHash ? { searchQueryHash } : {}),
        searchResultCount,
        candidateCount,
        rejectedCandidateCount,
        fetchedCandidateCount,
        discoveryCacheHit,
        discoveryElapsedMs,
        candidateRankingElapsedMs,
        ...(discoveryFailureReason ? { discoveryFailureReason } : {})
      });
    }
  }

  const timedOut = errorSources.some((source) => source.error?.toLowerCase().includes("timed out"));
  const effectiveGameDetection = detectGameFromFetchedDocuments(initialGameDetection, documents);
  const conflictingDocumentUrls = collectConflictingDocumentUrls(documents, initialGameDetection.game);
  const rankableDocuments = documents.filter((document) => !conflictingDocumentUrls.has(document.candidate.url));
  const effectiveInput: GamingRagInput = effectiveGameDetection.game
    ? { ...input, game: effectiveGameDetection.game }
    : input;
  const effectiveTerms = extractTopicTerms(effectiveInput, effectiveGameDetection.game);
  const effectiveRetrievalQuery = buildRetrievalQuery(effectiveInput, effectiveGameDetection.game, effectiveTerms);
  const rankingStartedAt = Date.now();
  const chunks = rankChunks(rankableDocuments, effectiveTerms, effectiveInput, patchSensitive);
  const rankedSources = buildPublicSourcesFromChunks(
    chunks,
    documents,
    effectiveTerms,
    effectiveInput,
    conflictingDocumentUrls,
    discoveryTriggered
  );
  const publicSourceLimit = Math.min(getGamingRagMaxSources(), MAX_PUBLIC_GAMING_SOURCES);
  const publicErrorSources = errorSources
    .filter((source) => !discoveredCandidateUrls.has(source.url))
    .filter((errorSource) =>
      !rankedSources.some((source) => source.url === errorSource.url)
    );
  const reservedErrorSourceCount = publicErrorSources.length > 0
    ? Math.min(publicErrorSources.length, publicSourceLimit, rankedSources.length > 0 ? 1 : publicSourceLimit)
    : 0;
  const retainedSources = rankedSources.slice(0, Math.max(0, publicSourceLimit - reservedErrorSourceCount));
  const returnedSources = [
    ...retainedSources,
    ...publicErrorSources.slice(0, reservedErrorSourceCount)
  ];
  const context = buildRagContext(chunks, retainedSources, effectiveRetrievalQuery, maxContextChars);
  const rankingElapsedMs = Date.now() - rankingStartedAt;
  const sourceDomains = sourceDomainsFromSources(returnedSources);
  const cacheHit = documents.some((document) => document.cacheHit);
  const fallbackReason = documents.length === 0 && timedOut ? "INTAKE_RETRIEVAL_TIMEOUT" : undefined;
  const retrievedSourceCount = documents.length;
  const acceptedSourceCount = retainedSources.filter((source) =>
    discoveredCandidateUrls.has(source.url) && isCitableGamingWebSource(source)
  ).length;
  if (discoveryTriggered && fetchedCandidateCount > 0 && acceptedSourceCount === 0 && !discoveryFailureReason) {
    discoveryFailureReason = "DISCOVERY_LOW_QUALITY";
  }
  const returnedPublicSourceCount = returnedSources.length;
  const omittedSourceCount = Math.max(0, chunks.length - retainedSources.length);
  const currentEvidenceAvailable = hasSufficientGamingEvidence(
    chunks,
    retainedSources,
    true,
    requestedVersions
  );
  const clear = buildClearChecks({
    retrievalEnabled,
    sourceCount: retainedSources.length,
    context,
    fallbackReason
  });

  if (logContext) {
    for (const document of documents) {
      const selectedChunk = chunks.find((chunk) => chunk.candidate.url === document.candidate.url);
      const publicSource = retainedSources.find((source) => source.url === document.candidate.url);
      logger.info("gaming.retrieval.source.selection", {
        ...logContext,
        ...(effectiveGameDetection.game ? { game: effectiveGameDetection.game, detectedGame: effectiveGameDetection.game } : {}),
        gameDetectionConfidence: effectiveGameDetection.confidence,
        gameDetectionSource: effectiveGameDetection.source,
        requestedGame: input.game ?? null,
        discoveredSource: document.candidate.discovered === true,
        ...(document.candidate.searchProvider ? { searchProvider: document.candidate.searchProvider } : {}),
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
        structuredEvidenceUsed: document.structured?.evidenceUsed ?? false,
        ...structuredResultLogFields(document.structured?.result),
        fetchElapsedMs: document.extraction.fetchElapsedMs ?? null,
        extractionElapsedMs: document.extraction.extractionElapsedMs ?? null,
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
      discoveryEnabled,
      discoveryTriggered,
      discoveryReason,
      ...(searchProvider ? { searchProvider } : {}),
      ...(searchQueryHash ? { searchQueryHash } : {}),
      searchResultCount,
      candidateCount,
      rejectedCandidateCount,
      fetchedCandidateCount,
      acceptedSourceCount,
      discoveryCacheHit,
      discoveryElapsedMs,
      candidateRankingElapsedMs,
      ...(discoveryFailureReason ? { discoveryFailureReason } : {}),
      retrievalQueryTermCount: effectiveTerms.length,
      sourceCount: returnedSources.length,
      retrievedSourceCount,
      publicSourceCount: returnedPublicSourceCount,
      omittedSourceCount,
      sourceDomains,
      cacheHit,
      retrievalElapsedMs: Date.now() - retrievalStartedAt,
      rankingElapsedMs,
      usableSourceCount: retainedSources.filter(isCitableGamingWebSource).length,
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
    sources: returnedSources,
    retrievedSourceCount,
    publicSourceCount: returnedPublicSourceCount,
    omittedSourceCount: retainedSources.length > 0 ? omittedSourceCount : 0,
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
    currentEvidenceAvailable,
    discoveryEnabled,
    discoveryTriggered,
    discoveryReason,
    ...(searchProvider ? { searchProvider } : {}),
    ...(searchQueryHash ? { searchQueryHash } : {}),
    searchResultCount,
    candidateCount,
    rejectedCandidateCount,
    fetchedCandidateCount,
    acceptedSourceCount,
    discoveryCacheHit,
    discoveryElapsedMs,
    candidateRankingElapsedMs,
    ...(discoveryFailureReason ? { discoveryFailureReason } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    clear
  };
}
