import * as webFetcher from "@shared/webFetcher.js";
import {
  type FetchAndCleanExtractionMetrics,
  type FetchAndCleanOptions,
  type FetchAndCleanRawDocument
} from "@shared/webFetcher.js";
import {
  GAMING_BUILD_RESOURCE_HARD_LIMITS,
  prepareGamingResourceUrl
} from "@services/gamingBuildResources.js";
import {
  GAMING_ARCHIVE_RESOLVER_VERSION,
  recognizeGamingArchiveItem,
  resolveGamingArchiveResource,
  type GamingArchiveResolutionTelemetry
} from "@services/gamingArchiveResources.js";
import { filterGamingDocumentInstructions, gamingDocumentFetchOptions } from "@services/gamingDocumentExtraction.js";

export const GAMING_DOCUMENT_RESOLVER_VERSION = "gaming-document-v1";
export const GAMING_DOCUMENT_LIMITS = Object.freeze({ textChars: 100_000, timeoutMs: 30_000 });

/** Internal acquired document. URL fields are public-safe; transport URLs never leave the resolver. */
export interface ResolvedGamingDocument {
  requestedUrl: string;
  canonicalUrl: string;
  publicUrl: string;
  host: string;
  text: string;
  contentType?: string;
  rawDocument?: FetchAndCleanRawDocument;
  metadata: { title?: string; headings?: string };
  extraction: FetchAndCleanExtractionMetrics;
  resolution: {
    resolverId: string;
    resolverVersion: string;
    strategy: string;
    documentType: "html" | "text" | "json" | "unknown";
    supportsStructuredExtraction: boolean;
  };
  metrics: {
    rawTextLength: number;
    cleanedTextLength: number;
    truncated: boolean;
    instructionFiltered: boolean;
  };
  archiveResolution?: GamingArchiveResolutionTelemetry;
}

interface GamingDocumentResolver {
  id: string;
  version: string;
  canHandle: (url: URL) => boolean;
  supportsUrlPayload: boolean;
  publicUrl: (url: string) => string | undefined;
  acquire: (url: string, maxChars: number, options: FetchAndCleanOptions) => Promise<{
    text: string;
    strategy?: string;
    archiveResolution?: GamingArchiveResolutionTelemetry;
    supportsStructuredExtraction: boolean;
  } | null>;
}

// Ordered and bounded. Future source types add one adapter; every caller uses the same acquisition entry.
const DOCUMENT_RESOLVERS: readonly GamingDocumentResolver[] = [
  {
    id: "archive-org",
    supportsUrlPayload: false,
    version: GAMING_ARCHIVE_RESOLVER_VERSION,
    canHandle: (url) => ["archive.org", "www.archive.org"].includes(url.hostname.toLowerCase()),
    publicUrl: (url) => {
      const identifier = recognizeGamingArchiveItem(url);
      return identifier ? `https://archive.org/details/${identifier}` : undefined;
    },
    acquire: async (url, maxChars, options) => {
      const archive = await resolveGamingArchiveResource(url, maxChars, options);
      return archive ? {
        text: archive.text,
        strategy: archive.resolution.archiveSelectionReason,
        archiveResolution: archive.resolution,
        supportsStructuredExtraction: false
      } : null;
    }
  },
  {
    id: "generic-web",
    supportsUrlPayload: true,
    version: GAMING_DOCUMENT_RESOLVER_VERSION,
    canHandle: () => true,
    publicUrl: () => undefined,
    acquire: async (url, maxChars, options) => ({
      text: await webFetcher.fetchAndClean(url, maxChars, options),
      supportsStructuredExtraction: true
    })
  }
];

/** Safe identity and resolver policy for caller-owned deduplication/caches, without fetching. */
export function describeGamingDocumentSource(url: string): {
  publicUrl: string;
  resolverId: string;
  resolverVersion: string;
  supportsUrlPayload: boolean;
} {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP/HTTPS URLs are supported");
  // prepareGamingResourceUrl intentionally redacts credentials; acquisition must reject them before that step.
  if (parsed.username || parsed.password) throw new Error("Source URL credentials are not supported");
  const prepared = prepareGamingResourceUrl(url);
  if (!prepared) throw new Error("Invalid source URL");
  const resolver = DOCUMENT_RESOLVERS.find((entry) => entry.canHandle(parsed))!;
  return {
    publicUrl: resolver.publicUrl(url) ?? prepared.canonicalPublicUrl,
    resolverId: resolver.id,
    resolverVersion: resolver.version,
    supportsUrlPayload: resolver.supportsUrlPayload
  };
}

/** Resolve once before live ranking or durable normalization; retain the pinned fetcher's security controls. */
export async function resolveGamingDocument(
  url: string,
  maxDocumentChars: number = GAMING_DOCUMENT_LIMITS.textChars,
  options: FetchAndCleanOptions = {}
): Promise<ResolvedGamingDocument> {
  const description = describeGamingDocumentSource(url);
  const parsed = new URL(url);
  const maxChars = Math.min(GAMING_DOCUMENT_LIMITS.textChars, Math.max(0,
    Number.isFinite(maxDocumentChars) ? Math.trunc(maxDocumentChars) : GAMING_DOCUMENT_LIMITS.textChars));
  const timeoutMs = Math.min(GAMING_DOCUMENT_LIMITS.timeoutMs, Math.max(1,
    Number.isFinite(options.timeoutMs) ? Math.trunc(options.timeoutMs!) : webFetcher.getConfiguredFetchTimeoutMs()));
  const deadlineAt = Math.min(
    Number.isFinite(options.deadlineAt) ? options.deadlineAt! : Number.POSITIVE_INFINITY,
    Date.now() + timeoutMs
  );
  let extraction: FetchAndCleanExtractionMetrics | undefined;
  let rawDocument: FetchAndCleanRawDocument | undefined;
  const fetchOptions = gamingDocumentFetchOptions(url, {
    ...options,
    timeoutMs,
    deadlineAt,
    retainFullSelectedText: true,
    rawDocumentMaxChars: Math.min(options.rawDocumentMaxChars ?? GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars,
      GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars),
    onExtraction: (metrics) => { extraction = metrics; },
    onRawDocument: (document) => { rawDocument = document; }
  });
  for (const resolver of DOCUMENT_RESOLVERS) {
    if (!resolver.canHandle(parsed)) continue;
    const acquired = await resolver.acquire(url, maxChars, fetchOptions);
    if (!acquired) continue;
    const boundedText = acquired.text.slice(0, maxChars);
    const filteredText = filterGamingDocumentInstructions(boundedText);
    const text = filteredText.slice(0, maxChars);
    const effectiveExtraction: FetchAndCleanExtractionMetrics = extraction ?? {
      strategy: "body", rawTextLength: acquired.text.length, cleanedTextLength: acquired.text.length
    };
    const contentType = rawDocument?.contentType;
    // Raw HTML capture may be shorter than its extracted prose. Only selected prose bounds indicate partial document text.
    const truncated = effectiveExtraction.cleanedTextLength > boundedText.length
      || acquired.text.length > maxChars || filteredText.length > maxChars;
    const boundedRaw = rawDocument ? {
      ...rawDocument,
      body: rawDocument.body.slice(0, GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars),
      truncated: rawDocument.truncated || rawDocument.body.length > GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars
    } : undefined;
    const safeMetadata = {
      ...(effectiveExtraction.documentTitle ? { title: filterGamingDocumentInstructions(effectiveExtraction.documentTitle).slice(0, 240) } : {}),
      ...(effectiveExtraction.headingText ? { headings: filterGamingDocumentInstructions(effectiveExtraction.headingText).slice(0, 240) } : {})
    };
    options.onExtraction?.(effectiveExtraction);
    if (boundedRaw) options.onRawDocument?.(boundedRaw);
    const publicUrl = resolver.publicUrl(url) ?? description.publicUrl;
    return {
      requestedUrl: prepareGamingResourceUrl(url)!.publicUrl,
      canonicalUrl: publicUrl,
      publicUrl,
      host: new URL(publicUrl).hostname,
      text,
      ...(contentType ? { contentType } : {}),
      ...(boundedRaw ? { rawDocument: boundedRaw } : {}),
      metadata: safeMetadata,
      extraction: effectiveExtraction,
      resolution: {
        resolverId: resolver.id,
        resolverVersion: resolver.version,
        strategy: acquired.strategy ?? effectiveExtraction.strategy,
        documentType: contentType === "text/plain" ? "text" : contentType === "application/json" ? "json"
          : ["text/html", "application/xhtml+xml"].includes(contentType ?? "") ? "html" : "unknown",
        supportsStructuredExtraction: acquired.supportsStructuredExtraction
      },
      metrics: {
        rawTextLength: effectiveExtraction.rawTextLength,
        cleanedTextLength: text.length,
        truncated,
        instructionFiltered: filteredText.length < boundedText.normalize("NFKC").replace(/\s+/g, " ").trim().length
      },
      ...(acquired.archiveResolution ? { archiveResolution: acquired.archiveResolution } : {})
    };
  }
  throw new Error("Source document could not be resolved");
}
