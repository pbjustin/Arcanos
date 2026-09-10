import { createHash } from "node:crypto";
import * as webFetcher from "@shared/webFetcher.js";
import {
  type FetchAndCleanExtractionMetrics,
  type FetchAndCleanOptions,
  type FetchAndCleanRawDocument
} from "@shared/webFetcher.js";
import {
  GAMING_BUILD_RESOURCE_HARD_LIMITS,
  classifyGamingResource,
  prepareGamingResourceUrl
} from "@services/gamingBuildResources.js";
import {
  GAMING_ARCHIVE_RESOLVER_VERSION,
  recognizeGamingArchiveItem,
  resolveGamingArchiveResource,
  type GamingArchiveResolutionTelemetry
} from "@services/gamingArchiveResources.js";
import { filterGamingDocumentInstructions, gamingDocumentFetchOptions } from "@services/gamingDocumentExtraction.js";
import { projectGamingDocumentText } from "@shared/gaming/gamingDocumentProjectionCore.js";
import { sanitizeGamingDiscoveryCandidateUrl, sanitizeGamingStructuredDocumentUrl } from "@services/gamingSourceDiscovery.js";

export const GAMING_DOCUMENT_RESOLVER_VERSION = "gaming-document-v1";
export const GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION = "gaming-https-acquisition-v1";
const MAX_REDIRECT_TRANSITIONS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface GamingDocumentAcquisition {
  policyVersion: typeof GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION;
  requestedUrl: string;
  finalUrl: string;
  redirectCount: number;
  transitions: readonly {
    fromUrl: string;
    toUrl: string;
    classification: "same_origin" | "reviewed_publisher_pair";
    ruleId: string;
  }[];
  contentType: string;
  coverage: { selectedTextChars: number; returnedTextChars: number; truncated: boolean; instructionFiltered: boolean };
}

/** Finite diagnostics contain no rejected URL, Location, transport address, or client configuration. */
export class GamingDocumentAcquisitionError extends Error {
  readonly acquisition: {
    stage: "admission" | "redirect" | "transport" | "extraction";
    subreason: string;
    ruleId: string;
    policyVersion: typeof GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION;
    redirectCount: number;
    failingHop: number;
    statusCategory?: "3xx" | "4xx" | "5xx";
  };
  constructor(readonly code: "URL_BLOCKED" | "REDIRECT_NOT_ALLOWED" | "SOURCE_FETCH_FAILED" | "SOURCE_TIMEOUT" | "SOURCE_INACCESSIBLE",
    stage: "admission" | "redirect" | "transport" | "extraction", subreason: string, redirectCount = 0, readonly status?: number,
    ruleId = `gaming.acquisition.${subreason.toLowerCase()}`) {
    super("The source could not be acquired under the public document policy.");
    this.name = "GamingDocumentAcquisitionError";
    this.acquisition = { stage, subreason, ruleId, policyVersion: GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION,
      redirectCount, failingHop: redirectCount, ...(status && status >= 300 && status < 600
        ? { statusCategory: `${Math.floor(status / 100)}xx` as "3xx" | "4xx" | "5xx" } : {}) };
  }
}

const acquisitionAttestations = new WeakMap<GamingDocumentAcquisition, string>();
const documentBinding = (document: ResolvedGamingDocument): string => createHash("sha256")
  .update(JSON.stringify({ requestedUrl: document.requestedUrl, canonicalUrl: document.canonicalUrl,
    publicUrl: document.publicUrl, host: document.host, text: document.text, metadata: document.metadata,
    contentType: document.contentType, resolution: document.resolution, metrics: document.metrics,
    acquisition: document.acquisition }), "utf8").digest("hex");

/** Preserve article selectors; only structured URL payloads need a separate citation projection. */
export function projectGamingDocumentPublicUrl(url: string): string {
  if (classifyGamingResource({ url }).extractionStrategy !== "url_payload") return url;
  const prepared = prepareGamingResourceUrl(url);
  if (!prepared) throw new GamingDocumentAcquisitionError("URL_BLOCKED", "extraction", "INVALID_PUBLIC_IDENTITY");
  return prepared.publicUrl;
}

/** Only this resolver can attest a changed identity; plain records cannot grant redirect permission. */
export function isResolvedGamingDocumentIdentityVerified(document: ResolvedGamingDocument, requestedUrl: string): boolean {
  try {
    const description = describeGamingDocumentSource(requestedUrl);
    if (document.acquisition) return document.acquisition.requestedUrl === description.publicUrl
      && document.requestedUrl === description.publicUrl && document.canonicalUrl === document.acquisition.finalUrl
      && document.publicUrl === projectGamingDocumentPublicUrl(document.canonicalUrl)
      && acquisitionAttestations.get(document.acquisition) === documentBinding(document);
    // Specialized Archive and the unchanged legacy HTTP transport have their own deny-redirect policy.
    const legacyIdentity = new URL(requestedUrl).protocol === "http:"
      || (description.resolverId === "archive-org" && document.resolution.resolverId === "archive-org");
    return legacyIdentity && document.requestedUrl === description.publicUrl && document.publicUrl === description.publicUrl
      && document.canonicalUrl === description.publicUrl && document.host === new URL(description.publicUrl).hostname;
  } catch { return false; }
}
export const GAMING_DOCUMENT_LIMITS = Object.freeze({ textChars: 100_000, timeoutMs: 30_000 });
// Matches the existing revision ceiling and stays within the unchanged 1.5 MB default fetch budget for ASCII prose.
export const GAMING_DURABLE_DOCUMENT_MAX_CHARS = 1_000_000;
export interface GamingDocumentResolutionOptions extends FetchAndCleanOptions {
  documentPurpose?: 'durable';
}

/** Internal acquired document. Requested/canonical URLs retain private payload identity; only publicUrl is a citation. */
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
  acquisition?: GamingDocumentAcquisition;
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
    finalUrl?: string;
    transitions?: GamingDocumentAcquisition["transitions"];
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
    acquire: acquireGenericGamingDocument
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
  if (resolver.id === "archive-org" && recognizeGamingArchiveItem(url)) {
    const admission = sanitizeGamingDiscoveryCandidateUrl(url);
    // Archive's reviewed metadata/derivative resolver can turn an item PDF view into public OCR.
    // That content-type exception cannot erase credentials or bypass other admission categories.
    if (admission.rejected && admission.rejection?.subreason !== "unsupported_document_type") {
      throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", admission.rejection?.subreason ?? "URL_REJECTED");
    }
  }
  return {
    publicUrl: resolver.publicUrl(url) ?? describeGenericGamingUrl(url),
    resolverId: resolver.id,
    resolverVersion: resolver.version,
    supportsUrlPayload: resolver.supportsUrlPayload
  };
}

function describeGenericGamingUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") {
    // Legacy local-development fixtures retain the existing server-owned transport opt-in.
    // No redirect session is reachable here, and redaction must not change the requested resource.
    if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
      const prepared = prepareGamingResourceUrl(rawUrl);
      if (parsed.hash) throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", "UNSAFE_LEGACY_LOCAL_URL");
      parsed.hash = "";
      if (/[\u0000-\u0020\u007f-\u009f\\]/u.test(rawUrl) || !prepared || prepared.publicUrl !== parsed.toString()) {
        throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", "UNSAFE_LEGACY_LOCAL_URL");
      }
      return parsed.toString();
    }
    const admission = sanitizeGamingDiscoveryCandidateUrl(rawUrl);
    if (admission.url && !admission.rejected) return admission.url;
    throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", admission.rejection?.subreason ?? "URL_REJECTED");
  }
  return admitGenericGamingUrl(rawUrl, 0, true);
}

function admitGenericGamingUrl(rawUrl: string, redirectCount = 0, initialDocument = false): string {
  // This allowance belongs to existing internal structured acquisition only. Public candidates
  // have already passed their stricter admission, and every redirect destination keeps that bound.
  const structuredInitial = initialDocument && classifyGamingResource({ url: rawUrl }).extractionStrategy === "url_payload";
  const admission = structuredInitial ? sanitizeGamingStructuredDocumentUrl(rawUrl) : sanitizeGamingDiscoveryCandidateUrl(rawUrl);
  if (!admission.url || admission.rejected) throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission",
    admission.rejection?.subreason ?? "URL_REJECTED", redirectCount, undefined, admission.rejection?.ruleId);
  if (new URL(admission.url).protocol !== "https:") throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission",
    "HTTPS_REQUIRED", redirectCount);
  return admission.url;
}

function redirectTransition(from: URL, to: URL): Pick<GamingDocumentAcquisition["transitions"][number], "classification" | "ruleId"> | undefined {
  if (from.origin === to.origin) return { classification: "same_origin", ruleId: "gaming.redirect.same_origin" };
  // These exact host/path pairs already have independently reviewed publisher entries in
  // REVIEWED_GAMING_SOURCE_RULES. A shared suffix or an arbitrary publisher subdomain grants nothing.
  const pairs = [
    { id: "wow-specialist-apex-www", hosts: ["icy-veins.com", "www.icy-veins.com"], path: (value: string) => value.startsWith("/wow/") },
    { id: "swtor-patch-apex-www", hosts: ["swtor.com", "www.swtor.com"], path: (value: string) => value === "/patchnotes" || value.startsWith("/patchnotes/") }
  ];
  const rule = pairs.find(candidate => candidate.hosts.includes(from.hostname) && candidate.hosts.includes(to.hostname)
    && candidate.path(from.pathname) && candidate.path(to.pathname));
  return rule ? { classification: "reviewed_publisher_pair", ruleId: `gaming.redirect.${rule.id}` } : undefined;
}

async function acquireGenericGamingDocument(url: string, maxChars: number, options: FetchAndCleanOptions) {
  if (new URL(url).protocol === "http:") {
    const legacyUrl = describeGenericGamingUrl(url);
    return { text: await webFetcher.fetchAndClean(legacyUrl, maxChars, options), supportsStructuredExtraction: true };
  }
  let currentUrl = admitGenericGamingUrl(url, 0, true);
  const seen = new Set([currentUrl]);
  const transitions: GamingDocumentAcquisition["transitions"][number][] = [];
  const session = webFetcher.createProtectedDocumentFetchSession(options);
  const startedAt = Date.now();
  try {
    for (;;) {
      session.assertActive();
      const response = await session.fetch(currentUrl);
      session.assertActive();
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.status < 200 || response.status >= 300) throw new GamingDocumentAcquisitionError(
          response.status === 401 || response.status === 403 ? "SOURCE_INACCESSIBLE" : "SOURCE_FETCH_FAILED",
          "transport", response.status === 304 ? "CONDITIONAL_CONTENT_UNAVAILABLE" : "HTTP_RESPONSE_UNUSABLE", transitions.length, response.status);
        if (response.contentType && !["text/html", "text/plain", "application/xhtml+xml", "application/json"].includes(response.contentType)) {
          throw new GamingDocumentAcquisitionError("SOURCE_FETCH_FAILED", "extraction", "UNSUPPORTED_CONTENT_TYPE", transitions.length);
        }
        let extracted: webFetcher.FetchAndCleanDocument;
        try {
          extracted = webFetcher.extractFetchAndCleanDocument(currentUrl, response.body, response.contentType, maxChars,
            gamingDocumentFetchOptions(currentUrl, options), Date.now() - startedAt);
        } catch {
          session.assertActive();
          throw new GamingDocumentAcquisitionError("SOURCE_FETCH_FAILED", "extraction", "DOCUMENT_EXTRACTION_FAILED", transitions.length);
        }
        session.assertActive();
        return { text: extracted.combined, finalUrl: currentUrl, transitions, supportsStructuredExtraction: true };
      }
      if (transitions.length >= MAX_REDIRECT_TRANSITIONS) throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect",
        "REDIRECT_LIMIT", transitions.length, response.status);
      const location = response.location;
      if (typeof location !== "string" || !location.length || location.length > 2_048
        || location !== location.trim() || /[\u0000-\u0020\u007f-\u009f\\]/u.test(location)
        || (/^https:/iu.test(location) && !/^https:\/\//iu.test(location))) {
        throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "INVALID_LOCATION", transitions.length, response.status);
      }
      let next: URL;
      try { next = new URL(location, currentUrl); } catch {
        throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "INVALID_LOCATION", transitions.length, response.status);
      }
      const nextUrl = admitGenericGamingUrl(next.toString(), transitions.length);
      const transition = redirectTransition(new URL(currentUrl), new URL(nextUrl));
      if (!transition) throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "UNAPPROVED_TRANSITION", transitions.length, response.status);
      if (seen.has(nextUrl)) throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "REDIRECT_LOOP", transitions.length, response.status);
      transitions.push({ fromUrl: currentUrl, toUrl: nextUrl, ...transition });
      seen.add(nextUrl);
      currentUrl = nextUrl;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof webFetcher.ProtectedDocumentFetchError) throw new GamingDocumentAcquisitionError(
      error.code === "NETWORK_DESTINATION_BLOCKED" || error.code === "INVALID_TARGET" ? "URL_BLOCKED"
        : error.code === "REDIRECT_LOCATION_INVALID" ? "REDIRECT_NOT_ALLOWED"
          : error.code === "DEADLINE_EXCEEDED" ? "SOURCE_TIMEOUT" : "SOURCE_FETCH_FAILED",
      "transport", error.code, transitions.length, error.status);
    throw error;
  } finally { session.dispose(); }
}

/** Resolve once before live ranking or durable normalization; retain the pinned fetcher's security controls. */
export async function resolveGamingDocument(
  url: string,
  maxDocumentChars: number = GAMING_DOCUMENT_LIMITS.textChars,
  options: GamingDocumentResolutionOptions = {}
): Promise<ResolvedGamingDocument> {
  const description = describeGamingDocumentSource(url);
  const parsed = new URL(url);
  const documentCeiling = options.documentPurpose === 'durable'
    ? GAMING_DURABLE_DOCUMENT_MAX_CHARS : GAMING_DOCUMENT_LIMITS.textChars;
  const maxChars = Math.min(documentCeiling, Math.max(0,
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
    maxSelectedTextChars: documentCeiling,
    rawDocumentMaxChars: Math.min(options.rawDocumentMaxChars ?? GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars,
      GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars),
    onExtraction: (metrics) => { extraction = metrics; },
    onRawDocument: (document) => { rawDocument = document; }
  });
  for (const resolver of DOCUMENT_RESOLVERS) {
    if (!resolver.canHandle(parsed)) continue;
    const acquired = await resolver.acquire(url, maxChars, fetchOptions);
    if (!acquired) continue;
    const effectiveExtraction: FetchAndCleanExtractionMetrics = extraction ?? {
      strategy: "body", rawTextLength: acquired.text.length, cleanedTextLength: acquired.text.length
    };
    const projection = projectGamingDocumentText({
      acquiredText: acquired.text,
      maxChars,
      selectedTextLength: effectiveExtraction.cleanedTextLength
    });
    const contentType = rawDocument?.contentType;
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
    const canonicalUrl = resolver.publicUrl(url) ?? acquired.finalUrl ?? description.publicUrl;
    const publicUrl = acquired.finalUrl ? projectGamingDocumentPublicUrl(canonicalUrl) : canonicalUrl;
    const acquisition: GamingDocumentAcquisition | undefined = acquired.finalUrl ? {
      policyVersion: GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION, requestedUrl: description.publicUrl,
      finalUrl: canonicalUrl, redirectCount: acquired.transitions?.length ?? 0,
      transitions: acquired.transitions ?? [], contentType: contentType ?? "unknown",
      coverage: { selectedTextChars: effectiveExtraction.cleanedTextLength, returnedTextChars: projection.text.length,
        truncated: projection.truncated, instructionFiltered: projection.instructionFiltered }
    } : undefined;
    const document: ResolvedGamingDocument = {
      requestedUrl: description.publicUrl,
      canonicalUrl,
      publicUrl,
      host: new URL(publicUrl).hostname,
      text: projection.text,
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
        cleanedTextLength: projection.cleanedTextLength,
        truncated: projection.truncated,
        instructionFiltered: projection.instructionFiltered
      },
      ...(acquired.archiveResolution ? { archiveResolution: acquired.archiveResolution } : {}),
      ...(acquisition ? { acquisition } : {})
    };
    if (acquisition) acquisitionAttestations.set(acquisition, documentBinding(document));
    if (Date.now() >= deadlineAt) throw new GamingDocumentAcquisitionError("SOURCE_TIMEOUT", "extraction", "DEADLINE_EXCEEDED", acquisition?.redirectCount);
    options.signal?.throwIfAborted();
    return document;
  }
  throw new Error("Source document could not be resolved");
}
